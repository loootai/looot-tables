import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContextFetch } from '../../src/lib/server/context-cache';
import { contextClient } from '../../src/lib/server/context';

const url = 'https://api.context.dev/v1/company/search';
const options = (key = 'one', body = { query: 'example.com' }) => ({ method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('full JSON is reused for one hour, isolated by credentials/query, and concurrent reads share work', async (t) => {
	let time = 1000, calls = 0;
	const cached = createContextFetch(() => time);
	t.mock.method(globalThis, 'fetch', async () => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 5));
		return Response.json({ results: [{ domain: 'example.com', funding: { stage: 'seed', total_usd: 42 } }], key_metadata: { credits_consumed: 2 } });
	});
	const [first, parallel] = await Promise.all([cached(url, options()), cached(url, options())]);
	assert.equal(calls, 1);
	assert.equal((await first.json()).key_metadata.credits_consumed, 2);
	assert.equal((await parallel.json()).key_metadata.credits_consumed, 0);
	const hit = await (await cached(url, options())).json();
	assert.equal(hit.results[0].funding.total_usd, 42);
	assert.equal(hit.key_metadata.credits_consumed, 0);
	await cached(url, options('two'));
	await cached(url, options('one', { query: 'other.com' }));
	assert.equal(calls, 3);
	time += 3_600_001;
	await cached(url, options());
	assert.equal(calls, 4);
});

test('errors, failed page reads and live balances are never cached; retries can succeed', async (t) => {
	const cached = createContextFetch();
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		calls++;
		return calls === 1 ? Response.json({ error: 'limited' }, { status: 429 }) : Response.json({ markdown: { success: false, message: 'timeout' } });
	});
	await cached(url, options());
	await cached(url, options());
	await cached(url, options());
	await cached('https://api.context.dev/v1/org/usage');
	await cached('https://api.context.dev/v1/org/usage');
	assert.equal(calls, 5);
});

test('one cancelled caller does not cancel another caller sharing its lookup', async (t) => {
	const cached = createContextFetch();
	let finish!: () => void;
	t.mock.method(globalThis, 'fetch', async () => {
		await new Promise<void>((resolve) => { finish = resolve; });
		return Response.json({ results: [] });
	});
	const controller = new AbortController();
	const first = cached(url, { ...options(), signal: controller.signal });
	const second = cached(url, options());
	while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
	controller.abort();
	await assert.rejects(first, { name: 'AbortError' });
	finish();
	assert.deepEqual(await (await second).json(), { results: [], key_metadata: { credits_consumed: 0 } });
});

test('the SDK uses the same cache for repeated brand requests', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ brand: { title: 'Example' }, status: 'complete', key_metadata: { credits_consumed: 1 } }); });
	const client = contextClient('sdk-cache-test');
	const request = { type: 'by_domain' as const, domain: 'example.com' };
	assert.equal((await client.brand.retrieve(request)).brand?.title, 'Example');
	assert.equal((await client.brand.retrieve(request)).key_metadata?.credits_consumed, 0);
	assert.equal(calls, 1);
});

test('partial people results are shared in flight but retries fetch and cache complete data', async (t) => {
 const cached = createContextFetch();
 let calls = 0;
 let release!: () => void;
 t.mock.method(globalThis, 'fetch', async () => {
  calls++;
  if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
  return Response.json({ partial: calls === 1, match: { status: 'candidate', person: { ...(calls > 1 ? { email: 'ada@example.com' } : {}) } } });
 });
 const endpoint = 'https://api.context.dev/v1/people/enrich';
 const first = cached(endpoint, options());
 const parallel = cached(endpoint, options());
 while (!release) await new Promise(resolve => setTimeout(resolve, 1));
 release();
 for (const response of await Promise.all([first, parallel])) assert.equal((await response.json()).partial, true);
 assert.equal(calls, 1);
 const retry = await cached(endpoint, options());
 assert.equal((await retry.json()).match.person.email, 'ada@example.com');
 assert.equal(calls, 2);
 const hit = await cached(endpoint, options());
 assert.equal(hit.headers.get('x-enrichable-cache'), 'HIT');
 assert.equal((await hit.json()).partial, false);
 assert.equal(calls, 2);
});
