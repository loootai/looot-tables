import assert from 'node:assert/strict';
import { test } from 'node:test';
import ContextDev from 'context.dev';
import { searchCompanySuggestions } from '../src/lib/server/company-search';

test('company autocomplete sends the SDK search contract and only returns normalized, distinct domains', async (t) => {
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		assert.equal(request.method, 'GET');
		const url = new URL(request.url);
		assert.equal(url.origin + url.pathname, 'https://api.context.dev/v1/brand/search');
		assert.equal(url.searchParams.get('query'), 'str');
		assert.equal(url.searchParams.get('autocomplete'), 'true');
		assert.equal(request.headers.get('authorization'), 'Bearer test-context');
		return Response.json({ request_id: 'test', results: [
			{ name: 'Stripe', domain: 'www.stripe.com', logo: 'ignored' },
			{ name: 'Duplicate', domain: 'stripe.com', logo: 'ignored' },
			{ name: 'Invalid', domain: 'not a domain', logo: 'ignored' },
			{ name: '', domain: 'example.com', logo: 'ignored' },
		] });
	});
	const result = await searchCompanySuggestions(new ContextDev({ apiKey: 'test-context' }), ' str ');
	assert.deepEqual(result, [{ name: 'Stripe', domain: 'stripe.com' }, { name: 'example.com', domain: 'example.com' }]);
});

test('company autocomplete does not retry failing upstream requests', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: 'Rate limited' }, { status: 429 }); });
	await assert.rejects(searchCompanySuggestions(new ContextDev({ apiKey: 'test-context' }), 'stripe'));
	assert.equal(calls, 1);
});
