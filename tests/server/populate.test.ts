import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foundRowKey } from '../../src/lib/found-rows';
import { populateStream } from '../../src/lib/server/populate';
import type { PopulateEvent } from '../../src/lib/types';
import { rowSchema } from '../../src/lib/workspace';
import { testAccess } from './access-fixture';

const access = testAccess({ keys: { openai: 'test-openai', context: 'test-context' }, model: 'test-model', openaiBaseUrl: 'https://model.example/v1' });

test('company discovery skips companies the sheet lists and maps funding rounds to persistable Stage cells', async (t) => {
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		if (request.url === 'https://model.example/v1/chat/completions') {
			return Response.json({
				id: 'completion-company', object: 'chat.completion', created: 0, model: 'test-model',
				choices: [{ index: 0, finish_reason: 'tool_calls', message: {
					role: 'assistant', content: null,
					tool_calls: [{ id: 'company-search', type: 'function', function: { name: 'searchCompanies', arguments: JSON.stringify({ query: 'Solar companies' }) } }],
				} }],
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			});
		}
		assert.equal(request.url, 'https://api.context.dev/v1/company/search');
		return Response.json({ results: [
			{ name: 'Already listed', domain: 'WWW.Listed.example' },
			{ name: 'Latest round only', domain: 'latest.example', funding: { stage: null, latest_round: { type: 'series_b', date: '2026-03-02', amount_usd: 25_000_000 } } },
			{ name: 'Current stage', domain: 'current.example', funding: { stage: 'series_c', latest_round: { type: 'series_b' } } },
			{ name: 'No funding', domain: 'none.example', funding: { stage: null, latest_round: null } },
		], next_cursor: null });
	});
	// The sheet sends its key column's identities; the server must recognise the same company however it is spelled.
	const stream = populateStream(access, { query: 'Solar companies', entity: 'companies', target: 3, existingKeys: [foundRowKey('https://listed.example/')] });
	const events: PopulateEvent[] = (await new Response(stream).text()).trim().split('\n').map((line) => JSON.parse(line));
	assert.deepEqual(events.filter((event) => event.type === 'error'), []);
	const rows = events.flatMap((event) => event.type === 'rows' ? event.rows : []);
	assert.deepEqual(rows.map((row) => row.Stage), ['Series B', 'Series C', null]);
	for (const [index, row] of rows.entries()) {
		rowSchema.parse({ id: `row-${index}`, sheetId: 'companies', order: index, createdAt: 1, cells: Object.fromEntries(Object.entries(row).map(([column, v]) => [column, { v, s: 'done', t: 1 }])) });
	}
});

// Run with the react-server condition so server-only imports use their server entry point.
test('the agent serializes parallel tool calls, shrinks the last web request, and skips excess searches', async (t) => {
	const requested: number[] = [];
	let active = 0;
	let maxActive = 0;
	let modelCalls = 0;
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		const body = await request.json();
		if (request.url === 'https://model.example/v1/chat/completions') {
			modelCalls++;
			return Response.json({
				id: 'completion-test', object: 'chat.completion', created: 0, model: 'test-model',
				choices: [{ index: 0, finish_reason: 'tool_calls', message: {
					role: 'assistant', content: null,
					tool_calls: Array.from({ length: 4 }, (_, i) => ({
						id: `call-${i}`, type: 'function',
						function: { name: 'searchWeb', arguments: JSON.stringify({ query: `homelab query ${i}`, numResults: 50 }) },
					})),
				} }],
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			});
		}
		assert.equal(request.url, 'https://api.context.dev/v1/web/search');
		active++;
		maxActive = Math.max(maxActive, active);
		const batch = requested.length;
		requested.push(body.numResults);
		// Yield to allow overlapping tool executions to start if they aren't locked.
		await new Promise((resolve) => setTimeout(resolve, 10));
		active--;
		return Response.json({ results: Array.from({ length: body.numResults }, (_, i) => ({
			// Five results in the second batch repeat the first batch.
			url: `https://site-${batch === 1 && i < 5 ? 0 : batch}-${i}.example`,
			title: `Site ${batch}-${i}`, description: 'Homelab networking',
		})) });
	});
	const stream = populateStream(access, { query: 'Homelab networking blogs', entity: 'websites', target: 100 });
	const events: PopulateEvent[] = (await new Response(stream).text()).trim().split('\n').map((line) => JSON.parse(line));
	assert.deepEqual(events.filter((event) => event.type === 'error'), []);
	assert.equal(maxActive, 1);
	assert.deepEqual(requested, [50, 50, 5]);
	assert.equal(modelCalls, 1);
	assert.equal(events.flatMap((event) => event.type === 'rows' ? event.rows : []).length, 100);
	assert.deepEqual(events.at(-1), { type: 'done', total: 100 });
});

test('people discovery enriches accepted profiles for inline photos without enriching excess hits', async (t) => {
	let modelCalls = 0;
	const profiles: string[][] = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		if (request.url === 'https://model.example/v1/chat/completions') {
			if (++modelCalls === 1) return Response.json({ id: 'plan', object: 'chat.completion', created: 0, model: 'test-model', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ mode: 'discovery', people: [] }) } }] });
			return Response.json({ id: 'search', object: 'chat.completion', created: 0, model: 'test-model', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'people', type: 'function', function: { name: 'searchPeople', arguments: JSON.stringify({ query: 'Founders' }) } }] } }] });
		}
		if (request.url.endsWith('/people/search')) return Response.json({ request_id: 'search', results: ['Ada Lovelace', 'Grace Hopper'].map(name => ({ name, profiles: [`https://linkedin.com/in/${name.split(' ')[0]}`], role: { title: 'Founder', company: null }, location: {}, schools: [], skills: [], description: '', years_of_experience: 3 })) });
		assert.ok(request.url.endsWith('/people/enrich'));
		profiles.push((await request.json()).social_urls);
		return Response.json({ request_id: 'enrich', match: { status: 'candidate', person: { avatar_url: 'https://cdn.example/ada.png' } } });
	});
	const events: PopulateEvent[] = (await new Response(populateStream(access, { query: 'Find founders', entity: 'people', target: 1 })).text()).trim().split('\n').map(line => JSON.parse(line));
	assert.deepEqual(events.filter(e => e.type === 'error'), []);
	assert.deepEqual(profiles, [['https://linkedin.com/in/Ada']]);
	assert.equal(events.flatMap(e => e.type === 'rows' ? e.rows : [])[0]['Profile photo'], 'https://cdn.example/ada.png');
});
