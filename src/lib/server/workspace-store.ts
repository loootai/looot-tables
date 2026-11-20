import 'server-only';
import { createHash } from 'node:crypto';
import type { Account } from '../auth-identity';
import type { Cell, Row, Sheet } from '../types';
import { PRESENCE_TTL_MS, type presenceInputSchema } from '../collaboration';
import type { z } from 'zod';
import { createSheetSchema, patchSheetSchema, MAX_ROWS, MAX_SHEETS, parseInput, WorkspaceError } from '../workspace';
import { invalidCell, redefinedColumns } from '../cell-admission';
import { workspaceId, type Database, type Sql } from './database';

type Actor = Pick<Account, 'issuer' | 'user' | 'organization'>;

export function collaboratorIdentity(account: Account) {
	const userId = createHash('sha256').update(JSON.stringify([account.issuer, account.user.id])).digest('hex');
	const colors = ['#1f7a5a', '#9333ea', '#059669', '#dc2626', '#d97706', '#0891b2'];
	return { userId, name: (account.user.name || account.user.email.split('@')[0] || 'Teammate').slice(0, 128), color: colors[parseInt(userId.slice(0, 4), 16) % colors.length] };
}

export class WorkspaceStore {
	constructor(private database: Database) {}
	async presence(actor: Account, input: z.infer<typeof presenceInputSchema>, now = Date.now()) {
		const identity = collaboratorIdentity(actor), workspace = workspaceId(actor);
		return this.database.transaction(async (client) => {
			await client.query('DELETE FROM enrichable.sheet_presence WHERE workspace_id=$1 AND updated_at<$2', [workspace, now - PRESENCE_TTL_MS]);
			const sheet = await client.query('SELECT data FROM enrichable.sheets WHERE workspace_id=$1 AND id=$2', [workspace, input.sheetId]);
			if (!sheet.rows.length) throw new WorkspaceError('Sheet not found in this workspace.', 404);
			const columns = (sheet.rows[0].data as Sheet).columns;
			if (input.columnId && !columns.some((c) => c.id === input.columnId)) throw new WorkspaceError('Column not found.', 404);
			if (input.rowId) {
				const row = await client.query('SELECT id FROM enrichable.sheet_rows WHERE workspace_id=$1 AND sheet_id=$2 AND id=$3', [workspace, input.sheetId, input.rowId]);
				if (!row.rows.length) throw new WorkspaceError('Row not found.', 404);
			}
			const result = await client.query(`INSERT INTO enrichable.sheet_presence (workspace_id,sheet_id,client_id,user_id,name,color,row_id,column_id,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (workspace_id,client_id) DO UPDATE SET sheet_id=excluded.sheet_id,name=excluded.name,color=excluded.color,row_id=excluded.row_id,column_id=excluded.column_id,updated_at=excluded.updated_at WHERE enrichable.sheet_presence.user_id=excluded.user_id RETURNING client_id`, [workspace, input.sheetId, input.clientId, identity.userId, identity.name, identity.color, input.rowId, input.columnId, now]);
			if (!result.rows.length) throw new WorkspaceError('This presence session belongs to another user.', 403);
		});
	}
	async leavePresence(actor: Account, clientId: string) {
		await this.database.transaction(async (client) => { await client.query('DELETE FROM enrichable.sheet_presence WHERE workspace_id=$1 AND client_id=$2 AND user_id=$3', [workspaceId(actor), clientId, collaboratorIdentity(actor).userId]); });
	}
	async list(actor: Actor) {
		const result = await this.database.read('SELECT s.data, s.revision, (SELECT count(*)::int FROM enrichable.sheet_rows r WHERE r.workspace_id=s.workspace_id AND r.sheet_id=s.id) AS row_count FROM enrichable.sheets s WHERE s.workspace_id=$1 ORDER BY s.id', [workspaceId(actor)]);
		return result.rows.map((entry) => ({ sheet: { ...(entry.data as Sheet), revision: Number(entry.revision) }, rowCount: Number(entry.row_count) }));
	}
	async get(actor: Actor, id: string, offset = 0, revision?: number) {
		// A single SQL statement gives the metadata and row page the same MVCC snapshot.
		const result = await this.database.read(`SELECT s.data, s.revision, COALESCE((
			SELECT jsonb_agg(page.data ORDER BY page.position, page.id) FROM (
				SELECT r.data, r.position, r.id FROM enrichable.sheet_rows r
				WHERE r.workspace_id=s.workspace_id AND r.sheet_id=s.id ORDER BY r.position, r.id LIMIT 101 OFFSET $3
			) page
		), '[]'::jsonb) AS sheet_rows FROM enrichable.sheets s WHERE s.workspace_id=$1 AND s.id=$2`, [workspaceId(actor), id, offset]);
		const record = result.rows[0];
		if (!record) throw new WorkspaceError('Sheet not found in this workspace.', 404);
		if (revision !== undefined && Number(record.revision) !== revision) throw new WorkspaceError('Sheet changed. Refresh and try again.', 409);
		const rows = record.sheet_rows as Row[];
		return { sheet: { ...(record.data as Sheet), revision: Number(record.revision) }, rows: rows.slice(0, 100), next: rows.length > 100 ? offset + 100 : null };
	}
	/** The whole sheet as of one moment, for callers that plan against every row. Pages read one by one fail with 409
	    whenever a write lands between them; one statement reads the sheet and all its rows from one MVCC snapshot. */
	async snapshot(actor: Actor, id: string): Promise<{ sheet: Sheet; rows: Row[] }> {
		const [record, ...rows] = (await this.database.read(`SELECT 0 AS part, s.revision, s.data, 0::double precision AS position, s.id FROM enrichable.sheets s WHERE s.workspace_id=$1 AND s.id=$2
			UNION ALL SELECT 1, NULL, r.data, r.position, r.id FROM enrichable.sheet_rows r WHERE r.workspace_id=$1 AND r.sheet_id=$2
			ORDER BY part, position, id`, [workspaceId(actor), id])).rows;
		if (!record || Number(record.part) !== 0) throw new WorkspaceError('Sheet not found in this workspace.', 404);
		return { sheet: { ...(record.data as Sheet), revision: Number(record.revision) }, rows: rows.map((entry) => entry.data as Row) };
	}
	async create(actor: Actor, input: unknown) {
		const { sheet, rows } = parseInput(createSheetSchema, input, 'Invalid sheet data.');
		this.validateRows(sheet, rows);
		return this.database.transaction(async (client, workspace) => {
			const count = await client.query('SELECT count(*)::int AS count FROM enrichable.sheets WHERE workspace_id=$1', [workspace]);
			if (Number(count.rows[0].count) >= MAX_SHEETS) throw new WorkspaceError(`This workspace can have up to ${MAX_SHEETS} sheets. Delete a sheet to create another.`, 422);
			const created = await client.query('INSERT INTO enrichable.sheets (workspace_id, id, data, created_by, updated_by) VALUES ($1,$2,$3::jsonb,$4,$4) ON CONFLICT DO NOTHING RETURNING id', [workspace, sheet.id, JSON.stringify(sheet), actor.user.id]);
			if (!created.rows.length) throw new WorkspaceError('This sheet already exists.', 409);
			await this.putRows(client, workspace, sheet.id, rows);
			return { ...sheet, revision: 1 };
		}, { workspace: actor });
	}
	async patch(actor: Actor, id: string, input: unknown) {
		const patch = parseInput(patchSheetSchema, input, 'Invalid sheet data.');
		if (patch.sheet.id !== id) throw new WorkspaceError('Sheet ID mismatch.');
		this.validateRows(patch.sheet, patch.rows);
		return this.database.transaction(async (client, workspace) => {
			const record = await client.query('SELECT revision, data FROM enrichable.sheets WHERE workspace_id=$1 AND id=$2', [workspace, id]);
			if (!record.rows.length) throw new WorkspaceError('Sheet not found in this workspace.', 404);
			if (Number(record.rows[0].revision) !== patch.revision) throw new WorkspaceError('Another member changed this sheet. Refresh and retry your edit.', 409);
			await this.validateValues(client, workspace, record.rows[0].data as Sheet, patch);
			await client.query('DELETE FROM enrichable.sheet_rows WHERE workspace_id=$1 AND sheet_id=$2 AND id=ANY($3::text[])', [workspace, id, patch.deleted]);
			await this.putRows(client, workspace, id, patch.rows);
			const count = await client.query('SELECT count(*)::int AS count FROM enrichable.sheet_rows WHERE workspace_id=$1 AND sheet_id=$2', [workspace, id]);
			if (Number(count.rows[0].count) > MAX_ROWS) throw new WorkspaceError(`Each sheet can have up to ${MAX_ROWS.toLocaleString()} rows.`, 422);
			const sheet = { ...patch.sheet, updatedAt: Date.now() };
			const result = await client.query('UPDATE enrichable.sheets SET data=$3::jsonb, revision=revision+1, updated_by=$4 WHERE workspace_id=$1 AND id=$2 RETURNING revision', [workspace, id, JSON.stringify(sheet), actor.user.id]);
			return { revision: Number(result.rows[0].revision), updatedAt: sheet.updatedAt };
		}, { workspace: actor });
	}
	/** Compare-and-set one cell in one transaction under the workspace's lock: `change` sees the sheet and its rows (in
	    sheet order) as they are, and returns the cell to store, or undefined to leave it. Every writer to the workspace
	    waits for that lock, so no revision conflict can refuse the write. */
	async changeCell(actor: Actor, id: string, target: { rowId: string; columnId: string }, change: (grid: { sheet: Sheet; rows: Row[] }) => Cell | undefined) {
		return this.database.transaction(async (client, workspace) => {
			const record = await client.query('SELECT revision, data FROM enrichable.sheets WHERE workspace_id=$1 AND id=$2', [workspace, id]);
			if (!record.rows.length) throw new WorkspaceError('Sheet not found in this workspace.', 404);
			const data = record.rows[0].data as Sheet, sheet = { ...data, revision: Number(record.rows[0].revision) };
			const rows = (await client.query('SELECT data FROM enrichable.sheet_rows WHERE workspace_id=$1 AND sheet_id=$2 ORDER BY position, id', [workspace, id])).rows.map((entry) => entry.data as Row);
			const row = rows.find((entry) => entry.id === target.rowId);
			const cell = row && sheet.columns.some((column) => column.id === target.columnId) ? change({ sheet, rows }) : undefined;
			if (!row || !cell) return undefined;
			const written = { ...row, cells: { ...row.cells, [target.columnId]: cell } };
			await this.validateValues(client, workspace, data, { sheet: data, rows: [written], deleted: [] });
			await this.putRows(client, workspace, id, [written]);
			await client.query('UPDATE enrichable.sheets SET data=$3::jsonb, revision=revision+1, updated_by=$4 WHERE workspace_id=$1 AND id=$2', [workspace, id, JSON.stringify({ ...data, updatedAt: Date.now() }), actor.user.id]);
			return cell;
		}, { workspace: actor });
	}
	async remove(actor: Actor, id: string, revision: number) {
		return this.database.transaction(async (client, workspace) => {
			const result = await client.query('DELETE FROM enrichable.sheets WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING id', [workspace, id, revision]);
			if (!result.rows.length) throw new WorkspaceError('Sheet changed or was deleted. Refresh before deleting.', 409);
		}, { workspace: actor });
	}
	private validateRows(sheet: Sheet, rows: Row[]) {
		if (new Set(sheet.columns.map((column) => column.id)).size !== sheet.columns.length || new Set(rows.map((row) => row.id)).size !== rows.length) throw new WorkspaceError('Duplicate row or column IDs.');
		const columns = new Set(sheet.columns.map((column) => column.id));
		if (rows.some((row) => row.sheetId !== sheet.id || Object.keys(row.cells).some((id) => !columns.has(id)))) throw new WorkspaceError('Rows must belong to the sheet and its columns.');
	}
	/** Typed columns keep their format whoever writes (an MCP agent, a stale tab): each written cell that changed, and
	    every cell of a column whose format changed, must fit it. Unchanged values are not rechecked, so a value stored
	    before this check existed never blocks an unrelated edit. */
	private async validateValues(client: Sql, workspace: string, stored: Sheet, patch: { sheet: Pick<Sheet, 'columns'>; rows: Row[]; deleted: string[] }) {
		const { columns } = patch.sheet;
		const redefined = redefinedColumns(stored.columns, columns).size > 0;
		if (!redefined && !patch.rows.length) return;
		const existing = redefined
			? await client.query('SELECT data FROM enrichable.sheet_rows WHERE workspace_id=$1 AND sheet_id=$2', [workspace, stored.id])
			: await client.query('SELECT data FROM enrichable.sheet_rows WHERE workspace_id=$1 AND sheet_id=$2 AND id=ANY($3::text[])', [workspace, stored.id, patch.rows.map((row) => row.id)]);
		const before = existing.rows.map((entry) => entry.data as Row);
		const written = new Set(patch.rows.map((row) => row.id)), deleted = new Set(patch.deleted);
		const rows = redefined ? [...before.filter((row) => !written.has(row.id) && !deleted.has(row.id)), ...patch.rows] : patch.rows;
		const problem = invalidCell({ columns: stored.columns, rows: before }, { columns, rows });
		if (problem) throw new WorkspaceError(problem, 422);
	}
	private async putRows(client: Sql, workspace: string, sheetId: string, rows: Row[]) {
		if (!rows.length) return;
		const result = await client.query(`INSERT INTO enrichable.sheet_rows (workspace_id, sheet_id, id, position, data)
			SELECT $1, $2, value->>'id', (value->>'order')::double precision, value FROM jsonb_array_elements($3::jsonb)
			ON CONFLICT (workspace_id, id) DO UPDATE SET position=excluded.position, data=excluded.data
			WHERE enrichable.sheet_rows.sheet_id=excluded.sheet_id RETURNING id`, [workspace, sheetId, JSON.stringify(rows)]);
		if (result.rows.length !== rows.length) throw new WorkspaceError('A row ID is already used by another sheet.', 409);
	}
}
