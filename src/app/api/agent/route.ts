import { z } from 'zod';
import { validateUIMessages, type UIMessage } from 'ai';
import { agentModel, browserSheetTools, streamAgent } from '@/lib/server/agent';
import { errorResponse, newTrace } from '@/lib/server/api-route';
import { CredentialError, jsonError } from '@/lib/server/credentials';
import { withDatabase } from '@/lib/server/database';
import { routeInput } from '@/lib/server/provider-access';

export const maxDuration = 300;

const AgentRequestSchema = z.object({
	messages: z.array(z.unknown()).min(1).max(200),
	/** The sheet open in the browser, so the agent works in it. */
	sheetId: z.string().min(1).max(128).optional(),
});

/** One agent turn, streamed as AI SDK UI message chunks. The agent's tools are free: paid work comes back as a quote for
    the user to run (see ./run). Keys come from the request headers or the workspace, as for every other route. */
export async function POST(request: Request) {
	const prepared = await routeInput(request, AgentRequestSchema);
	if (prepared instanceof Response) return prepared;
	const { access, input } = prepared;
	let chosen: ReturnType<typeof agentModel>, messages: UIMessage[];
	try {
		chosen = agentModel(access, request.headers.get('x-agent-model'));
		messages = await validateUIMessages({ messages: input.messages });
	} catch (error) {
		if (error instanceof CredentialError) return jsonError(error.message, error.status, error.failure);
		return jsonError('Invalid conversation.', 400);
	}
	return new Promise<Response>((resolve) => {
		withDatabase(async (database) => {
			const tools = browserSheetTools(database, access);
			const sheet = input.sheetId ? await tools.readSnapshot(input.sheetId).then(({ sheet }) => ({ id: sheet.id, name: sheet.name }), () => null) : null;
			const result = await streamAgent({ model: chosen.model, tools, messages, sheet, signal: request.signal });
			resolve(result.toUIMessageStreamResponse({ headers: { 'cache-control': 'no-store', 'x-agent-model': chosen.id }, onError: (error) => access.redact(error) }));
			// The database stays open until the turn's last tool call has finished.
			await Promise.resolve(result.finishReason).catch(() => undefined);
		}).catch((error) => resolve(errorResponse(error, newTrace('agent'))));
	});
}
