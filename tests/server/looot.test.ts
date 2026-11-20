import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure, EnrichError, Spend } from '../../src/lib/server/enrich-failure';
import { callMeta, LoootClient, runCost, runFailure } from '../../src/lib/server/looot';
import { verifyLoootToken } from '../../src/lib/server/looot-verify';
import { fakeLooot, hit, routed } from './looot-fixture';

const client = (spend = new Spend(), attempt = 'attempt-one') => new LoootClient({ token: 'test-looot-token', spend, attempt });

test('a job run sends the job id with fallback on, the preferred order, and a fresh idempotency key per call', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => hit({ ok: true }, { actualCost: 0.02 }) });
	const spend = new Spend();
	const looot = client(spend);
	const first = await looot.job('people.email.find', { name: 'Ada Lovelace' }, { prefer: 'cheapest', maxCostUsd: 0.1 });
	await looot.job('people.email.find', { name: 'Grace Hopper' });
	assert.equal(runs[0].endpointId, 'job:people.email.find');
	assert.deepEqual(runs[0].fallback, { enabled: true, prefer: 'cheapest', maxCostUsd: 0.1 });
	assert.equal(runs[0].wait, '45');
	assert.equal(runs[0].idempotencyKey, 'lt-attempt-one-1');
	assert.equal(runs[1].idempotencyKey, 'lt-attempt-one-2', 'each call of one attempt has its own key');
	assert.equal(first.costUsd, 0.02);
	assert.equal(spend.costUsd, 0.04);
	assert.equal(spend.paid, true);
});

test('the same cell attempt derives the same keys, and another attempt gets other keys', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => hit({}) });
	await client(new Spend(), 'cell-7-0').job('web.search', { query: 'a' });
	await client(new Spend(), 'cell-7-0').job('web.search', { query: 'a' });
	await client(new Spend(), 'cell-7-1').job('web.search', { query: 'a' });
	assert.equal(runs[0].idempotencyKey, runs[1].idempotencyKey);
	assert.notEqual(runs[0].idempotencyKey, runs[2].idempotencyKey);
	const random = await new LoootClient({ token: 'test-looot-token', spend: new Spend() }).job('web.search', { query: 'a' });
	assert.match(runs[3].idempotencyKey, /^lt-[0-9a-f-]{36}-1$/);
	assert.ok(random.run.runId);
});

test('a named endpoint runs without fallback unless asked', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => hit({}) });
	await client().endpoint('hunter-email-finder', { domain: 'example.com' });
	assert.equal('fallback' in runs[0] && runs[0].fallback, undefined);
	assert.equal(runs[0].endpointId, 'hunter-email-finder');
});

test('a miss is an answer: no error, no charge needed, and the run is kept for the cell panel', async (t) => {
	fakeLooot(t, { '*': () => ({ outcome: 'miss', outcomeReason: 'no email found', result: { data: null }, actualCost: 0 }) });
	const looot = client();
	const result = await looot.job('people.email.find', { name: 'Nobody' });
	assert.equal(result.outcome, 'miss');
	assert.equal(looot.calls.length, 1);
	assert.equal(looot.calls[0].outcome, 'miss');
});

test('the cell keeps which provider answered, the price, and every fallback attempt', async (t) => {
	fakeLooot(t, { '*': () => hit({ email: 'ada@example.com' }, {
		actualCost: 0.031,
		route: routed([{ provider: 'hunter', outcome: 'miss', chargedUsd: 0.012 }, { provider: 'prospeo', outcome: 'hit', chargedUsd: 0.019 }]),
	}) });
	const looot = client();
	const result = await looot.job('people.email.find', { name: 'Ada Lovelace' });
	assert.equal(result.call.provider, 'prospeo');
	assert.equal(result.call.job, 'people.email.find');
	assert.equal(result.call.costUsd, 0.031);
	assert.deepEqual(result.call.attempts?.map((attempt) => [attempt.provider, attempt.outcome, attempt.costUsd]), [['hunter', 'miss', 0.012], ['prospeo', 'hit', 0.019]]);
});

test('a failed run reads the error from the run body, never the HTTP code', async (t) => {
	fakeLooot(t, { 'job:a': () => ({ status: 'failed', outcome: 'error', error: { code: 'provider_error', message: 'upstream exploded', whoseError: 'provider', retryable: true }, actualCost: 0 }),
		'job:b': () => ({ status: 'failed', outcome: 'rejected', error: { code: 'validation_error', message: 'domain is required', whoseError: 'customer' } }),
		'job:c': () => ({ status: 'blocked', outcome: 'error', error: { code: 'insufficient_balance', message: 'out of credit' } }) });
	const spend = new Spend();
	const looot = client(spend);
	const provider = await looot.job('a', {}).catch((error: unknown) => error);
	assert.ok(provider instanceof EnrichError);
	assert.deepEqual(provider.failure, { reason: 'provider_error', retryable: true, provider: 'looot' }, 'an uncharged provider error may be retried');
	const input = await looot.job('b', {}).catch((error: unknown) => error);
	assert.deepEqual((input as EnrichError).failure, { reason: 'input_invalid', retryable: false, provider: 'looot' });
	assert.equal((input as EnrichError).message, 'domain is required');
	const blocked = await looot.job('c', {}).catch((error: unknown) => error);
	assert.equal((blocked as EnrichError).failure.reason, 'credits_exhausted');
	assert.match((blocked as EnrichError).message, /balance is too low/);
	assert.equal(spend.paid, false, 'nothing was charged');
	assert.equal(looot.calls.length, 3, 'failed runs are still recorded');
});

test('a failure after money was charged is never retryable', () => {
	const failed = runFailure({ runId: 'r', status: 'failed', outcome: 'error', actualCost: 0.01, error: { code: 'provider_error', message: 'late failure', retryable: true } }, 0.01);
	assert.equal(failed?.failure.retryable, false);
	assert.equal(runFailure({ runId: 'r', status: 'completed', outcome: 'miss' }), null);
});

test('HTTP refusals map to the failure the runner halts or retries on', async (t) => {
	let answer: { status: number; body: unknown } = { status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } };
	fakeLooot(t, { '*': () => ({ http: answer }) });
	const spend = new Spend();
	const looot = client(spend);
	const run = async () => classifyFailure(await looot.job('web.search', { query: 'x' }).catch((error: unknown) => error), 'looot');
	assert.deepEqual(await run(), { reason: 'credential_invalid', retryable: false, provider: 'looot' });
	answer = { status: 402, body: { error: { code: 'insufficient_balance', message: 'low' }, topUpUrl: 'https://looot.ai/usage' } };
	assert.deepEqual(await run(), { reason: 'credits_exhausted', retryable: false, provider: 'looot' });
	answer = { status: 400, body: { error: { code: 'validation_error', message: 'bad input' } } };
	assert.equal((await run())?.reason, 'input_invalid');
	assert.equal(spend.paid, false, 'a refusal before dispatch never charges');
});

test('a run still pending after the wait is polled until it settles', async (t) => {
	const { polled } = fakeLooot(t, { '*': () => ({ status: 'running', outcome: 'pending', actualCost: 0 }) });
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const pending = client().job('web.scrape.markdown', { url: 'https://example.com' });
	await Promise.resolve();
	for (let i = 0; i < 5; i++) { await new Promise((resolve) => setImmediate(resolve)); t.mock.timers.tick(2_000); }
	const result = await pending;
	assert.equal(result.run.status, 'completed');
	assert.equal(polled.length, 1);
});

test('run costs read the settled charge, then the route total', () => {
	assert.equal(runCost({ runId: 'r', status: 'completed', actualCost: 0.5 }), 0.5);
	assert.equal(runCost({ runId: 'r', status: 'completed', actualCost: null, route: { chargedUsd: 0.25 } }), 0.25);
	assert.equal(runCost({ runId: 'r', status: 'completed' }), 0);
	assert.equal(callMeta({ runId: 'r1', status: 'completed', outcome: 'weak', endpointId: 'e1', actualCost: 0.01 }, 'job:people.phone.find').outcome, 'weak');
});

test('a token is checked by reading the balance, and its failure never echoes the token', async (t) => {
	fakeLooot(t, {}, { balance: 3.5 });
	assert.deepEqual(await verifyLoootToken('test-looot-token'), { ok: true, balanceUsd: 3.5, message: 'Token accepted. Balance $3.50.' });
	t.mock.restoreAll();
	const refused = await verifyLoootToken('secret-token-value', async () => new Response('{}', { status: 401 }));
	assert.equal(refused.ok, false);
	assert.equal(refused.issue, 'key');
	assert.ok(!refused.message?.includes('secret-token-value'));
	const empty = await verifyLoootToken('t', async () => Response.json({ available: 0 }));
	assert.equal(empty.issue, 'balance');
});
