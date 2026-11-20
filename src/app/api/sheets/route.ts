import { apiRoute, readJson } from '@/lib/server/api-route';
import { WorkspaceStore } from '@/lib/server/workspace-store';

export const GET = apiRoute('sheets.list', ({ account, database }) => new WorkspaceStore(database).list(account));
export const POST = apiRoute('sheets.create', async ({ account, database, request }) => new WorkspaceStore(database).create(account, await readJson(request)));
