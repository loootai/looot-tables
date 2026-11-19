import { loadEnvConfig } from '@next/env';
import { readFile } from 'node:fs/promises';
import { withDatabase } from '../src/lib/server/database';
import { McpStore } from '../src/lib/server/mcp-store';

// Run: node --conditions=react-server --import tsx scripts/backfill-mcp-key.ts /private/path/client-config.json
// The file must be a private MCP client configuration. Never pass a secret as a CLI argument.
async function main() {
	loadEnvConfig(process.cwd());
	const file = process.argv[2];
	if (!file) throw new Error();
	const config = JSON.parse(await readFile(file, 'utf8'));
	const header = config.mcpServers?.enrichable?.headers?.Authorization;
	if (typeof header !== 'string' || !header.startsWith('Bearer ')) throw new Error();
	await withDatabase(async (database) => {
		const keys = new McpStore(database);
		const actor = await keys.authenticate(header);
		const before = await keys.keyInfo(actor);
		await keys.backfillKey(actor, header.slice(7));
		const after = await keys.revealKey(actor);
		if (after.secret !== header.slice(7) || after.version !== before?.version) throw new Error();
	});
	console.log('Active organization key securely backfilled and verified without rotation.');
}
void main().catch(() => { console.error('Key backfill failed. Check the private configuration, shared encryption secret, and database access.'); process.exitCode = 1; });
