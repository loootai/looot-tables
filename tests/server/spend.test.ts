import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { APICallError, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Spend } from '../../src/lib/server/enrich-failure';
import { decideNoul } from '../../src/lib/server/jev';
import type { AccessAdapters, AccessGrant, ProviderAccess } from '../../src/lib/server/provider-access';
import { testAccess } from './access-fixture';
import { fakeLooot, hit } from './looot-fixture';

const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

/** What a fresh run's tracker saw while `call` used the clients its access handed out. */
async function spent(grant: Partial<AccessGrant>, call: (access: ProviderAccess) => Promise<unknown>, adapters?: AccessAdapters) {
	const spend = new Spend();
	await call(testAccess(grant, adapters).withSpend(spend, 'spend-test')).catch(() => {});
	return { paid: spend.paid, costUsd: spend.costUsd };
}

/** Each fetch answers with the next reply. */
function replying(t: TestContext) {
	const replies: Array<() => Response> = [];
	t.mock.method(globalThis, 'fetch', async () => replies.shift()!());
	return (...next: Array<() => Response>) => { replies.splice(0, replies.length, ...next); };
}

test('looot: a settled run is paid with what looot charged for it; a free hit, a refusal or a request that never arrived is not', async (t) => {
	const reply = replying(t);
	const grant = { keys: { looot: 'spend-looot' } };
	const search = (query: string) => (access: ProviderAccess) => access.looot().job('web.search', { query });
	const run = (actualCost: number | null, extra: object = {}) => () => Response.json({ runId: 'run_1', status: 'completed', outcome: 'hit', result: {}, actualCost, ...extra }, { status: 201 });
	reply(run(0.0089));
	assert.deepEqual(await spent(grant, search('billed')), { paid: true, costUsd: 0.0089 });
	reply(run(0));
	assert.deepEqual(await spent(grant, search('free')), { paid: false, costUsd: 0 }, 'a provider that answered for free charged nothing');
	reply(() => Response.json({ runId: 'r', status: 'failed', outcome: 'error', error: { code: 'provider_error', message: 'no', retryable: true }, actualCost: 0 }, { status: 201 }));
	assert.deepEqual(await spent(grant, search('failed unbilled')), { paid: false, costUsd: 0 }, 'errors and rejected calls are never charged');
	reply(() => { throw refused(); }, () => Response.json({ error: { code: 'rate_limited', message: 'slow down' } }, { status: 429 }), () => Response.json({ error: { code: 'rate_limited', message: 'slow down' } }, { status: 429 }));
	assert.deepEqual(await spent(grant, search('refused')), { paid: false, costUsd: 0 });
	reply(() => Response.json({ error: { code: 'insufficient_balance', message: 'low' } }, { status: 402 }));
	assert.deepEqual(await spent(grant, search('no balance')), { paid: false, costUsd: 0 }, 'blocked before dispatch');
	reply(() => { throw reset(); });
	assert.deepEqual(await spent(grant, search('reset')), { paid: true, costUsd: 0 }, 'a request dropped after sending may have been billed');
	reply(() => Response.json({ error: { code: 'server_error', message: 'upstream failed' } }, { status: 500 }));
	assert.deepEqual(await spent(grant, search('server error')), { paid: true, costUsd: 0 });
});

test('looot: one cell attempt sums every run it made, and each run is kept for the cell panel', async (t) => {
	fakeLooot(t, { 'job:web.search': () => hit({ results: [] }, { actualCost: 0.0003 }), 'job:web.scrape.markdown': () => hit({}, { normalized: { fields: { markdown: 'text' } }, actualCost: 0.001 }) });
	const spend = new Spend();
	const access = testAccess({ keys: { looot: 'spend-looot' } }).withSpend(spend, 'sum-test');
	await access.looot().job('web.search', { query: 'a' });
	await access.looot().job('web.scrape.markdown', { url: 'https://example.com' });
	assert.equal(Math.round(spend.costUsd * 1e6) / 1e6, 0.0013);
	assert.deepEqual(access.calls.map((call) => call.job), ['web.search', 'web.scrape.markdown'], 'the same client serves the whole attempt');
});

test('OpenAI: a model call is paid once it answers or fails after reaching OpenAI; a 429 and a call never sent are not', async () => {
	const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
	const failed = (statusCode?: number, cause?: unknown) => new APICallError({ message: 'Failed', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, statusCode, cause, isRetryable: true });
	const call = (doGenerate: () => Promise<never> | Promise<object>) => spent({ keys: { openai: 'spend-openai' } }, (access) => generateText({ model: access.openai(), prompt: 'Hi', maxRetries: 0 }), { openai: () => new MockLanguageModelV4({ doGenerate: doGenerate as never }) });
	assert.deepEqual(await call(async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] })), { paid: true, costUsd: 0 });
	assert.deepEqual(await call(async () => { throw failed(503); }), { paid: true, costUsd: 0 });
	assert.deepEqual(await call(async () => { throw failed(429); }), { paid: false, costUsd: 0 });
	assert.deepEqual(await call(async () => { throw failed(undefined, refused().cause); }), { paid: false, costUsd: 0 });
	assert.deepEqual(await call(async () => { throw failed(undefined, reset().cause); }), { paid: true, costUsd: 0 });
});

test('TypeSafe: a decision is paid once processed, not when refused (429) or never sent', async (t) => {
	const reply = replying(t);
	const grant = { keys: { typesafe: 'spend-typesafe' } };
	const decide = (access: ProviderAccess) => decideNoul(access, 'jev', 'ROW: Acme', 'Software?');
	reply(() => Response.json({ model: 'jev-test', answers: { answer: { noul: .9 } } }));
	assert.deepEqual(await spent(grant, decide), { paid: true, costUsd: 0 });
	reply(() => Response.json({ error: 'failed' }, { status: 500 }));
	assert.deepEqual(await spent(grant, decide), { paid: true, costUsd: 0 });
	reply(() => { throw refused(); }, () => Response.json({ error: 'slow down' }, { status: 429 }), () => Response.json({ error: 'slow down' }, { status: 429 }));
	assert.deepEqual(await spent(grant, decide), { paid: false, costUsd: 0 });
});
