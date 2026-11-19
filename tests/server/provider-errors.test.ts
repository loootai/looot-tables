import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError } from '../../src/lib/server/credentials';
import { testAccess } from './access-fixture';
import { APICallError, RetryError } from 'ai';
import { APIError as TypeSafeError, APIConnectionError as TypeSafeConnectionError, APITimeoutError } from '@typesafe-ai/sdk';
import { classifyFailure, httpFailure } from '../../src/lib/server/enrich-failure';
import { decideNoul } from '../../src/lib/server/jev';
import { runOp } from '../../src/lib/server/enrich';
import { fakeLooot, hit } from './looot-fixture';

/** Connection failures as Node's fetch reports them: refused before anything was sent, or reset after sending. */
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const reset = () => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

const credentials = { openaiKey: 'secret-openai-key', loootKey: 'secret-looot-key' };
const access = testAccess({ keys: { openai: credentials.openaiKey, looot: credentials.loootKey }, model: 'test' });

test('structured validation errors remain readable and redact keys before truncation', () => {
 const message = [{ path: ['input', 'query'], message: `Too big: expected <=2000 characters ${credentials.loootKey}` }];
 const result = access.redact({ status: 400, error: { message } });
 assert.match(result, /input.query: Too big/);
 assert.match(result, /\[redacted\]/);
 assert.match(result, /\(400\)$/);
 assert.ok(!result.includes(credentials.loootKey));
 assert.equal(describeError({ message: [{ message: 'Invalid query' }] }), 'Invalid query');
 assert.equal(access.redact({ message: {} }), 'Request failed');
 const longKey = 'credential-'.repeat(60);
 assert.ok(!testAccess({ keys: { openai: longKey } }).redact(new Error(longKey)).includes('credential-'));
});

test('population planning errors redact provider credentials before streaming', async (t) => {
 const { populateStream } = await import('../../src/lib/server/populate');
 t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: `Invalid API key: ${credentials.openaiKey}`, type: 'authentication_error' } }, { status: 401 }));
 const stream = await new Response(populateStream(testAccess({ keys: { openai: credentials.openaiKey, looot: credentials.loootKey }, model: 'test', openaiBaseUrl: 'https://model.example/v1' }), { query: 'Ada Lovelace', entity: 'people', target: 1 })).text();
 assert.ok(!stream.includes(credentials.openaiKey));
 const events = stream.trim().split('\n').map(line => JSON.parse(line));
 assert.match(events.find(event => event.type === 'error').message, /\[redacted\]/);
});

test('failed people lookups redact credentials before saving an enrichment note', async (t) => {
 const { populatePeopleList } = await import('../../src/lib/server/populate-people-list');
 const events: import('../../src/lib/types').PopulateEvent[] = [];
 fakeLooot(t, { '*': () => ({ http: { status: 500, body: { error: { code: 'server_error', message: `Rejected credential ${credentials.loootKey}` } } } }) });
 await populatePeopleList(access, { query: 'Ada Lovelace', entity: 'people', target: 1 }, [{ name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', companyDomain: 'example.com', companyName: 'Example', email: null, profileUrls: [], city: null, region: null, country: null, school: null }], event => events.push(event), new AbortController().signal);
 assert.ok(!JSON.stringify(events).includes(credentials.loootKey));
 const row = events.flatMap(event => event.type === 'rows' ? event.rows : [])[0];
 assert.equal(row.Name, 'Ada Lovelace');
 assert.equal(row['Enrichment status'], 'Lookup failed');
 assert.match(String(row['Enrichment note']), /\[redacted\]/);
});

test('failures are classified from error types and statuses, never from message text', () => {
 const call = (statusCode: number, responseBody = '') => new APICallError({ message: 'Request failed', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, statusCode, responseBody, isRetryable: statusCode === 429 || statusCode >= 500 });
 assert.deepEqual(classifyFailure(call(429)), { reason: 'rate_limited', retryable: true, provider: 'openai' });
 assert.deepEqual(classifyFailure(call(429, '{"error":{"code":"insufficient_quota"}}')), { reason: 'credits_exhausted', retryable: false, provider: 'openai' });
 assert.deepEqual(classifyFailure(new RetryError({ message: 'Failed after 3 attempts', reason: 'maxRetriesExceeded', errors: [call(503)] })), { reason: 'provider_error', retryable: false, provider: 'openai' }, 'a server error may come after the work was done');
 assert.deepEqual(classifyFailure(call(504)), { reason: 'timeout', retryable: false, provider: 'openai' });
 assert.deepEqual(classifyFailure(call(401)), { reason: 'credential_invalid', retryable: false, provider: 'openai' });
 assert.deepEqual(classifyFailure(new TypeSafeError(402, {}, new Headers())), { reason: 'credits_exhausted', retryable: false, provider: 'typesafe' });
 assert.deepEqual(classifyFailure(new DOMException('The operation timed out.', 'TimeoutError'), 'looot'), { reason: 'timeout', retryable: false, provider: 'looot' });
 assert.deepEqual(classifyFailure(Object.assign(new Error('Search failed'), { status: 503 }), 'looot'), { reason: 'provider_error', retryable: false, provider: 'looot' });
 assert.deepEqual(classifyFailure(new TypeSafeError(500, {}, new Headers())), { reason: 'provider_error', retryable: false, provider: 'typesafe' });
 assert.equal(classifyFailure(new Error('429 rate limit timed out')), undefined, 'English never decides the outcome');
});

test('a connection failure is retryable only when the request provably never reached the provider', () => {
 const unsent = new APICallError({ message: 'Cannot connect to API', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, cause: refused().cause, isRetryable: true });
 const dropped = new APICallError({ message: 'Cannot connect to API', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, cause: reset().cause, isRetryable: true });
 assert.deepEqual(classifyFailure(unsent), { reason: 'provider_error', retryable: true, provider: 'openai' });
 assert.deepEqual(classifyFailure(dropped), { reason: 'provider_error', retryable: false, provider: 'openai' }, 'the SDK’s own retry hint does not decide');
 assert.deepEqual(classifyFailure(new TypeSafeConnectionError('Connection error', { cause: refused() })), { reason: 'provider_error', retryable: true, provider: 'typesafe' });
 assert.deepEqual(classifyFailure(new TypeSafeConnectionError('Connection error', { cause: reset() })), { reason: 'provider_error', retryable: false, provider: 'typesafe' });
 assert.deepEqual(classifyFailure(refused(), 'looot'), { reason: 'provider_error', retryable: true, provider: 'looot' });
 assert.equal(classifyFailure(reset(), 'looot'), undefined, 'an unexplained failure is never assumed unsent');
});

test('enrichment results carry structured failures', async () => {
 assert.deepEqual((await runOp(access, { kind: 'search', query: '{{Missing}}', pick: 'url', numResults: 5 }, {})).failure, { reason: 'input_invalid', retryable: false, provider: 'looot' });
 const missing = await runOp(testAccess({ keys: { looot: credentials.loootKey }, model: 'test' }), { kind: 'ai', prompt: 'Who?', output: 'text', research: 'none' }, {});
 assert.deepEqual(missing.failure, { reason: 'credential_missing', retryable: false, provider: 'openai' });
 assert.match(missing.error!, /Add your OpenAI API key/);
 const noToken = await runOp(testAccess({ keys: { openai: credentials.openaiKey }, model: 'test' }), { kind: 'search', query: 'solar', pick: 'url', numResults: 1 }, {});
 assert.deepEqual(noToken.failure, { reason: 'credential_missing', retryable: false, provider: 'looot' });
 assert.match(noToken.error!, /Add your looot API key/);
});

test('the enrich endpoint returns structured failures with matching HTTP status', async (t) => {
 const values = { ENRICHABLE_APP_URL: 'https://self-hosted.example', ENRICHABLE_PASSWORD: '', ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD: 'false', DATABASE_URL: '' };
 const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
 Object.assign(process.env, values);
 t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
 const { POST } = await import('../../src/app/api/enrich/route');
 const post = (body: string, headers: Record<string, string> = {}) => POST(new Request('https://self-hosted.example/api/enrich', { method: 'POST', body, headers }));
 const invalid = await post('{');
 assert.equal(invalid.status, 400);
 assert.deepEqual(await invalid.json(), { error: 'Invalid JSON body', failure: { reason: 'input_invalid', retryable: false } });
 const unsafe = await post(JSON.stringify({ op: { kind: 'template', template: 'x' }, row: {} }), { 'x-openai-base-url': 'http://10.0.0.1/v1' });
 assert.equal(unsafe.status, 400);
 assert.deepEqual((await unsafe.json()).failure, { reason: 'input_invalid', retryable: false });
 const ok = await post(JSON.stringify({ op: { kind: 'search', query: '{{Missing}}' }, row: {} }), { 'x-looot-key': 'secret-looot-key' });
 assert.equal(ok.status, 200);
 const result = await ok.json();
 assert.deepEqual(result.failure, { reason: 'input_invalid', retryable: false, provider: 'looot' });
 assert.ok(!JSON.stringify(result).includes('secret-looot-key'));
 const bad = await post(JSON.stringify({ op: { kind: 'template', template: 'x' }, row: {}, attempt: 'not valid!' }));
 assert.equal(bad.status, 400, 'an attempt id is a plain token');
});

test('a timeout may have been billed, so nothing repeats it; a request refused before processing is retried', async (t) => {
 assert.deepEqual(httpFailure(504, 'looot'), { reason: 'timeout', retryable: false, provider: 'looot' });
 assert.deepEqual(httpFailure(408, 'looot'), { reason: 'timeout', retryable: false, provider: 'looot' });
 const { LoootClient } = await import('../../src/lib/server/looot');
 const { Spend } = await import('../../src/lib/server/enrich-failure');
 let calls = 0, reply: () => Promise<Response> = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
 t.mock.method(globalThis, 'fetch', async () => { calls++; return reply(); });
 const spend = new Spend();
 const client = new LoootClient({ token: 'test-key', spend, attempt: 'timeouts' });
 await assert.rejects(client.job('web.search', { query: 'timed out' }), /did not answer in time/);
 assert.equal(calls, 1, 'looot: a timed-out request is sent once');
 assert.equal(spend.paid, true, 'a request that may have been processed counts as paid');
 const run = { runId: 'run_1', status: 'completed', outcome: 'hit', result: { results: [] }, actualCost: 0 };
 const answers = [() => Response.json({ error: { code: 'rate_limited', message: 'slow down' } }, { status: 429 }), () => { throw refused(); }, () => Response.json(run, { status: 201 })];
 calls = 0; reply = async () => answers[calls - 1]();
 const first = await new LoootClient({ token: 'test-key', spend: new Spend(), attempt: 'resend' }).job('web.search', { query: 'refused first' });
 assert.equal(first.run.runId, 'run_1');
 assert.equal(calls, 3, 'rate limited, then never connected, then answered');
 calls = 0; reply = async () => Response.json({ error: { code: 'server_error', message: 'upstream failed' } }, { status: 500 });
 await assert.rejects(new LoootClient({ token: 'test-key', spend: new Spend(), attempt: 'server-error' }).job('web.search', { query: 'server error' }));
 assert.equal(calls, 1, 'a server error may come after the work was done');
 calls = 0; reply = async () => { throw reset(); };
 const dropped = await runOp(access, { kind: 'search', query: 'reset after sending', pick: 'url', numResults: 1 }, {});
 assert.equal(calls, 1, 'a connection reset after sending is not resent');
 assert.deepEqual(dropped.failure, { reason: 'provider_error', retryable: false, provider: 'looot' });
});

test('TypeSafe resends a decision only when it never connected; a truncated answer or a reset after sending is final', async (t) => {
 const typesafe = testAccess({ keys: { typesafe: 'test-key' } });
 const check = { kind: 'check', question: 'Software?', threshold: .5, decider: 'jev' } as const;
 const truncated = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"answers":')); controller.error(new Error('terminated')); } }), { headers: { 'content-type': 'application/json' } });
 let calls = 0, reply: () => Response = truncated;
 t.mock.method(globalThis, 'fetch', async () => { calls++; return reply(); });
 const cut = await runOp(typesafe, check, { Company: 'Acme' });
 assert.equal(calls, 1, 'a truncated answer may have been billed');
 assert.deepEqual(cut.failure, { reason: 'provider_error', retryable: false, provider: 'typesafe' });
 calls = 0; reply = () => { throw reset(); };
 const dropped = await runOp(typesafe, check, { Company: 'Acme' });
 assert.equal(calls, 1, 'a connection reset after sending is not resent');
 assert.deepEqual(dropped.failure, { reason: 'provider_error', retryable: false, provider: 'typesafe' });
 const answers = [() => { throw refused(); }, () => Response.json({ model: 'jev-test', answers: { answer: { noul: .9 } } })];
 calls = 0; reply = () => answers[calls - 1]();
 const answered = await runOp(typesafe, check, { Company: 'Acme' });
 assert.equal(answered.value, true);
 assert.equal(calls, 2, 'never connected, then answered');
});

test('OpenAI calls are sent once: a gateway timeout is never repeated', async (t) => {
 let calls = 0;
 t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: { message: 'Gateway Timeout' } }, { status: 504 }); });
 const result = await runOp(access, { kind: 'ai', prompt: 'Who founded {{Company}}?', output: 'text', research: 'none' }, { Company: 'Acme' });
 assert.equal(calls, 1);
 assert.deepEqual(result.failure, { reason: 'timeout', retryable: false, provider: 'openai' });
});

test('TypeSafe decisions never repeat a timed-out request', async (t) => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 let calls = 0;
 t.mock.method(globalThis, 'fetch', async (_input: unknown, init?: RequestInit) => { calls++; return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })); });
 let settled = false;
 const decision = assert.rejects(decideNoul(testAccess({ keys: { typesafe: 'test-key' } }), 'jev', 'ROW: Acme', 'Software?'), APITimeoutError).finally(() => { settled = true; });
 for (let i = 0; i < 20 && !settled; i++) { await new Promise((resolve) => setImmediate(resolve)); t.mock.timers.tick(60_000); }
 await decision;
 assert.equal(calls, 1);
});

test('a failure after the operation already spent money is never retried automatically', async (t) => {
 let reads = 0;
 fakeLooot(t, { 'job:web.scrape.markdown': () => ++reads === 1
  ? hit({}, { normalized: { fields: { markdown: 'Pricing '.repeat(60) } }, actualCost: 0.003 })
  : ({ status: 'failed', outcome: 'error', error: { code: 'provider_error', message: 'upstream failed', retryable: true }, actualCost: 0 }) });
 const result = await runOp(access, { kind: 'scrape', page: { type: 'find', column: 'Domain', page: 'pricing' }, mode: 'markdown', maxChars: 2000 }, { Domain: 'acme.com' });
 assert.equal(result.meta?.costUsd, 0.003);
 assert.deepEqual(result.failure, { reason: 'provider_error', retryable: false, provider: 'looot' }, 'retrying would pay for the page lookup again');
});

test('Ask AI never reruns a billed step: a 429 after a finished step is final, a 429 on the first step is retryable', async (t) => {
	const { MockLanguageModelV4 } = await import('ai/test');
	const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } };
	const limited = () => new APICallError({ message: 'Rate limited', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, statusCode: 429, responseBody: '', isRetryable: true });
	t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'server_error', message: 'upstream failed' } }, { status: 503 }));
	const run = async (steps: Array<() => object>) => {
		let requests = 0;
		const model = new MockLanguageModelV4({ doGenerate: async () => { const step = steps[requests++]; if (!step) throw new Error('unexpected request'); return step() as never; } });
		const access = testAccess({ keys: { openai: credentials.openaiKey, looot: credentials.loootKey }, model: 'test' }, { openai: () => model });
		const result = await runOp(access, { kind: 'ai', prompt: 'Who is the CEO?', output: 'text', research: 'web' }, {});
		return { requests, failure: result.failure };
	};
	const search = () => ({ content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'searchWeb', input: JSON.stringify({ query: 'ceo' }) }], finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] });
	const afterStep = await run([search, () => { throw limited(); }]);
	assert.equal(afterStep.requests, 2);
	assert.equal(afterStep.failure?.retryable, false, 'step 1 and its search were billed; rerunning would pay again');
	const firstStep = await run([() => { throw limited(); }]);
	assert.equal(firstStep.requests, 1);
	assert.equal(firstStep.failure?.retryable, true, 'nothing was processed yet');
});

test('a page that is not there answers a check false; a refused page lookup halts or retries instead of answering', async (t) => {
	let status = 402;
	const http = () => ({ http: { status, body: { error: { code: status === 402 ? 'insufficient_balance' : status === 401 ? 'unauthorized' : 'rate_limited', message: 'refused' } } } });
	const { runs } = fakeLooot(t, {
		'job:web.scrape.markdown': () => status !== 200 ? http() : hit({}, { normalized: { fields: { markdown: '# Page not found' } }, actualCost: 0.001 }),
		'job:web.search': () => hit({ results: [] }, { actualCost: 0 }),
	});
	const page = { type: 'find', column: 'Domain', page: 'pricing' } as const;
	const check = { kind: 'check', question: 'Is SSO on the pricing page?', page, literal: 'SSO', threshold: .5, decider: 'jev' } as const;
	const scrape = { kind: 'scrape', page, mode: 'markdown', maxChars: 2000 } as const;
	const exhausted = await runOp(access, check, { Domain: 'out-of-credits.example' });
	assert.equal(exhausted.value, null, 'not a false answer saved as done');
	assert.deepEqual(exhausted.failure, { reason: 'credits_exhausted', retryable: false, provider: 'looot' });
	assert.equal(runs.length, 1, 'no further probes after a refusal');
	status = 401; runs.length = 0;
	assert.deepEqual((await runOp(access, scrape, { Domain: 'bad-key.example' })).failure, { reason: 'credential_invalid', retryable: false, provider: 'looot' });
	status = 429; runs.length = 0;
	assert.deepEqual((await runOp(access, check, { Domain: 'rate-limited.example' })).failure, { reason: 'rate_limited', retryable: true, provider: 'looot' });
	assert.equal(runs.length, 3, 'one probe, resent while refused, then the run backs off');
	status = 200; runs.length = 0;
	const missing = await runOp(access, check, { Domain: 'missing-page.example' });
	assert.equal(missing.value, false);
	assert.match(String(missing.meta?.reasoning), /No pricing page found on missing-page\.example/);
	assert.equal(missing.meta?.costUsd, 0.003, 'three probes were paid, the site search was free');
	assert.deepEqual((await runOp(access, scrape, { Domain: 'missing-page.example' })).failure, { reason: 'input_invalid', retryable: false, provider: 'looot' });
});

test('non-enrichment OpenAI calls are sent once unless refused (429) or never sent', async (t) => {
	const { POST: formula } = await import('../../src/app/api/formula-builder/route');
	const { composeColumn } = await import('../../src/lib/server/compose');
	const { planPeopleInput } = await import('../../src/lib/server/populate-people-list');
	const { populateStream } = await import('../../src/lib/server/populate');
	let calls = 0, replies: Array<() => Response> = [];
	const failed = () => Response.json({ error: { message: 'upstream failed' } }, { status: 500 });
	t.mock.method(globalThis, 'fetch', async () => { calls++; return (replies.shift() ?? failed)(); });
	const openai = testAccess({ keys: { openai: credentials.openaiKey, looot: credentials.loootKey }, model: 'test' });
	const formulaRequest = () => new Request('https://tables.test/api/formula-builder', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-key': credentials.openaiKey }, body: JSON.stringify({ ask: 'Double the value', formula: '=', target: 'B2', columns: [{ name: 'Value', address: 'A' }] }) });
	const sentOnce = async (name: string, call: () => Promise<unknown>) => { calls = 0; await call().catch(() => {}); assert.equal(calls, 1, name); };
	await sentOnce('formula builder', () => formula(formulaRequest()));
	await sentOnce('compose', () => composeColumn(openai, { ask: 'Find the CEO', columns: [{ name: 'Domain', type: 'source' }] }));
	await sentOnce('people-list planning', () => planPeopleInput(openai, 'Ada Lovelace', new AbortController().signal));
	await sentOnce('Find rows', () => new Response(populateStream(openai, { query: 'Solar companies', entity: 'companies', target: 3 })).text());
	calls = 0;
	replies = [() => Response.json({ error: { message: 'Rate limited', type: 'requests', code: 'rate_limit_exceeded' } }, { status: 429 }), () => Response.json({ id: 'resp_formula', created_at: 1, model: 'test', status: 'completed', output: [{ id: 'msg_formula', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ formula: '=A2*2', explanation: 'Doubles it.' }), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } })];
	const recovered = await formula(formulaRequest());
	assert.equal(recovered.status, 200, 'a rate-limited request is resent');
	assert.equal(calls, 2);
});
