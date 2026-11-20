import type { EnrichResponse } from './types';

/* What the browser and the server say to each other about a rows batch (see src/lib/server/batch.ts). */

export type BatchRowOut = { rowId: string; response: EnrichResponse } | { rowId: string; pending: true } | { rowId: string; single: true };
export interface BatchTally { hits: number; weak: number; misses: number; errors: number; pending: number; chargedUsd: number; byProvider: Record<string, number> }
export interface BatchResponse {
	complete: boolean;
	rows: BatchRowOut[];
	tally: BatchTally;
	/** The column reached its miss limit with this batch. */
	halted?: boolean;
	/** The guard refused the batch before anything ran (spend cap, halted column). */
	refused?: EnrichResponse;
}

/** A column's live batch progress: what the toolbar meter and the column footer count. */
export interface ColumnTally { total: number; settled: number; hits: number; weak: number; misses: number; errors: number; chargedUsd: number }

/** A stable key for one chunk of a batch: the same rows with the same inputs and rule continue the same looot batch, so a
    reload or a second Run replays settled rows at no charge instead of paying again. `nonce` starts a fresh one. */
export async function batchKey(parts: unknown[], nonce = ''): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify([...parts, nonce]));
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return `b${[...digest.slice(0, 20)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
