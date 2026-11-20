import { z } from 'zod';
import { browserSheetTools } from '@/lib/server/agent';
import { failureOf, newTrace } from '@/lib/server/api-route';
import { withDatabase } from '@/lib/server/database';
import { routeInput } from '@/lib/server/provider-access';

export const maxDuration = 300;

const quoteRun = { quoteId: z.string().min(3).max(64), maxUsd: z.number().min(0).max(1000), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/) };
const RunRequestSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('column'), ...quoteRun, rows: z.number().int().min(1).max(1000).optional() }),
	z.object({ kind: z.literal('find'), ...quoteRun }),
]);

/** The user's click on a quote card: runs the quote with the budget shown on the card, through the same tools and money
    guards as MCP's run_column and find_rows. Streams one JSON line per settled cell, then the result. */
export async function POST(request: Request) {
	const prepared = await routeInput(request, RunRequestSchema);
	if (prepared instanceof Response) return prepared;
	const { access, input } = prepared;
	const encoder = new TextEncoder();
	const trace = newTrace('agent.run');
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const emit = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			withDatabase(async (database) => {
				const tools = browserSheetTools(database, access);
				tools.onRunProgress = (progress) => emit({ type: 'progress', ...progress });
				const { kind, ...args } = input;
				emit({ type: 'done', result: await tools.call(kind === 'find' ? 'find_rows' : 'run_column', args) });
			}).catch((error) => emit({ type: 'error', ...failureOf(error, trace) })).finally(() => controller.close());
		},
	});
	return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
