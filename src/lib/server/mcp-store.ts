import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Account } from '../auth-identity';
import { WorkspaceError } from '../workspace';
import { decryptSecret, encryptSecret } from './credentials';
import { workspaceId, type Database } from './database';

export const hashMcpSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export type McpKeyInfo = { prefix: string; version: string; createdAt: number; recoverable: boolean };
export type McpAttemptStatus = 'running' | 'finished' | 'uncertain';
/** The MCP route's 300 s maxDuration plus a margin. A running attempt older than this was killed and will never finish. */
export const MCP_ATTEMPT_LEASE_MS = 330_000;

export class McpStore {
	constructor(private database: Database, private encryptionSecret = () => process.env.LOOOT_TABLES_MCP_ENCRYPTION_SECRET) {}
	private encryptionKey() {
		const secret = this.encryptionSecret();
		if (!secret || secret.length < 32) throw new WorkspaceError('Configure the shared MCP encryption secret on every server using this database.', 503);
		return createHash('sha256').update(secret).digest();
	}
	async revealKey(actor: Account): Promise<McpKeyInfo & { secret: string }> {
		const workspace = workspaceId(actor);
		const row = (await this.database.read('SELECT * FROM looot_tables.mcp_keys WHERE workspace_id=$1', [workspace])).rows[0];
		if (!row) throw new WorkspaceError('No organization key exists.', 404);
		if (!row.encrypted_secret) throw new WorkspaceError('This legacy key needs a verified backfill before it can be retrieved.', 409);
		const secret = decryptSecret(this.encryptionKey(), String(row.encrypted_secret), [workspace, String(row.version)]);
		if (secret === null || hashMcpSecret(secret) !== row.key_hash) throw new WorkspaceError('The organization key could not be decrypted. Check that all servers use the same MCP encryption secret.', 503);
		return { prefix: String(row.prefix), version: String(row.version), createdAt: Number(row.created_at), recoverable: true, secret };
	}
	// Operator recovery: only the exact currently active secret can fill a legacy record.
	async backfillKey(actor: Account, secret: string) {
		return this.database.transaction(async (sql, workspace) => {
			const { rows } = await sql.query('SELECT key_hash,version,encrypted_secret FROM looot_tables.mcp_keys WHERE workspace_id=$1', [workspace]);
			if (!rows[0] || hashMcpSecret(secret) !== rows[0].key_hash) throw new WorkspaceError('The supplied key is not the active organization key.', 409);
			if (!rows[0].encrypted_secret) await sql.query('UPDATE looot_tables.mcp_keys SET encrypted_secret=$2 WHERE workspace_id=$1', [workspace, encryptSecret(this.encryptionKey(), secret, [workspace, String(rows[0].version)])]);
		}, { workspace: actor });
	}
	async keyInfo(actor: Account): Promise<McpKeyInfo | null> {
		const { rows } = await this.database.read('SELECT prefix, version, created_at, encrypted_secret IS NOT NULL AS recoverable FROM looot_tables.mcp_keys WHERE workspace_id=$1', [workspaceId(actor)]);
		return rows[0] ? { prefix: String(rows[0].prefix), version: String(rows[0].version), createdAt: Number(rows[0].created_at), recoverable: Boolean(rows[0].recoverable) } : null;
	}
	async issueKey(actor: Account, expectedVersion?: string) {
		return this.database.transaction(async (sql, id) => {
			const { rows } = await sql.query('SELECT version FROM looot_tables.mcp_keys WHERE workspace_id=$1', [id]);
			if (expectedVersion === undefined ? rows.length > 0 : rows[0]?.version !== expectedVersion) throw new WorkspaceError('The organization key changed. Refresh before creating or rotating it.', 409);
			const secret = `lt_mcp_${randomBytes(32).toString('base64url')}`;
			const info = { prefix: secret.slice(0, 16), version: randomUUID(), createdAt: Date.now(), recoverable: true };
			await sql.query('INSERT INTO looot_tables.mcp_keys (workspace_id,key_hash,prefix,version,created_at,encrypted_secret) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id) DO UPDATE SET key_hash=excluded.key_hash,prefix=excluded.prefix,version=excluded.version,created_at=excluded.created_at,encrypted_secret=excluded.encrypted_secret', [id, hashMcpSecret(secret), info.prefix, info.version, info.createdAt, encryptSecret(this.encryptionKey(), secret, [id, info.version])]);
			return { ...info, secret };
		}, { workspace: actor });
	}
	async authenticate(header: string | null): Promise<Account> {
		const match = /^Bearer (lt_mcp_[A-Za-z0-9_-]{43})$/i.exec(header ?? '');
		if (!match) throw new WorkspaceError('An organization MCP API key is required.', 401);
		const entry = (await this.database.read('SELECT w.issuer, w.organization_id, w.name FROM looot_tables.mcp_keys k JOIN looot_tables.workspaces w ON w.id=k.workspace_id WHERE k.key_hash=$1', [hashMcpSecret(match[1])])).rows[0];
		if (!entry) throw new WorkspaceError('Invalid organization MCP API key.', 401);
		return { issuer: String(entry.issuer), organization: { id: String(entry.organization_id), name: String(entry.name) }, user: { id: 'mcp', email: 'mcp@example.com', email_verified: true }, partition: 'mcp' };
	}
	async claim(actor: Account, id: string, requestHash: string, now = Date.now()): Promise<{ claimed: boolean; status: McpAttemptStatus | 'busy'; result?: Record<string, unknown> }> {
		return this.database.transaction(async (sql, workspace) => {
			// Never automatically replay an interrupted provider call.
			await sql.query("UPDATE looot_tables.mcp_attempts SET status='uncertain' WHERE workspace_id=$1 AND status='running' AND started_at<$2", [workspace, now - MCP_ATTEMPT_LEASE_MS]);
			const previous = await sql.query('SELECT request_hash,status,result FROM looot_tables.mcp_attempts WHERE workspace_id=$1 AND id=$2', [workspace, id]);
			if (previous.rows[0]) {
				if (previous.rows[0].request_hash !== requestHash) throw new WorkspaceError('This idempotency key was used for different arguments.', 409);
				return { claimed: false, status: previous.rows[0].status as McpAttemptStatus, result: previous.rows[0].result as Record<string, unknown> | undefined };
			}
			const busy = await sql.query("SELECT id FROM looot_tables.mcp_attempts WHERE workspace_id=$1 AND status='running'", [workspace]);
			if (busy.rows.length) return { claimed: false, status: 'busy' };
			await sql.query("INSERT INTO looot_tables.mcp_attempts (workspace_id,id,request_hash,status,started_at) VALUES ($1,$2,$3,'running',$4)", [workspace, id, requestHash, now]);
			return { claimed: true, status: 'running' };
		}, { workspace: actor });
	}
	async finish(actor: Account, id: string, result: Record<string, unknown>) {
		await this.database.transaction(async (sql) => { await sql.query("UPDATE looot_tables.mcp_attempts SET status='finished', result=$3::jsonb WHERE workspace_id=$1 AND id=$2 AND status='running'", [workspaceId(actor), id, JSON.stringify(result)]); });
	}
}
