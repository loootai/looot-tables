import { z } from 'zod';
import { presenceInputSchema } from '@/lib/collaboration';
import { parseInput } from '@/lib/workspace';
import { apiRoute, readJson } from '@/lib/server/api-route';
import { realtimeConfig } from '@/lib/server/realtime';
import { WorkspaceStore } from '@/lib/server/workspace-store';

export const POST = apiRoute('realtime.presence', async ({ account, database, request }) => {
	if (!realtimeConfig()) return { enabled: false };
	await new WorkspaceStore(database).presence(account, parseInput(presenceInputSchema, await readJson(request)));
});
export const DELETE = apiRoute('realtime.leave', async ({ account, database, request }) => {
	const { clientId } = parseInput(z.object({ clientId: z.string().uuid() }), await readJson(request));
	await new WorkspaceStore(database).leavePresence(account, clientId);
});
