import { z } from 'zod';
import { parseInput } from '@/lib/workspace';
import { apiRoute, readJson } from '@/lib/server/api-route';
import { WorkspaceStore } from '@/lib/server/workspace-store';

const pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(1000).default(0), revision: z.coerce.number().int().positive().optional() });
const revisionSchema = z.coerce.number().int().positive();
const query = (request: Request) => new URL(request.url).searchParams;

export const GET = apiRoute<{ id: string }>('sheets.get', async ({ account, database, request, params }) => {
	const page = parseInput(pageSchema, Object.fromEntries(query(request)));
	return new WorkspaceStore(database).get(account, params.id, page.offset, page.revision);
});
export const PATCH = apiRoute<{ id: string }>('sheets.patch', async ({ account, database, request, params }) => new WorkspaceStore(database).patch(account, params.id, await readJson(request)));
export const DELETE = apiRoute<{ id: string }>('sheets.delete', ({ account, database, request, params }) => new WorkspaceStore(database).remove(account, params.id, parseInput(revisionSchema, query(request).get('revision'))));
