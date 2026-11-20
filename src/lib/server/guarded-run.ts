import 'server-only';

import { cellCapUsd } from '../run-cost';
import type { CellValue, ColumnOp, EnrichResponse } from '../types';
import type { Account } from '../auth-identity';
import { withDatabase } from './database';
import { EnrichError } from './enrich-failure';
import { runOp } from './enrich';
import type { ProviderAccess } from './provider-access';
import { SpendGuard, type CellRef, type RunVerdict } from './spend-guard';

const isBlank = (value: CellValue | undefined) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

/** hit, miss or error for the column's streak: an empty answer is a miss, a failure an error. */
export const verdictOf = (response: EnrichResponse): RunVerdict => response.error ? 'error' : isBlank(response.value) ? 'miss' : 'hit';

/** A refusal from the guard, shaped like any other cell failure. */
export const refusal = (error: EnrichError): EnrichResponse => ({ value: null, error: error.message, failure: error.failure });

/** Run one cell with the per-cell cap. With a guard and a cell, the run is admitted against the sheet's cap first, its
    idempotency seed is stored before it is sent, and what it cost is settled after. */
export async function guardedRun(access: ProviderAccess, input: { op: ColumnOp; row: Record<string, CellValue>; attempt?: string; cell?: CellRef }, guard?: SpendGuard): Promise<EnrichResponse> {
	const cap = cellCapUsd(input.op);
	if (!guard || !input.cell || !input.attempt || cap === 0) return runOp(access, input.op, input.row, input.attempt, cap || undefined);
	let seed: string;
	try { ({ seed } = await guard.admit(input.cell, input.attempt, cap)); }
	catch (error) {
		if (error instanceof EnrichError) return refusal(error);
		throw error;
	}
	const response = await runOp(access, input.op, input.row, seed, cap);
	await guard.settle(input.attempt, { chargedUsd: response.meta?.costUsd ?? 0, verdicts: [verdictOf(response)], retry: Boolean(response.failure?.retryable) });
	return response;
}

/** The guard for a signed-in caller with a database; none otherwise (the sheet itself could not be stored either). */
export function withGuard<T>(account: Account | undefined, run: (guard: SpendGuard | undefined) => Promise<T>): Promise<T> {
	if (!account || !process.env.DATABASE_URL) return run(undefined);
	return withDatabase((database) => run(new SpendGuard(database, account)));
}
