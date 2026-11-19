import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextClient } from '../../src/lib/server/context';
import { Spend } from '../../src/lib/server/enrich-failure';
import { lookupPerson } from '../../src/lib/server/person-lookup';

const candidate = { name: 'Theo Browne', profiles: ['https://linkedin.com/in/t3gg'], role: { company: { name: 'T3' } } };
const notFound = { request_id: 'lookup', match: { status: 'not_found', person: null, score: null } };

test('an unresolved supplied name searches and enriches the unique matching profile', async (t) => {
	const calls: string[] = [];
	const spend = new Spend();
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		calls.push(request.url);
		const body = await request.json();
		if (request.url.endsWith('/search')) return Response.json({ request_id: 'search', results: [candidate], key_metadata: { credits_consumed: 3 } });
		if (!body.social_urls) return Response.json({ ...notFound, key_metadata: { credits_consumed: 2 } });
		assert.deepEqual(body.social_urls, candidate.profiles);
		return Response.json({ request_id: 'match', match: { status: 'candidate', score: 1, person: { avatar_url: 'https://cdn.example/theo.png' } }, key_metadata: { credits_consumed: 4 } });
	});
	const response = await lookupPerson(contextClient('test', undefined, spend), { name: { first: 'Theo', last: 'Browne' }, company: { name: 'T3' } }, 'Theo Browne');
	assert.equal(response.match.status, 'candidate');
	assert.deepEqual(calls.map(url => url.split('/').at(-1)), ['enrich', 'search', 'enrich']);
	assert.equal(spend.credits, 9);
});

test('ambiguous names and wrong employers never attach a search candidate photo', async (t) => {
	for (const [index, results] of [[candidate, { ...candidate, profiles: ['https://linkedin.com/in/another'] }], [{ ...candidate, role: { company: { name: 'Other' } } }]].entries()) {
		let enrichCalls = 0;
		const mock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
			if (new Request(input).url.endsWith('/search')) return Response.json({ request_id: 'search', results });
			enrichCalls++;
			return Response.json(notFound);
		});
		const response = await lookupPerson(contextClient(`test-ambiguous-${index}`), { name: { first: 'Theo', last: 'Browne' }, company: { name: 'T3' } }, 'Theo Browne');
		assert.equal(response.match.status, 'not_found');
		assert.equal(enrichCalls, 1);
		mock.mock.restore();
	}
});
