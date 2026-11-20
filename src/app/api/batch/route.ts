import { z } from 'zod';
import { ColumnOpSchema } from '@/lib/types';
import { BATCH_MAX_ROWS, batchJob, cellCapUsd } from '@/lib/run-cost';
import { NO_STORE_HEADERS, jsonError } from '@/lib/server/credentials';
import { classifyFailure, EnrichError, failure } from '@/lib/server/enrich-failure';
import { routeInput } from '@/lib/server/provider-access';
import { runColumnBatch } from '@/lib/server/batch';
import { refusal, withGuard } from '@/lib/server/guarded-run';

export const maxDuration = 120;

const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);
const BatchRequestSchema = z.object({
	op: ColumnOpSchema,
	rows: z.array(z.object({ rowId: z.string().min(1).max(128), record: z.record(z.string(), cellValue) })).min(1).max(BATCH_MAX_ROWS),
	/** Stored before the first call; the same key with the same rows continues the batch. */
	key: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
	cell: z.object({ sheetId: z.string().min(1).max(128), columnId: z.string().min(1).max(128) }).optional(),
});

/** Run or continue one rows batch of a column. The sheet's cap holds the most every row can cost before anything runs. */
export async function POST(request: Request) {
	const prepared = await routeInput(request, BatchRequestSchema);
	if (prepared instanceof Response) return prepared;
	const { access, input } = prepared;
	if (!batchJob(input.op)) return jsonError(`${input.op.kind} columns do not run as a batch.`, 400, failure('input_invalid'));
	try {
		const answer = await withGuard(access.account, async (guard) => {
			let seed = input.key;
			if (guard && input.cell) {
				try { ({ seed } = await guard.admit({ ...input.cell, rowId: '*batch' }, input.key, input.rows.length * cellCapUsd(input.op))); }
				catch (error) { if (error instanceof EnrichError) return { refused: refusal(error) }; throw error; }
			}
			const batch = await runColumnBatch(access.looot(), input.op, input.rows, `lt-${seed}`, request.signal);
			if (guard && input.cell) {
				const verdicts = batch.complete ? batch.rows.flatMap((row) => 'response' in row ? [row.response.error ? 'error' as const : row.response.value === null || row.response.value === '' ? 'miss' as const : 'hit' as const] : []) : [];
				const { halted } = await guard.settle(input.key, { chargedUsd: batch.tally.chargedUsd, verdicts, final: batch.complete });
				return { ...batch, halted };
			}
			return batch;
		});
		return new Response(JSON.stringify(answer), { status: 200, headers: NO_STORE_HEADERS });
	} catch (error) {
		const outcome = classifyFailure(error, 'looot');
		return jsonError(access.redact(error), outcome?.reason === 'credential_invalid' ? 401 : outcome?.reason === 'credits_exhausted' ? 402 : 502, outcome);
	}
}
