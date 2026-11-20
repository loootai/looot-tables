import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { rowSchema } from '../../src/lib/workspace';
import { runOp } from '../../src/lib/server/enrich';
import { testAccess } from './access-fixture';
import { fakeLooot, hit, routed } from './looot-fixture';

/** The cell a result becomes must be storable: its meta, with the looot runs, survives the workspace schema. */
const cellSchemaCheck = (result: { value: unknown; meta?: object }) => rowSchema.parse({ id: 'r1', sheetId: 's1', order: 0, createdAt: 1, cells: { c: { v: result.value, s: 'done', t: 1, m: result.meta } } });

const access = testAccess({ keys: { looot: 'test-looot-token', openai: 'test-openai' }, model: 'test' });

test('a work email column runs the email job with fallback, keeps the address, and records who answered at what price', async (t) => {
	const { runs } = fakeLooot(t, { 'job:people.email.find': () => hit({ data: { email: 'ada@example.com' } }, {
		normalized: { fields: { email: 'ada@example.com' } },
		actualCost: 0.031,
		route: routed([{ provider: 'hunter', outcome: 'miss', chargedUsd: 0.012 }, { provider: 'prospeo', outcome: 'hit', chargedUsd: 0.019 }]),
	}) });
	const result = await runOp(access, { kind: 'email-enrichment', name: '{{Name}}', company: '', domain: '{{Website}}', profileUrl: '', prefer: 'cheapest' }, { Name: 'Ada Lovelace', Website: 'https://www.example.com/about' }, 'cell-1-0');
	assert.equal(result.error, undefined);
	assert.equal(result.value, 'ada@example.com');
	assert.equal(runs.length, 1);
	assert.deepEqual(runs[0].fallback, { enabled: true, prefer: 'cheapest' });
	assert.equal(runs[0].input.domain, 'example.com');
	assert.equal(runs[0].idempotencyKey, 'lt-cell-1-0-1', 'the cell attempt names the key');
	assert.equal(result.meta?.costUsd, 0.031);
	assert.equal(result.meta?.looot?.length, 1);
	assert.equal(result.meta?.looot?.[0].provider, 'prospeo');
	assert.deepEqual(result.meta?.looot?.[0].attempts?.map((attempt) => attempt.provider), ['hunter', 'prospeo']);
	cellSchemaCheck(result);
});

test('a work email that nobody finds is an empty cell with a reason, not an error', async (t) => {
	fakeLooot(t, { 'job:people.email.find': () => ({ outcome: 'miss', outcomeReason: 'no provider had an email', result: { data: null }, actualCost: 0.012, route: routed([{ provider: 'hunter', outcome: 'miss', chargedUsd: 0.012 }]) }) });
	const result = await runOp(access, { kind: 'email-enrichment', name: 'Nobody Here', company: '', domain: 'example.com', profileUrl: '', prefer: 'balanced' }, {});
	assert.equal(result.value, null);
	assert.equal(result.error, undefined);
	assert.equal(result.meta?.reasoning, 'No work email found');
	assert.equal(result.meta?.costUsd, 0.012, 'a provider that bills a not-found is still shown');
});

test('an email column without a name and a domain is refused before any run is paid', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => hit({}) });
	const result = await runOp(access, { kind: 'email-enrichment', name: '{{Name}}', company: '', domain: '{{Site}}', profileUrl: '', prefer: 'balanced' }, { Name: 'Ada' });
	assert.deepEqual(result.failure, { reason: 'input_invalid', retryable: false, provider: 'looot' });
	assert.equal(runs.length, 0);
});

test('verify and phone columns run their own jobs and keep the status or number', async (t) => {
	const { runs } = fakeLooot(t, {
		'job:people.email.verify': () => hit({ data: { result: 'deliverable' } }, { actualCost: 0.0003 }),
		'job:people.phone.find': () => hit({ data: { mobile_phone: '+14155550100' } }, { actualCost: 0.026 }),
	});
	const verified = await runOp(access, { kind: 'email-verify', email: '{{Email}}', prefer: 'balanced' }, { Email: 'ada@example.com' });
	assert.equal(verified.value, 'valid');
	assert.equal(verified.meta?.verification, 'valid');
	const phone = await runOp(access, { kind: 'phone-find', name: '{{Name}}', company: '', domain: '', profileUrl: '{{LinkedIn}}', prefer: 'reliable' }, { Name: 'Ada Lovelace', LinkedIn: 'https://www.linkedin.com/in/ada' });
	assert.equal(phone.value, '+14155550100');
	assert.equal(runs[1].input.linkedin_url, 'https://www.linkedin.com/in/ada');
	assert.equal(phone.meta?.costUsd, 0.026);
	const bad = await runOp(access, { kind: 'email-verify', email: 'not an email', prefer: 'balanced' }, {});
	assert.equal(bad.failure?.reason, 'input_invalid');
});

test('the any-endpoint column maps inputs from the row with their declared types, and keeps the answer or a path into it', async (t) => {
	const { runs } = fakeLooot(t, {
		'tomba-email-finder': () => hit({ data: { email: 'ada@example.com', sources: ['a', 'b'] } }, { actualCost: 0.0064, servedProviderId: 'tomba' }),
		'job:people.email.find': () => hit({ data: { email: 'grace@example.com' } }, { route: routed([{ provider: 'hunter', outcome: 'hit', chargedUsd: 0.02 }]), actualCost: 0.02 }),
	});
	const op = { kind: 'looot', endpointId: 'tomba-email-finder', inputs: { domain: '{{Website}}', limit: '{{Limit}}', tags: '{{Tag}}', company: 'Acme' }, inputTypes: { limit: 'integer', tags: 'array' }, unitCostUsd: 0.0064, path: 'data.email', prefer: 'balanced' } as const;
	const result = await runOp(access, op, { Website: 'acme.com', Limit: '5', Tag: 'vip' });
	assert.equal(result.value, 'ada@example.com');
	assert.deepEqual(runs[0].input, { domain: 'acme.com', limit: 5, tags: ['vip'], company: 'Acme' });
	assert.equal(runs[0].fallback, undefined, 'a named endpoint runs alone');
	assert.equal(result.meta?.looot?.[0].provider, 'tomba');
	assert.equal(result.meta?.costUsd, 0.0064);
	const whole = await runOp(access, { ...op, path: '' }, { Website: 'acme.com', Limit: '5', Tag: 'vip' });
	assert.equal(typeof whole.value, 'string');
	assert.deepEqual(JSON.parse(whole.value as string), { data: { email: 'ada@example.com', sources: ['a', 'b'] } });
	const list = await runOp(access, { ...op, path: 'data.sources' }, { Website: 'acme.com', Limit: '5', Tag: 'vip' });
	assert.deepEqual(list.value, ['a', 'b']);
	const job = await runOp(access, { ...op, endpointId: 'job:people.email.find', inputs: { name: '{{Name}}', domain: '{{Website}}' }, path: 'data.email', prefer: 'reliable' }, { Name: 'Grace Hopper', Website: 'acme.com' });
	assert.equal(job.value, 'grace@example.com');
	assert.deepEqual(runs.at(-1)?.fallback, { enabled: true, prefer: 'reliable' }, 'a job walks its providers in the chosen order');
	assert.equal(job.meta?.looot?.[0].provider, 'hunter');
});

test('the any-endpoint column refuses a row whose mapped inputs are all empty, and shows a miss as an empty cell', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => ({ outcome: 'miss', outcomeReason: 'nothing found', result: {}, actualCost: 0 }) });
	const op = { kind: 'looot', endpointId: 'tomba-email-finder', inputs: { domain: '{{Website}}' }, inputTypes: {}, unitCostUsd: null, path: '', prefer: 'balanced' } as const;
	const empty = await runOp(access, op, { Website: '' });
	assert.equal(empty.failure?.reason, 'input_invalid');
	assert.match(empty.error ?? '', /Every mapped input is empty/);
	assert.equal(runs.length, 0, 'nothing was sent');
	const missed = await runOp(access, op, { Website: 'acme.com' });
	assert.equal(missed.value, null);
	assert.equal(missed.error, undefined);
	assert.equal(missed.meta?.reasoning, 'nothing found');
	assert.equal(missed.meta?.looot?.[0].outcome, 'miss');
});

test('company data reads the field from whichever provider answered, and keeps the full profile for the preview', async (t) => {
	const profile = { about: { name: 'Capchase', totalEmployees: '50-200' }, descriptions: { primary: 'Capital for software.' }, locations: { headquarters: { city: { name: 'New York' } } } };
	const { runs } = fakeLooot(t, { 'job:company.enrich': () => hit(profile, { normalized: { fields: { name: 'Capchase', domain: 'capchase.com' } }, actualCost: 0.0019 }) });
	const result = await runOp(access, { kind: 'company', domain: '{{Website}}', field: 'description' }, { Website: 'https://www.capchase.com' });
	assert.equal(result.value, 'Capital for software.');
	assert.equal(runs[0].input.domain, 'capchase.com');
	assert.equal(result.meta?.companyIntel?.domain, 'capchase.com');
	assert.equal(result.meta?.companyIntel?.source, 'brand');
	assert.equal(result.meta?.costUsd, 0.0019);
	const city = await runOp(access, { kind: 'company', domain: 'capchase.com', field: 'city' }, {});
	assert.equal(city.value, 'New York');
	const missing = await runOp(access, { kind: 'company', domain: 'capchase.com', field: 'ticker' }, {});
	assert.equal(missing.value, null);
	assert.match(missing.meta?.reasoning ?? '', /no such field/);
	const funding = await runOp(access, { kind: 'company', domain: 'capchase.com', field: 'funding_total' }, {});
	assert.equal(funding.value, null);
	assert.match(funding.meta?.reasoning ?? '', /no funding data/);
	assert.equal(funding.meta?.companyIntel?.source, 'company-search');
});

test('a company named by the row is resolved to a domain through a web search first', async (t) => {
	const { runs } = fakeLooot(t, {
		'job:web.search': () => hit({ results: [{ url: 'https://www.linkedin.com/company/spend-labs', title: 'LinkedIn' }, { url: 'https://spendlabs.example/about', title: 'Spend Labs' }] }, { actualCost: 0 }),
		'job:company.enrich': () => hit({ about: { name: 'Spend Labs' } }, { normalized: { fields: { name: 'Spend Labs' } }, actualCost: 0.0019 }),
	});
	const result = await runOp(access, { kind: 'company', domain: '{{Company}}', field: 'title' }, { Company: 'Spend Labs' });
	assert.equal(result.value, 'Spend Labs');
	assert.deepEqual(runs.map((run) => run.endpointId), ['job:web.search', 'job:company.enrich']);
	assert.equal(runs[1].input.domain, 'spendlabs.example');
});

test('person data comes from the profile job for a LinkedIn URL and from the enrich job for a name and company', async (t) => {
	const { runs } = fakeLooot(t, {
		'job:linkedin.person.profile': () => hit({ data: { full_name: 'Ada Lovelace', headline: 'Mathematician', company: 'Analytical Engines', skills: ['math', 'poetry'] } }, { actualCost: 0.0015 }),
		'job:people.enrich': () => hit({ data: { full_name: 'Grace Hopper', title: 'Rear Admiral', company_name: 'US Navy', website: 'navy.example' } }, { actualCost: 0.016 }),
	});
	const byUrl = await runOp(access, { kind: 'person', profileUrl: '{{LinkedIn}}', field: 'skills' }, { LinkedIn: 'https://www.linkedin.com/in/ada' });
	assert.deepEqual(byUrl.value, ['math', 'poetry']);
	const name = await runOp(access, { kind: 'person', name: '{{Name}}', company: '{{Company}}', field: 'company_domain' }, { Name: 'Grace Hopper', Company: 'US Navy' });
	assert.equal(name.value, 'navy.example');
	assert.deepEqual(runs.map((run) => run.endpointId), ['job:linkedin.person.profile', 'job:people.enrich']);
	const thin = await runOp(access, { kind: 'person', name: 'Only A Name', field: 'title' }, {});
	assert.equal(thin.failure?.reason, 'input_invalid', 'a name alone is not enough to look anyone up');
});

test('page reads use the scrape job: markdown keeps links, passages rank by the query, and unsupported outputs say so', async (t) => {
	const markdown = '# Pricing\n\nStarter is free forever.\n\n[Docs](https://example.com/docs) and [Blog](https://example.com/blog)\n\n![Logo](https://example.com/logo.png)\n\nWrite to sales@example.com or call +1 415 555 0100 for enterprise plans.';
	const { runs } = fakeLooot(t, { 'job:web.scrape.markdown': () => hit({}, { normalized: { fields: { markdown, title: 'Pricing' } }, actualCost: 0.001 }) });
	const page = { type: 'column', column: 'URL' } as const;
	const row = { URL: 'https://example.com/pricing' };
	const md = await runOp(access, { kind: 'scrape', page, mode: 'markdown', maxChars: 2000 }, row);
	assert.ok(String(md.value).includes('(https://example.com/docs)'));
	assert.deepEqual(runs[0].input, { url: 'https://example.com/pricing' });
	const passages = await runOp(access, { kind: 'scrape', page, mode: 'highlights', query: 'enterprise sales', maxChars: 2000 }, row);
	assert.match(String(passages.value), /enterprise plans/);
	assert.ok(!String(passages.value).includes('Starter is free'));
	assert.equal((await runOp(access, { kind: 'scrape', page, mode: 'title', maxChars: 2000 }, row)).value, 'Pricing');
	assert.deepEqual((await runOp(access, { kind: 'scrape', page, mode: 'links', maxChars: 20000 }, row)).value, ['https://example.com/docs', 'https://example.com/blog']);
	assert.deepEqual((await runOp(access, { kind: 'scrape', page, mode: 'images', maxChars: 20000 }, row)).value, ['https://example.com/logo.png']);
	assert.deepEqual((await runOp(access, { kind: 'scrape', page, mode: 'emails', maxChars: 20000 }, row)).value, ['sales@example.com']);
	assert.deepEqual((await runOp(access, { kind: 'scrape', page, mode: 'phone-numbers', maxChars: 20000 }, row)).value, ['+1 415 555 0100']);
	const html = await runOp(access, { kind: 'scrape', page, mode: 'html', maxChars: 2000 }, row);
	assert.equal(html.failure?.reason, 'input_invalid');
	assert.match(html.error ?? '', /not available through looot/);
});

test('extracting fields reads the page through looot and fills the fields with the model', async (t) => {
	fakeLooot(t, { 'job:web.scrape.markdown': () => hit({}, { normalized: { fields: { markdown: 'Starter plan costs $9 per month. Free trial: no.' } }, actualCost: 0.001 }) });
	const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({ price: '$9 per month', trial: 'no' }) }], finishReason: { unified: 'stop', raw: undefined }, usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } }, warnings: [] }) as never });
	const withModel = testAccess({ keys: { looot: 'test-looot-token', openai: 'test-openai' }, model: 'test' }, { openai: () => model });
	const result = await runOp(withModel, { kind: 'scrape', page: { type: 'column', column: 'URL' }, mode: 'extract', fields: [{ name: 'price' }, { name: 'trial' }], maxChars: 2000 }, { URL: 'https://example.com/pricing' });
	assert.equal(result.error, undefined);
	assert.deepEqual(JSON.parse(String(result.value)), { price: '$9 per month', trial: 'no' });
	assert.equal(result.meta?.costUsd, 0.001);
});

test('web search keeps the first URL, title, snippet or all URLs, and names every result as a source', async (t) => {
	fakeLooot(t, { 'job:web.search': () => hit({ results: [{ url: 'https://a.example', title: 'A', snippet: 'about a' }, { url: 'https://b.example', title: 'B', snippet: 'about b' }] }, { actualCost: 0 }) });
	const search = (pick: 'url' | 'title' | 'snippet' | 'list') => runOp(access, { kind: 'search', query: '{{Company}} site', pick, numResults: 2 }, { Company: 'Acme' });
	assert.equal((await search('url')).value, 'https://a.example');
	assert.equal((await search('title')).value, 'A');
	assert.equal((await search('snippet')).value, 'about a');
	const list = await search('list');
	assert.deepEqual(list.value, ['https://a.example', 'https://b.example']);
	assert.deepEqual(list.meta?.sources, ['https://a.example', 'https://b.example']);
	assert.equal(list.meta?.costUsd, undefined, 'a free search costs nothing');
});

test('a run bills only the token it was given, and a missing token is refused before any request', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => hit({ results: [] }) });
	const without = await runOp(testAccess({ keys: { openai: 'test-openai' }, model: 'test' }), { kind: 'search', query: 'solar', pick: 'url', numResults: 1 }, {});
	assert.equal(without.failure?.reason, 'credential_missing');
	assert.equal(runs.length, 0);
	await runOp(access, { kind: 'search', query: 'solar', pick: 'url', numResults: 1 }, {});
	assert.equal(runs.length, 1);
});
