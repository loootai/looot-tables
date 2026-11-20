import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SpendGuard } from '../../src/lib/server/spend-guard';
import { guardedRun } from '../../src/lib/server/guarded-run';
import { runColumnBatch } from '../../src/lib/server/batch';
import { quoteRun } from '../../src/lib/server/quote';
import { LoootClient } from '../../src/lib/server/looot';
import { Spend } from '../../src/lib/server/enrich-failure';
import { cellCapUsd, HALT_AFTER_MISSES } from '../../src/lib/run-cost';
import type { ColumnOp } from '../../src/lib/types';
import { testDatabase } from '../support/database';
import { testAccess } from './access-fixture';
import { fakeLooot, hit, routed } from './looot-fixture';

const actor = { issuer: 'https://issuer.example.com', organization: { id: 'org-1', name: 'Example' } };
const access = testAccess({ keys: { looot: 'test-looot-token' } });
const emailOp: ColumnOp = { kind: 'email-enrichment', name: '{{Name}}', company: '', domain: '{{Website}}', profileUrl: '', prefer: 'balanced' };
const row = { Name: 'Ada Lovelace', Website: 'example.com' };
const cell = (rowId: string) => ({ sheetId: 'sheet-1', rowId, columnId: 'col-email' });

async function guardFor(t: TestContext) {
	const { database } = await testDatabase(t);
	return new SpendGuard(database, actor);
}

test('every looot job is sent with the per-cell cap as fallback.maxCostUsd, and the sheet cap refuses a cell before anything is sent', async (t) => {
	const guard = await guardFor(t);
	const { runs } = fakeLooot(t, { 'job:people.email.find': () => hit({ data: { email: 'ada@example.com' } }, { normalized: { fields: { email: 'ada@example.com' } }, actualCost: 0.03 }) });
	const first = await guardedRun(access, { op: emailOp, row, attempt: 'cell-run-0001', cell: cell('r1') }, guard);
	assert.equal(first.value, 'ada@example.com');
	assert.deepEqual(runs[0].fallback, { enabled: true, prefer: 'balanced', maxCostUsd: cellCapUsd(emailOp) });
	assert.equal((await guard.state('sheet-1')).spentUsd, 0.03, 'what looot charged is the sheet spend');

	// Lower the cap below what one more cell may cost: the next cell is refused and looot never sees it.
	await guard.setCap('sheet-1', 0.05);
	const refused = await guardedRun(access, { op: emailOp, row, attempt: 'cell-run-0002', cell: cell('r2') }, guard);
	assert.equal(refused.failure?.reason, 'spend_capped');
	assert.match(refused.error ?? '', /spend cap is \$0\.05/);
	assert.equal(runs.length, 1, 'a refused cell sends nothing');
	assert.equal((await guard.state('sheet-1')).heldUsd, 0, 'a refusal holds nothing');
});

test('a cell stops spending once its own cap is used up, even across several looot runs', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => hit({ data: {} }, { actualCost: 0.02 }) });
	const client = new LoootClient({ token: 'test', spend: new Spend(), attempt: 'cap-test-0001', capUsd: 0.03 });
	await client.job('web.search', { query: 'one' });
	assert.equal((runs[0].fallback as { maxCostUsd: number }).maxCostUsd, 0.03);
	await client.job('web.search', { query: 'two' });
	assert.equal((runs[1].fallback as { maxCostUsd: number }).maxCostUsd, 0.01, 'the second run may only spend what is left');
	await assert.rejects(client.job('web.search', { query: 'three' }), (error: { failure?: { reason: string } }) => error.failure?.reason === 'spend_capped');
	assert.equal(runs.length, 2);
});

test('the quote asks looot for the batch maximum (free) and never exceeds the per-cell cap times the cells', async (t) => {
	const sent: unknown[] = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? '{}'));
		sent.push(body);
		return Response.json({ quoteOnly: true, quote: { maxCostUsd: 99 } }, { status: 200 });
	});
	const client = new LoootClient({ token: 'test', spend: new Spend() });
	const records = [{ Name: 'Ada Lovelace', Website: 'example.com' }, { Name: 'Grace Hopper', Website: 'example.org' }];
	const quote = await quoteRun(client, emailOp, 2, records);
	assert.equal((sent[0] as { quoteOnly: boolean }).quoteOnly, true);
	assert.equal((sent[0] as { rows: unknown[] }).rows.length, 2);
	assert.equal(quote.source, 'looot');
	assert.equal(quote.maxUsd, cellCapUsd(emailOp) * 2, 'a looot quote above the per-cell cap is clipped to it');
	const estimate = await quoteRun(null, emailOp, 40, []);
	assert.equal(estimate.source, 'estimate');
	assert.equal(estimate.maxUsd, Math.round(cellCapUsd(emailOp) * 40 * 1e6) / 1e6);
});

test(`a column halts after ${HALT_AFTER_MISSES} misses or errors in a row; the next cell is refused until it is resumed`, async (t) => {
	const guard = await guardFor(t);
	await guard.setCap('sheet-1', 100);
	const { runs } = fakeLooot(t, { 'job:people.email.find': () => ({ outcome: 'miss', result: { data: null }, actualCost: 0 }) });
	for (let n = 0; n < HALT_AFTER_MISSES; n++) {
		const result = await guardedRun(access, { op: emailOp, row, attempt: `miss-run-${String(n).padStart(4, '0')}`, cell: cell(`r${n}`) }, guard);
		assert.equal(result.value, null);
		assert.equal(result.error, undefined, 'a miss is an answer');
	}
	assert.deepEqual((await guard.state('sheet-1')).haltedColumns, ['col-email']);
	const halted = await guardedRun(access, { op: emailOp, row, attempt: 'miss-run-next', cell: cell('r99') }, guard);
	assert.equal(halted.failure?.reason, 'column_halted');
	assert.equal(runs.length, HALT_AFTER_MISSES, 'the halted column sent nothing more');
	await guard.resumeColumn('sheet-1', 'col-email');
	await guardedRun(access, { op: emailOp, row, attempt: 'miss-run-resumed', cell: cell('r99') }, guard);
	assert.equal(runs.length, HALT_AFTER_MISSES + 1);
});

test('a hit resets the miss streak', async (t) => {
	const guard = await guardFor(t);
	await guard.setCap('sheet-1', 100);
	for (let n = 0; n < HALT_AFTER_MISSES - 1; n++) await guard.admit(cell(`r${n}`), `streak-${n}-0000`, 0.01).then(() => guard.settle(`streak-${n}-0000`, { chargedUsd: 0, verdicts: ['miss'] }));
	await guard.admit(cell('hit'), 'streak-hit-0000', 0.01).then(() => guard.settle('streak-hit-0000', { chargedUsd: 0.01, verdicts: ['hit'] }));
	for (let n = 0; n < HALT_AFTER_MISSES - 1; n++) await guard.admit(cell(`s${n}`), `streak-s${n}-000`, 0.01).then(() => guard.settle(`streak-s${n}-000`, { chargedUsd: 0, verdicts: ['error'] }));
	assert.deepEqual((await guard.state('sheet-1')).haltedColumns, []);
});

test('a retry of the same cell run reuses its idempotency key, so looot replays instead of charging twice', async (t) => {
	const guard = await guardFor(t);
	let answer: 'timeout' | 'hit' = 'timeout';
	const { runs } = fakeLooot(t, { 'job:people.email.find': () => answer === 'timeout' ? { http: { status: 504, body: { error: { code: 'gateway_timeout', message: 'slow' } } } } : hit({ data: { email: 'ada@example.com' } }, { actualCost: 0.03 }) });
	const first = await guardedRun(access, { op: emailOp, row, attempt: 'retry-run-0001', cell: cell('r1') }, guard);
	assert.ok(first.error, 'the first attempt never learned its outcome');
	answer = 'hit';
	const second = await guardedRun(access, { op: emailOp, row, attempt: 'retry-run-0001', cell: cell('r1') }, guard);
	assert.equal(second.value, 'ada@example.com');
	assert.equal(runs[0].idempotencyKey, runs[1].idempotencyKey, 'the stored key was sent again');
	assert.equal((await guard.state('sheet-1')).spentUsd, 0.03);

	// A failure looot settled unbilled and retryable would replay as the same failure: that retry gets fresh keys.
	await guard.admit(cell('r2'), 'retry-run-0002', 0.01);
	await guard.settle('retry-run-0002', { chargedUsd: 0, verdicts: ['error'], retry: true });
	const again = await guard.admit(cell('r2'), 'retry-run-0002', 0.01);
	assert.equal(again.seed, 'retry-run-0002.1');
	assert.equal(again.replay, false);
});

/** looot's rows batch: the first call settles the first `firstCall` rows, a resend of the same key settles the rest. */
function fakeBatch(t: TestContext, firstCall: number) {
	const calls: Array<{ key: string; rows: number; endpointId: string }> = [];
	const seen = new Map<string, number>();
	t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? '{}')) as { idempotencyKey: string; rows: Array<Record<string, string>>; endpointId: string };
		calls.push({ key: body.idempotencyKey, rows: body.rows.length, endpointId: body.endpointId });
		const call = (seen.get(body.idempotencyKey) ?? 0) + 1;
		seen.set(body.idempotencyKey, call);
		const limit = call === 1 ? firstCall : body.rows.length;
		const rows = body.rows.map((input, index) => index >= limit
			? { index, status: 'running', outcome: 'pending' }
			: body.endpointId === 'job:people.email.verify'
				? { index, runId: `v${index}`, status: 'completed', outcome: 'hit', result: { status: 'valid' }, normalized: { fields: { status: 'valid' } }, actualCost: 0.002, replayed: call > 1 }
				: index % 3 === 2
					? { index, runId: `f${index}`, status: 'completed', outcome: 'miss', result: { data: null }, actualCost: 0, replayed: call > 1 }
					: { index, runId: `f${index}`, status: 'completed', outcome: 'hit', result: { data: { email: `${input.first_name.toLowerCase()}@${input.domain}` } }, normalized: { fields: { email: `${input.first_name.toLowerCase()}@${input.domain}` } }, actualCost: 0.01, route: routed([{ provider: 'prospeo', outcome: 'hit', chargedUsd: 0.01 }]), replayed: call > 1 });
		return Response.json({ batch: { complete: limit >= body.rows.length }, rows, summary: {} }, { status: 201 });
	});
	return calls;
}

test('a batch that is not complete continues with the same key; settled rows replay and the tally covers every row', async (t) => {
	const calls = fakeBatch(t, 4);
	const client = new LoootClient({ token: 'test', spend: new Spend() });
	const rows = Array.from({ length: 6 }, (_, i) => ({ rowId: `r${i}`, record: { Name: `Person${i} Example`, Website: 'example.com' } }));
	const first = await runColumnBatch(client, emailOp, rows, 'lt-batch-key-1');
	assert.equal(first.complete, false);
	assert.equal(first.tally.pending, 2);
	assert.equal(first.rows.filter((entry) => 'response' in entry).length, 4);
	const second = await runColumnBatch(client, emailOp, rows, 'lt-batch-key-1');
	assert.equal(second.complete, true);
	assert.deepEqual(calls.map((call) => call.key), ['lt-batch-key-1', 'lt-batch-key-1'], 'the continuation resent the same key');
	assert.deepEqual({ hits: second.tally.hits, misses: second.tally.misses, pending: second.tally.pending }, { hits: 4, misses: 2, pending: 0 });
	assert.equal(second.tally.chargedUsd, 0.04);
	const settled = second.rows[0];
	assert.ok('response' in settled && settled.response.value === 'person0@example.com');
});

test('find + verify in one column: the verify batch waits for every find row, then checks only the addresses found', async (t) => {
	const calls = fakeBatch(t, 2);
	const client = new LoootClient({ token: 'test', spend: new Spend() });
	const rows = Array.from({ length: 3 }, (_, i) => ({ rowId: `r${i}`, record: { Name: `Person${i} Example`, Website: 'example.com' } }));
	const op: ColumnOp = { ...emailOp, verify: true } as ColumnOp;
	const first = await runColumnBatch(client, op, rows, 'lt-verify-key-1');
	assert.equal(first.complete, false);
	assert.ok(first.rows.every((entry) => !('response' in entry) || entry.response.value === null), 'no address is shown before it is checked');
	assert.equal(calls.filter((call) => call.endpointId === 'job:people.email.verify').length, 0);
	const second = await runColumnBatch(client, op, rows, 'lt-verify-key-1');
	const verifyCalls = calls.filter((call) => call.endpointId === 'job:people.email.verify');
	assert.equal(verifyCalls.length, 1);
	assert.equal(verifyCalls[0].rows, 2, 'the miss is never verified');
	if (!second.complete) await runColumnBatch(client, op, rows, 'lt-verify-key-1');
	const final = await runColumnBatch(client, op, rows, 'lt-verify-key-1');
	assert.equal(final.complete, true);
	const checked = final.rows[0];
	assert.ok('response' in checked);
	assert.equal(checked.response.meta?.verification, 'valid');
	assert.equal(checked.response.meta?.costUsd, 0.012, 'the cell shows find and verify together');
});

test('a batch admitted against the sheet cap keeps its hold until it completes, and settles what looot charged once', async (t) => {
	const guard = await guardFor(t);
	const batchCell = { sheetId: 'sheet-1', rowId: '*batch', columnId: 'col-email' };
	const { seed } = await guard.admit(batchCell, 'batch-key-0001', 0.6);
	assert.equal((await guard.state('sheet-1')).heldUsd, 0.6);
	await guard.settle('batch-key-0001', { chargedUsd: 0.02, verdicts: [], final: false });
	assert.deepEqual(await guard.admit(batchCell, 'batch-key-0001', 0.6), { seed, replay: true }, 'the continuation keeps the same key and hold');
	await guard.settle('batch-key-0001', { chargedUsd: 0.04, verdicts: ['hit', 'miss'] });
	const state = await guard.state('sheet-1');
	assert.equal(state.spentUsd, 0.04);
	assert.equal(state.heldUsd, 0);
});
