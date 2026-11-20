import { z } from 'zod';
import { parseInput } from '@/lib/workspace';
import { apiRoute, readJson } from '@/lib/server/api-route';
import { McpStore } from '@/lib/server/mcp-store';

export const GET = apiRoute('mcp-key.read', async ({ account, database, request }) => {
	const keys = new McpStore(database);
	return { key: new URL(request.url).searchParams.get('reveal') === '1' ? await keys.revealKey(account) : await keys.keyInfo(account) };
});
export const POST = apiRoute('mcp-key.create', async ({ account, database }) => ({ key: await new McpStore(database).issueKey(account) }));
export const PATCH = apiRoute('mcp-key.rotate', async ({ account, database, request }) => {
	const { version } = parseInput(z.object({ version: z.string().uuid() }), await readJson(request));
	return { key: await new McpStore(database).issueKey(account, version) };
});
