import assert from 'node:assert/strict';
import { test } from 'node:test';
import { companySearch, contextClient, contextUsage } from '../../src/lib/server/context';
import { taggedContextFetch } from '../../src/lib/server/context-tags';

test('SDK JSON and GET requests carry the user tag and preserve existing tags', async (t) => {
	const requests: Request[] = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
		requests.push(new Request(input, init));
		return Response.json({ results: [], key_metadata: { credits_consumed: 1 } });
	});
	const client = contextClient('tag-sdk', 'alice+test@example.com');
	await client.web.search({ query: 'tagging test', tags: ['existing'] });
	await client.brand.search({ query: 'tagging test', tags: ['existing'] });
	assert.deepEqual((await requests[0].json()).tags, ['existing', 'enrichable-alice+test@example.com']);
	assert.equal(new URL(requests[1].url).searchParams.get('tags'), 'existing,enrichable-alice+test@example.com');
});

test('REST company search and uncached usage requests carry attribution', async (t) => {
	const requests: Request[] = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
		requests.push(new Request(input, init));
		return Response.json({ results: [], credits_remaining: 20 });
	});
	await companySearch(contextClient('tag-rest', 'alice@example.com'), { query: 'example.com' });
	await contextUsage('tag-rest', 'alice@example.com');
	assert.deepEqual((await requests[0].json()).tags, ['enrichable-alice@example.com']);
	assert.equal(new URL(requests[1].url).searchParams.get('tags'), 'enrichable-alice@example.com');
	assert.equal(requests[1].cache, 'no-store');
});

test('concurrent users sharing a key get separate upstream requests and cache entries', async (t) => {
	const tags: string[][] = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
		tags.push((await new Request(input, init).json()).tags);
		return Response.json({ results: [], key_metadata: { credits_consumed: 1 } });
	});
	const alice = contextClient('tag-shared', 'alice@example.com');
	const bob = contextClient('tag-shared', 'bob@example.com');
	await Promise.all([alice.web.search({ query: 'same query' }), bob.web.search({ query: 'same query' })]);
	await alice.web.search({ query: 'same query' });
	await bob.web.search({ query: 'same query' });
	assert.deepEqual(tags.sort(), [['enrichable-alice@example.com'], ['enrichable-bob@example.com']]);
});

test('tags are not forwarded to other services', async () => {
	const transport: typeof fetch = async (input, init) => {
		assert.equal(new Request(input, init).url, 'https://other.example/test');
		return Response.json({});
	};
	await taggedContextFetch('alice@example.com', transport)('https://other.example/test');
});
