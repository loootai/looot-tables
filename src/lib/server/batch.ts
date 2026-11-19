import 'server-only';

import { renderTemplate } from '../template';
import { enrichmentValue } from '../enrichment-value';
import { logoDomain } from '../organization-logo';
import { batchJob, cellCapUsd } from '../run-cost';
import type { CellMeta, CellValue, ColumnOp, EnrichResponse, LoootCallMeta } from '../types';
import { companyAnswer, emailFindAnswer, emailIdentity, emailVerifyAnswer, phoneAnswer, phoneIdentity, verifyAddress, type OpResult } from './enrich';
import { EnrichError } from './enrich-failure';
import { emailFindInput, emailFromResult, phoneFindInput, phoneFromResult, verifyStatusFromResult } from './looot-jobs';
import { runFailure, settledResult, type LoootClient, type LoootResult } from './looot';
import type { BatchAnswer, BatchParams, Run } from './looot-api';

/* A column through looot's rows batch: up to 500 rows in one call, one run per row with fallback. A call answers the rows
   settled by then; sending the same idempotency key again continues the batch, replaying settled rows at no charge.
   Find + verify email runs as two batches, the verify batch only once every find row has settled so its rows (and so its
   key) never change between calls. */

type Row = Record<string, CellValue>;
export interface BatchRowIn { rowId: string; record: Row }
/** A settled row's cell, a row still running at looot, or a row the batch cannot take (a company name, not a domain),
    which the caller runs on its own. */
export type BatchRowOut = { rowId: string; response: EnrichResponse } | { rowId: string; pending: true } | { rowId: string; single: true };
export interface BatchTally { hits: number; weak: number; misses: number; errors: number; pending: number; chargedUsd: number; byProvider: Record<string, number> }
export interface ColumnBatchAnswer { complete: boolean; rows: BatchRowOut[]; tally: BatchTally }

type Prepared = { rowId: string; input: Record<string, unknown> } | { rowId: string; response: EnrichResponse } | { rowId: string; single: true };

const failed = (error: unknown): EnrichResponse => error instanceof EnrichError ? { value: null, error: error.message, failure: error.failure } : { value: null, error: error instanceof Error ? error.message : 'This row could not run.' };

/** Each row's job input, or why it cannot run. */
function prepare(op: ColumnOp, row: BatchRowIn): Prepared {
	try {
		switch (op.kind) {
			case 'email-enrichment': return { rowId: row.rowId, input: emailFindInput(emailIdentity(op, row.record)) };
			case 'email-verify': return { rowId: row.rowId, input: { email: verifyAddress(op, row.record) } };
			case 'phone-find': return { rowId: row.rowId, input: phoneFindInput(phoneIdentity(op, row.record)) };
			case 'company': {
				const typed = renderTemplate(op.domain, row.record).trim();
				if (!typed) return { rowId: row.rowId, response: { value: null, error: 'No company or domain for this row', failure: { reason: 'input_invalid', retryable: false, provider: 'looot' } } };
				const domain = logoDomain(typed);
				return domain ? { rowId: row.rowId, input: { domain } } : { rowId: row.rowId, single: true };
			}
			default: throw new Error(`${op.kind} does not run as a batch.`);
		}
	} catch (error) { return { rowId: row.rowId, response: failed(error) }; }
}

/** The answer row for each sent row, by its index (or position when looot names none). */
function answersByIndex(answer: BatchAnswer, size: number): Array<Run | undefined> {
	const out: Array<Run | undefined> = Array.from({ length: size });
	for (const [position, row] of (answer.rows ?? []).entries()) {
		const index = typeof row?.index === 'number' ? row.index : position;
		if (index >= 0 && index < size) out[index] = row;
	}
	return out;
}

const SETTLED = new Set(['completed', 'failed', 'blocked', 'stopped']);
const settled = (run: Run | undefined): run is Run => Boolean(run && SETTLED.has(String(run.status)));

/** A settled row as a cell, with the run behind it. */
function rowResponse(answer: OpResult, results: LoootResult[]): EnrichResponse {
	const costUsd = Math.round(results.reduce((sum, result) => sum + result.costUsd, 0) * 1e6) / 1e6;
	const looot: LoootCallMeta[] = results.map((result) => result.call);
	const meta: CellMeta = { ...answer.meta, ...(costUsd ? { costUsd } : {}), looot };
	return { value: enrichmentValue(answer.value), meta, ...(answer.error ? { error: answer.error, failure: answer.failure } : {}) };
}

function settledRow(op: ColumnOp, run: Run, endpointId: string, input: Record<string, unknown>): { response: EnrichResponse; result: LoootResult } {
	const result = settledResult(run, endpointId);
	const error = runFailure(run, result.costUsd);
	if (error) return { result, response: { value: null, error: error.message, failure: error.failure, meta: { ...(result.costUsd ? { costUsd: result.costUsd } : {}), looot: [result.call] } } };
	switch (op.kind) {
		case 'email-enrichment': return { result, response: rowResponse(emailFindAnswer(emailFromResult(result)), [result]) };
		case 'email-verify': return { result, response: rowResponse(emailVerifyAnswer(verifyStatusFromResult(result), result), [result]) };
		case 'phone-find': return { result, response: rowResponse(phoneAnswer(phoneFromResult(result), result), [result]) };
		case 'company': return { result, response: rowResponse(companyAnswer(op, result, String(input.domain)), [result]) };
		default: throw new Error(`${op.kind} does not run as a batch.`);
	}
}

/** Run (or continue) one batch of a column's rows. The same `key` with the same rows continues it. */
export async function runColumnBatch(client: LoootClient, op: ColumnOp, rows: BatchRowIn[], key: string, signal?: AbortSignal): Promise<ColumnBatchAnswer> {
	const job = batchJob(op);
	if (!job) throw new Error(`${op.kind} does not run as a batch.`);
	const prepared = rows.map((row) => prepare(op, row));
	const sent = prepared.filter((row): row is Extract<Prepared, { input: unknown }> => 'input' in row);
	const prefer = 'prefer' in op ? op.prefer : undefined;
	const findOp = op.kind === 'email-enrichment' ? { ...op, verify: false } : op;
	const out = new Map<string, BatchRowOut>();
	for (const row of prepared) if (!('input' in row)) out.set(row.rowId, 'single' in row ? { rowId: row.rowId, single: true } : { rowId: row.rowId, response: row.response });

	const send = (endpointId: BatchParams['endpointId'], inputs: Array<Record<string, unknown>>, idempotencyKey: string, cap: number) =>
		client.batch({ endpointId, rows: inputs, idempotencyKey, fallback: { enabled: true, ...(prefer ? { prefer } : {}), ...(cap ? { maxCostUsd: cap } : {}) } }, signal);

	const found = new Map<string, { response: EnrichResponse; result: LoootResult }>();
	if (sent.length) {
		const endpointId = `job:${job}` as BatchParams['endpointId'];
		const answers = answersByIndex(await send(endpointId, sent.map((row) => row.input), key, cellCapUsd(findOp)), sent.length);
		for (const [index, row] of sent.entries()) {
			const run = answers[index];
			if (!settled(run)) { out.set(row.rowId, { rowId: row.rowId, pending: true }); continue; }
			const done = settledRow(op, run, endpointId, row.input);
			found.set(row.rowId, done);
			out.set(row.rowId, { rowId: row.rowId, response: done.response });
		}
	}

	// Find + verify: once every find row settled, check the addresses found, in a batch of their own.
	const findComplete = sent.every((row) => found.has(row.rowId));
	if (op.kind === 'email-enrichment' && op.verify && findComplete) {
		const toVerify = sent.flatMap((row) => { const email = found.get(row.rowId)?.response.error ? null : found.get(row.rowId)?.response.value; return typeof email === 'string' && email ? [{ rowId: row.rowId, email }] : []; });
		if (toVerify.length) {
			const verifyOp: ColumnOp = { kind: 'email-verify', email: '', prefer: op.prefer };
			const answers = answersByIndex(await send('job:people.email.verify', toVerify.map((row) => ({ email: row.email })), `${key}-verify`, cellCapUsd(verifyOp)), toVerify.length);
			for (const [index, row] of toVerify.entries()) {
				const run = answers[index], first = found.get(row.rowId)!;
				if (!settled(run)) { out.set(row.rowId, { rowId: row.rowId, pending: true }); continue; }
				const checked = settledResult(run, 'job:people.email.verify');
				const status = runFailure(run, checked.costUsd) ? undefined : verifyStatusFromResult(checked);
				out.set(row.rowId, { rowId: row.rowId, response: rowResponse(emailFindAnswer(emailFromResult(first.result), status), [first.result, checked]) });
			}
		}
	} else if (op.kind === 'email-enrichment' && op.verify) {
		// The verify batch waits for the find batch; a found address is not shown until it is checked.
		for (const row of sent) if (found.has(row.rowId) && typeof found.get(row.rowId)!.response.value === 'string') out.set(row.rowId, { rowId: row.rowId, pending: true });
	}

	const ordered = rows.map((row) => out.get(row.rowId)!);
	return { complete: ordered.every((row) => !('pending' in row)), rows: ordered, tally: tally(ordered) };
}

/** Hits, weak hits, misses, errors, rows still running, and what the settled rows cost, by the provider that answered. */
export function tally(rows: BatchRowOut[]): BatchTally {
	const out: BatchTally = { hits: 0, weak: 0, misses: 0, errors: 0, pending: 0, chargedUsd: 0, byProvider: {} };
	for (const row of rows) {
		if ('pending' in row) { out.pending++; continue; }
		if (!('response' in row)) continue;
		const { response } = row;
		out.chargedUsd += response.meta?.costUsd ?? 0;
		const calls = response.meta?.looot ?? [];
		const provider = calls.find((call) => call.outcome === 'hit' || call.outcome === 'weak')?.provider;
		if (provider) out.byProvider[provider] = (out.byProvider[provider] ?? 0) + 1;
		if (response.error) out.errors++;
		else if (response.value === null || response.value === '') out.misses++;
		else if (calls.some((call) => call.outcome === 'weak') || ['catch_all', 'risky', 'unknown'].includes(response.meta?.verification ?? '')) out.weak++;
		else out.hits++;
	}
	out.chargedUsd = Math.round(out.chargedUsd * 1e6) / 1e6;
	return out;
}
