import { z } from 'zod';
import { ColumnOpSchema } from '@/lib/types';
import { NO_STORE_HEADERS, jsonError } from '@/lib/server/credentials';
import { failure } from '@/lib/server/enrich-failure';
import { routeInput } from '@/lib/server/provider-access';
import { quoteRun } from '@/lib/server/quote';
import { withGuard } from '@/lib/server/guarded-run';

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);
const QuoteRequestSchema = z.object({
	op: ColumnOpSchema,
	cells: z.number().int().min(0).max(100_000),
	/** The rows' inputs, for looot's batch quote. Without them the quote is the catalog estimate. */
	records: z.array(z.record(z.string(), cellValue)).max(500).default([]),
	sheetId: z.string().min(1).max(128).optional(),
});

/** Free. The most a run can cost before it starts, and what the sheet's cap leaves. Never runs anything. */
export async function POST(request: Request) {
	const prepared = await routeInput(request, QuoteRequestSchema);
	if (prepared instanceof Response) return prepared;
	const { access, input } = prepared;
	try {
		const quote = await quoteRun(access.key('looot') ? access.looot() : null, input.op, input.cells, input.records);
		const sheet = input.sheetId ? await withGuard(access.account, async (guard) => guard ? await guard.state(input.sheetId!) : undefined) : undefined;
		return new Response(JSON.stringify({ ...quote, ...(sheet ? { sheet } : {}) }), { status: 200, headers: NO_STORE_HEADERS });
	} catch (error) {
		return jsonError(access.redact(error), 502, failure('provider_error', 'looot', true));
	}
}
