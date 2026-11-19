import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextUsage } from '../../src/lib/server/context';
import { GET } from '../../src/app/api/context/usage/route';

test('reads the actual remaining balance and period usage without caching', async (t) => {
	t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
		assert.equal(url, 'https://api.context.dev/v1/org/usage');
		assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-context');
		assert.equal(init.cache, 'no-store');
		return Response.json({ credits_remaining: 0, period: { credits_used: 1000 } });
	});
	assert.deepEqual(await contextUsage('test-context'), { credits: 0, used: 1000 });
	const response = await GET(new Request('http://localhost/api/context/usage', { headers: { 'x-context-key': 'test-context' } }));
	assert.equal(response.status, 200);
	assert.match(response.headers.get('cache-control')!, /no-store/);
	assert.deepEqual(await response.json(), { credits: 0, used: 1000 });
});

test('usage failures do not become a zero balance', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
	const response = await GET(new Request('http://localhost/api/context/usage', { headers: { 'x-context-key': 'test-context' } }));
	assert.equal(response.status, 502);
	assert.ok((await response.json()).error);
});
