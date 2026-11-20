import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foundRowKey } from '../../src/lib/found-rows';
import { populateStream } from '../../src/lib/server/populate';
import type { PopulateEvent } from '../../src/lib/types';
import { rowSchema } from '../../src/lib/workspace';
import { testAccess } from './access-fixture';

const access = testAccess({ keys: { openai: 'test-openai', looot: 'test-looot' }, model: 'test-model', openaiBaseUrl: 'https://model.example/v1' });
const MODEL = 'https://model.example/v1/chat/completions';
const usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 };
const toolCalls = (calls: Array<{ name: string; args: object }>) => Response.json({
	id: 'completion-test', object: 'chat.completion', created: 0, model: 'test-model', usage,
	choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls.map((call, i) => ({ id: `call-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }],
});
const text = (content: string) => Response.json({ id: 'plan', object: 'chat.completion', created: 0, model: 'test-model', usage, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
const lootRun = (result: unknown, n: number) => Response.json({ runId: `run_${n}`, status: 'completed', outcome: 'hit', result, actualCost: 0.001 }, { status: 201 });

test('company discovery skips companies the sheet lists and maps funding stages to persistable Stage cells', async (t) => {
	let searches = 0;
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		if (request.url === MODEL) return toolCalls([{ name: 'searchCompanies', args: { query: 'Solar companies' } }]);
		const body = await request.json();
		assert.equal(body.endpointId, 'job:company.search');
		assert.equal(body.input.query, 'Solar companies');
		searches++;
		return lootRun({ data: { companies: [
			{ name: 'Already listed', website_url: 'WWW.Listed.example' },
			{ name: 'Series B Co', website_url: 'latest.example', funding_stage: 'series_b' },
			{ name: 'Series C Co', website_url: 'current.example', funding_stage: 'series_c' },
			{ name: 'No funding', website_url: 'none.example' },
		] }, meta: { page: 1, pages: 1 } }, searches);
	});
	// The sheet sends its key column's identities; the server must recognise the same company however it is spelled.
	const stream = populateStream(access, { query: 'Solar companies', entity: 'companies', target: 3, existingKeys: [foundRowKey('https://listed.example/')] });
	const events: PopulateEvent[] = (await new Response(stream).text()).trim().split('\n').map((line) => JSON.parse(line));
	assert.deepEqual(events.filter((event) => event.type === 'error'), []);
	const rows = events.flatMap((event) => event.type === 'rows' ? event.rows : []);
	assert.deepEqual(rows.map((row) => row.Stage), ['Series B', 'Series C', null]);
	assert.deepEqual(rows.map((row) => row.Domain), ['latest.example', 'current.example', 'none.example']);
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
		if (request.url === MODEL) {
			modelCalls++;
			return toolCalls(Array.from({ length: 4 }, (_, i) => ({ name: 'searchWeb', args: { query: `homelab query ${i}`, numResults: 50 } })));
		}
		assert.equal(body.endpointId, 'job:web.search');
		active++;
		maxActive = Math.max(maxActive, active);
		const batch = requested.length;
		requested.push(body.input.num_results);
		// Yield to allow overlapping tool executions to start if they aren't locked.
		await new Promise((resolve) => setTimeout(resolve, 10));
		active--;
		return lootRun({ results: Array.from({ length: body.input.num_results }, (_, i) => ({
			// Five results in the second batch repeat the first batch.
			url: `https://site-${batch === 1 && i < 5 ? 0 : batch}-${i}.example`,
			title: `Site ${batch}-${i}`, snippet: 'Homelab networking',
		})) }, batch);
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

test('people discovery searches per company and keeps only people whose title fits, without adding excess hits', async (t) => {
	let modelCalls = 0;
	const searches: Array<Record<string, unknown>> = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		if (request.url === MODEL) {
			if (++modelCalls === 1) return text(JSON.stringify({ mode: 'discovery', people: [] }));
			return toolCalls([{ name: 'searchPeople', args: { job_title: 'VP of Sales', domain: 'acme.example', limit: 10 } }]);
		}
		const body = await request.json();
		assert.equal(body.endpointId, 'job:people.search');
		searches.push(body.input);
		return lootRun({ data: [
			{ full_name: 'Carol CEO', title: 'Co-founder & CEO', profile_url: 'https://www.linkedin.com/in/carol', company_name: 'Acme', website: 'acme.example' },
			{ full_name: 'Ada Lovelace', title: 'Vice President, Sales', profile_url: 'https://www.linkedin.com/in/ada', company_name: 'Acme', website: 'acme.example', country_code: 'US' },
			{ full_name: 'Grace Hopper', title: 'VP Sales EMEA', profile_url: 'https://www.linkedin.com/in/grace', company_name: 'Acme', website: 'acme.example' },
		] }, searches.length);
	});
	const events: PopulateEvent[] = (await new Response(populateStream(access, { query: 'VPs of Sales at Acme', entity: 'people', target: 1 })).text()).trim().split('\n').map(line => JSON.parse(line));
	assert.deepEqual(events.filter(e => e.type === 'error'), []);
	assert.deepEqual(searches[0], { job_title: 'VP of Sales', domain: 'acme.example', limit: 10, page: 1 });
	const rows = events.flatMap(e => e.type === 'rows' ? e.rows : []);
	assert.equal(rows.length, 1, 'one person was asked for');
	assert.equal(rows[0].Name, 'Ada Lovelace');
	assert.equal(rows[0].Title, 'Vice President, Sales');
	assert.equal(rows[0].LinkedIn, 'https://www.linkedin.com/in/ada');
	assert.equal(rows[0]['Company domain'], 'acme.example');
});

test('people discovery can find companies first, which add nothing to the sheet', async (t) => {
	let modelCalls = 0;
	const jobs: string[] = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		if (request.url === MODEL) {
			modelCalls++;
			if (modelCalls === 1) return text(JSON.stringify({ mode: 'discovery', people: [] }));
			if (modelCalls === 2) return toolCalls([{ name: 'findCompanies', args: { query: 'Series B fintech companies in New York' } }]);
			if (modelCalls === 3) return toolCalls([{ name: 'searchPeople', args: { job_title: 'VP of Sales', domain: 'capchase.com' } }]);
			throw new Error('unexpected model call');
		}
		const body = await request.json();
		jobs.push(body.endpointId);
		if (body.endpointId === 'job:company.search') return lootRun({ data: { companies: [{ name: 'Capchase', website_url: 'capchase.com', funding_stage: 'series_b' }] }, meta: { page: 1, pages: 1 } }, jobs.length);
		return lootRun({ data: [{ full_name: 'Ada Lovelace', title: 'VP of Sales', profile_url: 'https://www.linkedin.com/in/ada', company_name: 'Capchase', website: 'capchase.com' }] }, jobs.length);
	});
	const events: PopulateEvent[] = (await new Response(populateStream(access, { query: 'VP of Sales at Series B fintech companies in New York', entity: 'people', target: 1 })).text()).trim().split('\n').map(line => JSON.parse(line));
	assert.deepEqual(events.filter(e => e.type === 'error'), []);
	assert.deepEqual(jobs, ['job:company.search', 'job:people.search']);
	assert.deepEqual(events.flatMap(e => e.type === 'rows' ? e.rows : []).map(row => row.Name), ['Ada Lovelace']);
});
