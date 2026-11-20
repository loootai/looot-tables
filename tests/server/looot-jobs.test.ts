import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Spend } from '../../src/lib/server/enrich-failure';
import { LoootClient } from '../../src/lib/server/looot';
import {
	companyFieldValue, companyHitOf, companySearch, emailStatus, findEmail, findPage, findPhone, flatten, headcount, PageNotFound, peopleSearch, personHitOf, personLookup, pickValue,
	readPage, relevantPassages, rowsOf, titleMatches, verifyEmail, webSearch, webSearchCountries,
} from '../../src/lib/server/looot-jobs';
import { fakeLooot, hit } from './looot-fixture';

const client = () => new LoootClient({ token: 'test-looot-token', spend: new Spend(), attempt: 'jobs-test' });

test('a value is found by the tail of its path, and the shallowest match wins', () => {
	const answer = { name: 'Capchase', locations: { headquarters: { city: { name: 'New York' } } }, socials: { linkedin: { url: 'https://linkedin.com/company/capchase' } } };
	assert.equal(pickValue(answer, ['name']), 'Capchase');
	assert.equal(pickValue(answer, ['socials.linkedin.url']), 'https://linkedin.com/company/capchase');
	assert.equal(pickValue(answer, ['city.name']), 'New York');
	assert.equal(pickValue(answer, ['Company_Name', 'name']), 'Capchase', 'case and underscores do not matter');
	assert.equal(pickValue(answer, ['missing']), undefined);
	assert.deepEqual(flatten({ a: [{ b: 1 }, { b: 2 }], tags: ['x', 'y'] }), { 'a.b': 1, tags: ['x', 'y'] });
});

test('list answers are found whatever the provider names the array', () => {
	assert.equal(rowsOf({ data: { companies: [{ name: 'A' }, { name: 'B' }] } }).length, 2);
	assert.equal(rowsOf({ results: [{ url: 'x' }] }).length, 1);
	assert.equal(rowsOf({ page: 0, deep: { organic: [{ link: 'x' }] } }).length, 1);
	assert.deepEqual(rowsOf({ message: 'nothing' }), []);
});

test('web search reads results from the provider shapes looot can answer with', async (t) => {
	let shape: unknown = { query: 'q', results: [{ url: 'https://a.example', title: 'A', snippet: 'about a' }, { url: 'not a url', title: 'bad' }] };
	const { runs } = fakeLooot(t, { 'job:web.search': () => hit(shape, { actualCost: 0 }) });
	const first = await webSearch(client(), 'solar companies', { numResults: 5, includeDomains: ['example.com', 'example.org'], country: 'US' });
	assert.deepEqual(first.results, [{ url: 'https://a.example', title: 'A', description: 'about a' }]);
	assert.deepEqual(runs[0].input, { query: 'solar companies (site:example.com OR site:example.org)', num_results: 5, country: 'us' });
	shape = { organic_results: [{ link: 'https://b.example', title: 'B', description: 'about b' }, { link: 'https://c.example', name: 'C', content: 'about c' }] };
	const second = await webSearch(client(), 'q', { numResults: 1 });
	assert.deepEqual(second.results.map((entry) => entry.url), ['https://b.example'], 'results are capped to the ask');
	const countries = await webSearchCountries(client(), 'q', ['US', 'GB', 'US'], { numResults: 4 });
	assert.equal(runs.filter((run) => run.input.country).length, 3, 'one search per distinct country, plus the one before');
	assert.ok(countries.results.length >= 1);
});

test('a page is read through the scrape job, from looot\'s markdown field or the provider body', async (t) => {
	let answer = hit({}, { normalized: { fields: { markdown: '# Pricing\n\nStarter is free.\n\n[Docs](https://example.com/docs) and more.', title: 'Pricing' } } });
	const { runs } = fakeLooot(t, { 'job:web.scrape.markdown': () => answer });
	const page = await readPage(client(), 'https://example.com/pricing', { maxChars: 500 });
	assert.deepEqual(runs[0].input, { url: 'https://example.com/pricing' });
	assert.equal(page.title, 'Pricing');
	assert.ok(!page.text.includes('https://example.com/docs'), 'link targets are stripped from plain text');
	const markdown = await readPage(client(), 'https://example.com/pricing', { preserveMarkdown: true });
	assert.ok(markdown.text.includes('(https://example.com/docs)'));
	answer = hit({ data: { content: 'Only the provider body.', title: 'Raw' } });
	assert.equal((await readPage(client(), 'https://example.com')).text, 'Only the provider body.');
	answer = hit({ code: 200 });
	await assert.rejects(readPage(client(), 'https://example.com'), /Could not read/);
});

test('passages are the paragraphs that share the most words with the query, in page order', () => {
	const page = 'Intro about the team.\n\nPricing starts at $10 per seat on the free plan.\n\nContact sales for enterprise pricing and a free trial.\n\nFooter links.';
	assert.equal(relevantPassages(page, 'pricing free plan', 200), 'Pricing starts at $10 per seat on the free plan.\n…\nContact sales for enterprise pricing and a free trial.');
	assert.equal(relevantPassages(page, 'zzz', 40), page.slice(0, 40), 'no match keeps the start of the page');
});

test('a named page is found by common paths first, then by a site search, and a missing page is an answer', async (t) => {
	const probes: string[] = [];
	fakeLooot(t, {
		'job:web.scrape.markdown': (input) => {
			probes.push(String(input.url));
			return String(input.url).endsWith('/plans') ? hit({}, { normalized: { fields: { markdown: 'Plans and pricing '.repeat(30) } } }) : hit({}, { normalized: { fields: { markdown: '404 page not found' } } });
		},
		'job:web.search': () => hit({ results: [{ url: 'https://example.com/careers/open-roles', title: 'Jobs' }] }),
	});
	assert.equal(await findPage(client(), 'example.com', 'pricing'), 'https://example.com/plans');
	assert.deepEqual(probes, ['https://example.com/pricing', 'https://example.com/plans']);
	assert.equal(await findPage(client(), 'example.com', 'careers'), 'https://example.com/careers/open-roles');
	t.mock.restoreAll();
	fakeLooot(t, { 'job:web.scrape.markdown': () => hit({}, { normalized: { fields: { markdown: 'not found' } } }), 'job:web.search': () => hit({ results: [] }) });
	await assert.rejects(findPage(client(), 'example.com', 'pricing'), (error: unknown) => error instanceof PageNotFound && error.message === 'No pricing page found on example.com');
});

test('company search rows from any provider become one company shape, and a cursor is the next page', async (t) => {
	const tomba = { data: { companies: [
		{ name: 'Capchase', website_url: 'capchase.com', linkedin_url: 'https://linkedin.com/company/capchase', city: 'New York', state: 'New York', country: 'US', industry: 'Financial Services', description: 'Capital for recurring revenue.', founded: '2020', company_size: '51-250' },
		{ name: 'No Site', city: 'Boston' },
	] }, meta: { page: 1, pages: 3 } };
	const { runs } = fakeLooot(t, { 'job:company.search': () => hit(tomba, { actualCost: 0.0089 }) });
	const result = await companySearch(client(), { query: 'Series B fintech companies in New York', filters: { countries: ['US'], employees_min: 50 } });
	assert.equal(runs[0].input.query, 'Series B fintech companies in New York');
	assert.equal(runs[0].input.page, 1);
	assert.equal(result.next_cursor, '2');
	assert.deepEqual(result.results[0], {
		name: 'Capchase', domain: 'capchase.com', description: 'Capital for recurring revenue.', industries: ['Financial Services'],
		headquarters: { city: 'New York', region: 'New York', country_code: 'US' }, employees: { min: 51, max: 250 }, founded_year: 2020,
		funding: undefined, organization_type: null, linkedin_url: 'https://linkedin.com/company/capchase',
	});
	const last = await companySearch(client(), { query: 'q', cursor: '3' });
	assert.equal(last.next_cursor, null, 'the last page has no cursor');
	assert.equal(companyHitOf({ nothing: true }), null);
	assert.deepEqual(headcount('1,000+'), { min: 1000 });
	assert.deepEqual(headcount(42), { count: 42 });
});

test('company fields are read from a provider answer by the names providers use', () => {
	const answer = {
		about: { name: 'Capchase', industry: 'financial-services', totalEmployees: '50-200' },
		descriptions: { primary: 'Capital for software.', tagline: 'Flexible payments' },
		locations: { headquarters: { city: { name: 'New York' }, country: { name: 'United States' }, address: { raw: 'New York, United States' } } },
		socials: { linkedin: { url: 'https://linkedin.com/company/capchase' }, twitter: { url: 'https://x.com/Capchase' } },
		urls: { careers: 'https://www.capchase.com/careers' },
		assets: { logoSquare: { src: 'https://cdn.example/logo.jpg' } },
		funding_total: 240000000,
	};
	assert.equal(companyFieldValue(answer, 'title'), 'Capchase');
	assert.equal(companyFieldValue(answer, 'description'), 'Capital for software.');
	assert.equal(companyFieldValue(answer, 'slogan'), 'Flexible payments');
	assert.equal(companyFieldValue(answer, 'city'), 'New York');
	assert.equal(companyFieldValue(answer, 'country'), 'United States');
	assert.equal(companyFieldValue(answer, 'employees'), '50-200');
	assert.equal(companyFieldValue(answer, 'linkedin'), 'https://linkedin.com/company/capchase');
	assert.equal(companyFieldValue(answer, 'careers_url'), 'https://www.capchase.com/careers');
	assert.equal(companyFieldValue(answer, 'logo_url'), 'https://cdn.example/logo.jpg');
	assert.equal(companyFieldValue(answer, 'funding_total'), 240000000);
	assert.equal(companyFieldValue(answer, 'funding_stage'), null, 'a field the provider did not send is null, not a guess');
});

test('people rows from any provider become one person shape', () => {
	const person = personHitOf({ full_name: 'Miguel Fernandez Larrea', title: 'Co-founder & CEO', profile_url: 'https://www.linkedin.com/in/miguelfernandezlarrea', company_name: 'Capchase', website: 'capchase.com', country_code: 'US' });
	assert.equal(person.name, 'Miguel Fernandez Larrea');
	assert.equal(person.title, 'Co-founder & CEO');
	assert.equal(person.company, 'Capchase');
	assert.equal(person.companyDomain, 'capchase.com');
	assert.equal(person.linkedin, 'https://www.linkedin.com/in/miguelfernandezlarrea');
	assert.equal(person.location, 'US');
	assert.equal(personHitOf({ first_name: 'Ada', last_name: 'Lovelace', url: 'https://example.com/ada' }).linkedin, null, 'only LinkedIn URLs count as profiles');
	assert.equal(personHitOf({ first_name: 'Ada', last_name: 'Lovelace' }).name, 'Ada Lovelace');
});

test('a requested title matches on every word, reading VP as Vice President', () => {
	assert.equal(titleMatches('VP of Sales', 'VP of Sales'), true);
	assert.equal(titleMatches('Vice President, Sales', 'VP of Sales'), true);
	assert.equal(titleMatches('VP Sales, EMEA', 'vp sales'), true);
	assert.equal(titleMatches('VP of Marketing', 'VP of Sales'), false);
	assert.equal(titleMatches('Co-founder & CEO', 'VP of Sales'), false);
	assert.equal(titleMatches(null, 'VP of Sales'), false);
});

test('people search keeps only the people whose title fits, because some providers take no title filter', async (t) => {
	const { runs } = fakeLooot(t, { 'job:people.search': () => hit({ data: [
		{ full_name: 'Ada Lovelace', title: 'Vice President, Sales', profile_url: 'https://www.linkedin.com/in/ada', company_name: 'Acme' },
		{ full_name: 'Grace Hopper', title: 'Co-founder & CEO', profile_url: 'https://www.linkedin.com/in/grace', company_name: 'Acme' },
	] }, { actualCost: 0.002 }) });
	const result = await peopleSearch(client(), { jobTitle: 'VP of Sales', domain: 'https://www.acme.com/about', limit: 5 });
	assert.deepEqual(runs[0].input, { job_title: 'VP of Sales', domain: 'acme.com', limit: 5, page: 1 });
	assert.deepEqual(result.results.map((person) => person.name), ['Ada Lovelace']);
	assert.equal(result.returned, 2);
	assert.equal(result.next_cursor, null, 'fewer rows than the limit means no next page');
});

test('a work email is read from looot\'s field map, then the provider body, and a miss gives none', async (t) => {
	let answer = hit({}, { normalized: { fields: { email: 'ADA@example.com' } }, route: undefined });
	const { runs } = fakeLooot(t, { 'job:people.email.find': () => answer });
	const found = await findEmail(client(), { name: 'Ada Lovelace', domain: 'example.com', company: 'Example', profileUrl: 'https://www.linkedin.com/in/ada' }, { prefer: 'reliable' });
	assert.equal(found.email, 'ada@example.com');
	assert.deepEqual(runs[0].input, { name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace', domain: 'example.com', company: 'Example', linkedin_url: 'https://www.linkedin.com/in/ada' });
	assert.deepEqual((runs[0].fallback as { prefer: string }).prefer, 'reliable');
	answer = hit({ data: { person: { work_email: 'grace@example.com', email_status: 'valid' } } });
	const nested = await findEmail(client(), { name: 'Grace Hopper', domain: 'example.com' });
	assert.deepEqual([nested.email, nested.status], ['grace@example.com', 'valid']);
	answer = hit({ data: { email: 'j***@example.com' } });
	assert.equal((await findEmail(client(), { name: 'Hidden Person', domain: 'example.com' })).email, null, 'masked addresses are not emails');
	answer = { outcome: 'miss', result: { data: null }, actualCost: 0 };
	assert.equal((await findEmail(client(), { name: 'Nobody Here', domain: 'example.com' })).email, null);
});

test('email statuses are normalized to valid, invalid, catch_all, risky or unknown', async (t) => {
	for (const [raw, status] of [['deliverable', 'valid'], ['Undeliverable', 'invalid'], ['accept-all', 'catch_all'], ['risky', 'risky'], ['???', 'unknown'], ['', 'unknown']] as const) assert.equal(emailStatus(raw), status);
	fakeLooot(t, { 'job:people.email.verify': (input) => hit({ data: { result: input.email === 'a@example.com' ? 'deliverable' : 'catch-all' } }, { actualCost: 0.0003 }) });
	assert.equal((await verifyEmail(client(), 'a@example.com')).status, 'valid');
	assert.equal((await verifyEmail(client(), 'b@example.com')).status, 'catch_all');
});

test('a phone number is read from the provider answer', async (t) => {
	const { runs } = fakeLooot(t, { 'job:people.phone.find': () => hit({ data: { mobile_phone: '+14155550100' } }, { actualCost: 0.026 }) });
	const found = await findPhone(client(), { name: 'Ada Lovelace', profileUrl: 'https://www.linkedin.com/in/ada' });
	assert.equal(found.phone, '+14155550100');
	assert.equal(runs[0].input.linkedin_url, 'https://www.linkedin.com/in/ada');
});

test('a person is looked up by LinkedIn URL on the profile job, and by name and company on the enrich job', async (t) => {
	const { runs } = fakeLooot(t, {
		'job:linkedin.person.profile': () => hit({ data: { full_name: 'Ada Lovelace', headline: 'Mathematician', company: 'Analytical Engines', skills: ['math'] } }),
		'job:people.enrich': () => ({ outcome: 'miss', result: {}, actualCost: 0 }),
	});
	const byUrl = await personLookup(client(), { profileUrl: 'https://www.linkedin.com/in/ada' });
	assert.equal(byUrl.person?.name, 'Ada Lovelace');
	assert.equal(byUrl.person?.title, 'Mathematician');
	assert.deepEqual(byUrl.person?.skills, ['math']);
	const byName = await personLookup(client(), { name: 'Ada Lovelace', company: 'Analytical Engines' });
	assert.equal(byName.person, null);
	assert.deepEqual(runs.map((run) => run.endpointId), ['job:linkedin.person.profile', 'job:people.enrich']);
});
