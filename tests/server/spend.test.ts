import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { APICallError, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { companySearch } from '../../src/lib/server/context';
import { contactLookup } from '../../src/lib/server/contact-providers';
import { includedRun, sharedRequest } from '../../src/lib/server/contextdevenrichmentwaterfall';
import { CreditBudgetError } from '../../src/lib/server/credit-ledger';
import { Spend } from '../../src/lib/server/enrich-failure';
import { decideNoul } from '../../src/lib/server/jev';
import type { AccessAdapters, AccessGrant, ProviderAccess } from '../../src/lib/server/provider-access';
import { testAccess } from './access-fixture';
import { actor, ledgerFixture } from './ledger-fixture';

const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

/** What a fresh run's tracker saw while `call` used the clients its access handed out. */
async function spent(grant: Partial<AccessGrant>, call: (access: ProviderAccess) => Promise<unknown>, adapters?: AccessAdapters) {
	const spend = new Spend();
	await call(testAccess(grant, adapters).withSpend(spend)).catch(() => {});
	return { paid: spend.paid, credits: spend.credits };
}

/** Each fetch answers with the next reply. */
function replying(t: TestContext) {
	const replies: Array<() => Response> = [];
	t.mock.method(globalThis, 'fetch', async () => replies.shift()!());
	return (...next: Array<() => Response>) => { replies.splice(0, replies.length, ...next); };
}

test('Context.dev: a processed request is paid with its credits; a 429, a cache hit or a request that never arrived is not', async (t) => {
	const reply = replying(t);
	const grant = { keys: { context: 'spend-context' } };
	const search = (query: string) => (access: ProviderAccess) => access.context().web.search({ query });
	reply(() => Response.json({ results: [], key_metadata: { credits_consumed: 3 } }));
	assert.deepEqual(await spent(grant, search('billed')), { paid: true, credits: 3 });
	assert.deepEqual(await spent(grant, search('billed')), { paid: false, credits: 0 }, 'a cache hit');
	reply(() => Response.json({ results: [] }));
	assert.deepEqual(await spent(grant, search('no metadata')), { paid: true, credits: 1 }, 'the endpoint’s documented cost');
	reply(() => Response.json({ results: [], next_cursor: null }));
	assert.deepEqual(await spent(grant, (access) => companySearch(access.context(), { query: 'company search' })), { paid: true, credits: 2 });
	reply(() => { throw refused(); }, () => Response.json({ error: 'slow down' }, { status: 429 }), () => Response.json({ error: 'slow down' }, { status: 429 }));
	assert.deepEqual(await spent(grant, search('refused')), { paid: false, credits: 0 });
	reply(() => { throw reset(); });
	assert.deepEqual(await spent(grant, search('reset')), { paid: true, credits: 0 }, 'a request dropped after sending may have been billed');
	reply(() => Response.json({ error: 'upstream failed' }, { status: 500 }));
	assert.deepEqual(await spent(grant, search('server error')), { paid: true, credits: 0 });
});

test('OpenAI: a model call is paid once it answers or fails after reaching OpenAI; a 429, a call never sent and our own refusals are not', async () => {
	const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
	const failed = (statusCode?: number, cause?: unknown) => new APICallError({ message: 'Failed', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, statusCode, cause, isRetryable: true });
	const call = (doGenerate: () => Promise<never> | Promise<object>) => spent({ keys: { openai: 'spend-openai' } }, (access) => generateText({ model: access.openai(), prompt: 'Hi', maxRetries: 0 }), { openai: () => new MockLanguageModelV4({ doGenerate: doGenerate as never }) });
	assert.deepEqual(await call(async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] })), { paid: true, credits: 0 });
	assert.deepEqual(await call(async () => { throw failed(503); }), { paid: true, credits: 0 });
	assert.deepEqual(await call(async () => { throw failed(429); }), { paid: false, credits: 0 });
	assert.deepEqual(await call(async () => { throw failed(undefined, refused().cause); }), { paid: false, credits: 0 });
	assert.deepEqual(await call(async () => { throw failed(undefined, reset().cause); }), { paid: true, credits: 0 });
	assert.deepEqual(await call(async () => { throw new CreditBudgetError('openai', 'rate_limited'); }), { paid: false, credits: 0 }, 'the trial ledger refused it before OpenAI saw it');
});

test('TypeSafe: a decision is paid once processed, not when refused (429) or never sent', async (t) => {
	const reply = replying(t);
	const grant = { keys: { typesafe: 'spend-typesafe' } };
	const decide = (access: ProviderAccess) => decideNoul(access, 'jev', 'ROW: Acme', 'Software?');
	reply(() => Response.json({ model: 'jev-test', answers: { answer: { noul: .9 } } }));
	assert.deepEqual(await spent(grant, decide), { paid: true, credits: 0 });
	reply(() => Response.json({ error: 'failed' }, { status: 500 }));
	assert.deepEqual(await spent(grant, decide), { paid: true, credits: 0 });
	reply(() => { throw refused(); }, () => Response.json({ error: 'slow down' }, { status: 429 }), () => Response.json({ error: 'slow down' }, { status: 429 }));
	assert.deepEqual(await spent(grant, decide), { paid: false, credits: 0 });
});

test('email providers: a lookup is paid once the provider answers; a refusal (429, Hunter’s 403) or an included rate limit is not', async (t) => {
	const { access: ledger } = await ledgerFixture(t, 'enrichment');
	const values = { ENRICHMENT_API_KEY: 'shared-secret', ENRICHMENT_API_URL: 'https://enrichment.example.com', DATABASE_URL: 'test', ENRICHABLE_APP_URL: 'https://www.enrichable.io', CONTEXT_IDENTITY_ISSUER: 'https://identity.example.com' };
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	let status = 200;
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
		if (status !== 200) return Response.json({ error: true }, { status });
		if (new Request(input, init).url.startsWith('https://enrichment.example.com')) return Response.json({ runId: 'run', status: 'COMPLETED', output: null, providerResponse: { httpStatus: 200 }, cost: { value: .01, currency: 'USD' } });
		return Response.json({ data: { email: 'ada@example.com' } });
	});
	const grant = { account: actor(), keys: { hunter: 'spend-hunter', prospeo: 'spend-prospeo' } };
	const hunter = (access: ProviderAccess) => contactLookup(access, { kind: 'hunter', action: 'find', name: 'Ada Lovelace', domain: 'example.com' }, {});
	const prospeo = (access: ProviderAccess) => contactLookup(access, { kind: 'prospeo', email: 'ada@example.com', field: 'email', onlyVerifiedEmail: false }, {});
	const included = (access: ProviderAccess) => includedRun(access, sharedRequest('hunter', { name: 'Ada Lovelace', domain: 'example.com', company: '', profileUrl: '' }), ledger);
	assert.deepEqual(await spent(grant, hunter), { paid: true, credits: 0 });
	assert.deepEqual(await spent(grant, included), { paid: true, credits: 0 });
	status = 403;
	assert.deepEqual(await spent(grant, hunter), { paid: false, credits: 0 }, 'Hunter signals rate limits with 403');
	status = 429;
	assert.deepEqual(await spent(grant, prospeo), { paid: false, credits: 0 });
	assert.deepEqual(await spent(grant, included), { paid: false, credits: 0 });
	status = 503;
	assert.deepEqual(await spent(grant, prospeo), { paid: true, credits: 0 }, 'a server error may come after the lookup was billed');
});
