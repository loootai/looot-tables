// A local stand-in for the looot REST API, so the whole app runs without a looot token and without spending money.
// Run: node scripts/mock-looot.mjs [--openai]   then start the app with LOOOT_API_URL=http://127.0.0.1:4546 and any
// token. --openai also starts an OpenAI-compatible model on port 4545 that drives "Find rows" for a people list.
// Shapes follow the public docs (https://api.looot.ai/llms-full.txt). Every company, person and domain is invented.
import http from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.MOCK_LOOOT_PORT ?? 4546);
/** How long one provider attempt takes, so a running cell can be watched. */
const ATTEMPT_MS = Number(process.env.MOCK_ATTEMPT_MS ?? 650);

const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Alan', 'Donald', 'Frances', 'Edsger'];
const LAST = ['Rivera', 'Okafor', 'Nakamura', 'Schmidt', 'Haddad', 'Larsen', 'Moreau', 'Costa', 'Patel', 'Kowalski', 'Ibarra', 'Novak'];
const NAMES = ['Brightledger', 'Paystream', 'Northwind Capital', 'Ledgerly', 'Fintrail', 'Quillpay', 'Harborpoint', 'Coinvale', 'Stackbank', 'Tidewater Pay', 'Meridian Lend', 'Plumb Finance'];
const INDUSTRIES = ['Payments', 'Lending', 'Banking software', 'Accounting', 'Payroll', 'Treasury'];
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
const companies = NAMES.map((name, i) => ({ name, domain: `${slug(name)}.example`, index: i }));
const personFor = (company) => ({ first: FIRST[company.index], last: LAST[company.index] });
const companyByDomain = (domain) => companies.find((c) => c.domain === String(domain ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
const hash = (text) => parseInt(createHash('sha256').update(String(text)).digest('hex').slice(0, 8), 16);

/** Each job's providers in balanced order, with what one attempt costs and how often it answers. */
const PROVIDERS = {
	'people.email.find': [['prospeo', 0.0042, 0.62, 640], ['hunter', 0.0049, 0.71, 520], ['leadmagic', 0.0061, 0.58, 880]],
	'people.email.verify': [['bounceban', 0.0019, 0.97, 410], ['zerobounce', 0.0024, 0.95, 380]],
	'people.phone.find': [['contactout', 0.021, 0.44, 1200], ['leadmagic', 0.028, 0.39, 950]],
	'company.enrich': [['dropleads', 0.00145, 0.9, 300], ['companyenrich', 0.0098, 0.95, 700]],
	'people.search': [['leadmagic', 0.00198, 0.8, 900]],
	'company.search': [['tomba', 0.0089, 0.9, 600]],
};

let balance = 25;
let runCount = 0;
let feedbackCount = 0;
const runs = new Map();
const batches = new Map();
const log = [];
const json = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => Math.round(n * 1e6) / 1e6;
const micros = (usd) => Math.round(usd * 1e6);

/** Walk a job's providers until one answers or the cap stops the route. `answers(provider, n)` decides each attempt. */
function route(job, fallback, answers) {
	const providers = [...(PROVIDERS[job] ?? [['mockco', 0, 1, 300]])];
	if (fallback?.prefer === 'cheapest') providers.sort((a, b) => a[1] - b[1]);
	if (fallback?.prefer === 'reliable') providers.sort((a, b) => b[2] - a[2]);
	if (fallback?.prefer === 'fastest') providers.sort((a, b) => a[3] - b[3]);
	const cap = typeof fallback?.maxCostUsd === 'number' ? fallback.maxCostUsd : Infinity;
	const attempts = [];
	let spent = 0, capped = false;
	for (const [n, [provider, price, , ms]] of providers.entries()) {
		if (spent + price > cap + 1e-9) { capped = true; break; }
		const outcome = answers(provider, n);
		const charged = outcome === 'hit' || outcome === 'weak' ? price : n === 0 ? 0 : round(price / 4);
		spent = round(spent + charged);
		attempts.push({ n: n + 1, provider, endpointId: `${provider}-${job.replace(/\./g, '-')}`, outcome, chargedUsd: charged, ms: ms + (hash(provider + n) % 200), status: 200, reason: outcome === 'miss' ? 'no match for this input' : null });
		if (outcome === 'hit' || outcome === 'weak' || fallback === false) break;
	}
	const served = attempts.findLast((a) => a.outcome === 'hit' || a.outcome === 'weak');
	return { attempts, spent, capped, served, outcome: served?.outcome ?? 'miss' };
}

function finish(base, job, walk, result, extra = {}) {
	balance = round(balance - walk.spent);
	const served = walk.served ?? walk.attempts.at(-1);
	return {
		...base, status: 'completed', providerResponseStatus: 'ok', outcome: walk.outcome, result, actualCost: walk.spent, estimatedCost: walk.spent,
		actualCostMicros: micros(walk.spent), servedProviderId: walk.served?.provider, servedEndpointId: walk.served?.endpointId, endpointId: served?.endpointId ?? base.endpointId,
		requestedJob: { id: job },
		route: { capped: walk.capped, outcome: walk.outcome, servedBy: walk.served?.endpointId ?? null, chargedUsd: walk.spent, skipped: [], summary: walk.attempts.map((a) => `${a.provider} ${a.outcome}`).join(' -> '), attempts: walk.attempts },
		error: null, ...extra,
	};
}

const step = (job, title, priceUsd, input, seed) => {
	const suggestionId = `ns_${createHash('sha256').update(`${job}:${seed}`).digest('hex').slice(0, 16)}`;
	return { suggestionId, job, title, priceUsd, input, run: { endpointId: `job:${job}`, input, fallback: true, suggestionId } };
};

/** One run of a job for one row's input. Deterministic per input, so a replay answers the same. */
function runJob(endpointId, input, fallback, key) {
	runCount++;
	const job = endpointId.startsWith('job:') ? endpointId.slice(4) : null;
	const base = { runId: `run_mock_${String(runCount).padStart(5, '0')}`, idempotencyKey: key, endpointId, createdAt: new Date().toISOString() };
	switch (job) {
		case 'company.search': {
			const walk = route(job, fallback, () => 'hit');
			return finish(base, job, walk, { data: { companies: companies.map((c) => ({ name: c.name, website_url: c.domain, linkedin_url: `https://linkedin.com/company/${slug(c.name)}`, city: 'New York', state: 'New York', country: 'US', industry: INDUSTRIES[c.index % INDUSTRIES.length], description: `${c.name} builds ${INDUSTRIES[c.index % INDUSTRIES.length].toLowerCase()} software for small businesses.`, founded: String(2014 + (c.index % 6)), company_size: '51-250', funding_stage: 'series_b' })) }, meta: { page: input.page ?? 1, pages: 1, total: companies.length }, success: true });
		}
		case 'people.search': {
			const company = companyByDomain(input.domain);
			const walk = route(job, fallback, () => (company ? 'hit' : 'miss'));
			if (!company) return finish(base, job, walk, { data: [] });
			const p = personFor(company);
			const row = (first, last, title) => ({ full_name: `${first} ${last}`, first_name: first, last_name: last, title, profile_url: `https://www.linkedin.com/in/${first}${last}-${company.index}`.toLowerCase(), company_name: company.name, website: company.domain, country_code: 'US' });
			return finish(base, job, walk, { data: [row('Casey', `Founder${company.index}`, 'Co-founder & CEO'), row(p.first, p.last, 'VP of Sales'), row('Robin', `Ops${company.index}`, 'Head of Operations')], returned_count: 3, resolved_company_domain: company.domain });
		}
		case 'people.email.find': {
			const company = companyByDomain(input.domain);
			const idx = company?.index ?? hash(input.domain) % 12;
			const first = String(input.first_name ?? String(input.name ?? '').split(' ')[0] ?? '').toLowerCase();
			const last = String(input.last_name ?? String(input.name ?? '').split(' ').slice(1).join('') ?? '').toLowerCase();
			const email = `${first}${last ? `.${last}` : ''}@${input.domain}`;
			// Every fifth company has nobody findable; every third needs the second provider.
			const walk = route(job, fallback, (provider, n) => (idx % 5 === 4 ? 'miss' : idx % 3 === 0 && n === 0 ? 'miss' : 'hit'));
			if (walk.outcome === 'miss') return finish(base, job, walk, { data: null }, { outcomeReason: 'No provider had an email for this person.' });
			const nextSteps = [step('people.email.verify', 'Verify email', 0.0019, { email }, email), step('people.phone.find', 'Find phone', 0.021, { first_name: input.first_name, last_name: input.last_name, domain: input.domain }, `${email}:phone`)];
			return finish(base, job, walk, { data: { email, status: 'found' } }, { normalized: { job, fields: { email }, verdict: 'hit' }, nextSteps });
		}
		case 'people.email.verify': {
			const email = String(input.email ?? '');
			const h = hash(email) % 10;
			const status = h < 6 ? 'valid' : h < 8 ? 'catch_all' : h < 9 ? 'risky' : 'invalid';
			const walk = route(job, fallback, () => (status === 'valid' ? 'hit' : 'weak'));
			return finish(base, job, walk, { data: { email, status } }, { normalized: { job, fields: { email, status }, verdict: walk.outcome } });
		}
		case 'people.phone.find': {
			const h = hash(JSON.stringify(input)) % 3;
			const walk = route(job, fallback, (provider, n) => (h === 0 ? 'miss' : n === 0 && h === 1 ? 'miss' : 'hit'));
			if (walk.outcome === 'miss') return finish(base, job, walk, { data: null });
			const phone = `+1 212 555 0${String(100 + (hash(JSON.stringify(input)) % 899)).padStart(3, '0')}`;
			return finish(base, job, walk, { data: { phone } }, { normalized: { job, fields: { phone }, verdict: 'hit' } });
		}
		case 'company.enrich': {
			const company = companyByDomain(input.domain);
			const walk = route(job, fallback, (provider, n) => (!company ? 'miss' : company.index % 4 === 1 && n === 0 ? 'miss' : 'hit'));
			if (!company) return finish(base, job, walk, { data: null });
			const fields = { name: company.name, domain: company.domain, industry: INDUSTRIES[company.index % INDUSTRIES.length], employees: 80 + company.index * 23, city: 'New York', country: 'US', founded: 2014 + (company.index % 6), funding_total: (18 + company.index * 7) * 1e6, funding_stage: 'Series B', description: `${company.name} builds ${INDUSTRIES[company.index % INDUSTRIES.length].toLowerCase()} software for small businesses.`, linkedin_url: `https://linkedin.com/company/${slug(company.name)}` };
			const nextSteps = [step('people.search', 'Find decision makers', 0.004, { domain: company.domain, job_title: 'VP of Sales' }, company.domain), step('company.technographics', 'Tech stack', 0.012, { domain: company.domain }, `${company.domain}:tech`)];
			return finish(base, job, walk, { data: fields }, { normalized: { job, fields, verdict: 'hit' }, nextSteps });
		}
		default: {
			if (endpointId === 'mock-company-enrich') {
				const company = companyByDomain(input.domain);
				return finish(base, 'company.enrich', { attempts: [{ n: 1, provider: 'mockco', endpointId, outcome: 'hit', chargedUsd: 0.0019, ms: 300 }], spent: 0.0019, capped: false, served: { provider: 'mockco', endpointId }, outcome: 'hit' }, { data: { name: company?.name ?? null, employees: 80 + (company?.index ?? 0) * 11, domain: input.domain } });
			}
			return finish(base, job ?? endpointId, { attempts: [{ n: 1, provider: 'mockco', endpointId, outcome: 'hit', chargedUsd: 0, ms: 200 }], spent: 0, capped: false, served: { provider: 'mockco', endpointId }, outcome: 'hit' }, { results: [] });
		}
	}
}

/** One run, replayed for free when its idempotency key comes back. */
async function runOnce(endpointId, input, fallback, key, delay = true) {
	const known = runs.get(key);
	if (known) return { ...known, replayed: true };
	const run = runJob(endpointId, input, fallback, key);
	if (delay) await sleep(ATTEMPT_MS * (run.route?.attempts?.length ?? 1));
	runs.set(key, run);
	return run;
}

const BATCH_JOBS = new Set(['job:people.email.find', 'job:people.email.verify', 'job:people.phone.find', 'job:company.enrich']);

/** A batch settles about two thirds of its rows on the first call and the rest when the same key is sent again. */
async function batch(request) {
	const { endpointId, rows, idempotencyKey: key, input: shared = {}, fallback } = request;
	if (!BATCH_JOBS.has(endpointId)) return [400, { error: { code: 'validation_error', message: `rows is not supported for ${endpointId}` } }];
	if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) return [400, { error: { code: 'validation_error', message: 'rows must hold 1 to 500 objects' } }];
	const job = endpointId.slice(4);
	const top = (PROVIDERS[job] ?? []).reduce((sum, [, price]) => sum + price, 0);
	const perRow = typeof fallback?.maxCostUsd === 'number' ? Math.min(top, fallback.maxCostUsd) : top;
	if (request.quoteOnly) return [200, { quoteOnly: true, endpointId, rows: rows.length, quote: { maxCostUsd: round(perRow * rows.length), maxCostMicros: micros(perRow * rows.length), perRowMaxUsd: round(perRow) } }];
	const state = batches.get(key) ?? { calls: 0 };
	state.calls++;
	batches.set(key, state);
	const limit = state.calls === 1 ? Math.ceil(rows.length * 0.66) : rows.length;
	const answers = [];
	for (const [index, row] of rows.entries()) {
		const rowKey = `${key}:row:${index}`;
		if (index >= limit && !runs.has(rowKey)) { answers.push({ index, status: 'running', outcome: 'pending', runId: null }); continue; }
		answers.push({ index, ...(await runOnce(endpointId, { ...shared, ...row }, fallback ?? true, rowKey, false)) });
	}
	await sleep(ATTEMPT_MS * 2);
	const settled = answers.filter((a) => a.status === 'completed');
	const by = (outcome) => settled.filter((a) => a.outcome === outcome).length;
	const byProvider = {};
	for (const a of settled) if (a.servedProviderId) byProvider[a.servedProviderId] = (byProvider[a.servedProviderId] ?? 0) + 1;
	const charged = settled.filter((a) => !a.replayed).reduce((sum, a) => sum + (a.actualCost ?? 0), 0);
	return [201, { batch: { idempotencyKey: key, complete: settled.length === rows.length, rows: rows.length, settled: settled.length }, rows: answers, summary: { hits: by('hit'), strongHits: by('hit'), weak: by('weak'), misses: by('miss'), retryLater: rows.length - settled.length, chargedMicros: micros(charged), byProvider } }];
}

/** Catalog rows for a job, with the measured numbers a column header shows. */
function jobRows(job) {
	return (PROVIDERS[job] ?? []).map(([provider, price, rate, p50Ms]) => ({ endpointId: `${provider}-${job.replace(/\./g, '-')}`, provider, name: `${provider} / ${job}`, capability: job, category: 'enrichment', access: 'runs_now', estimatedPrice: price, costPerSuccessUsd: round(price / rate), works: { rate, runs: 1200, p50Ms, thin: false }, job: { id: job, title: job } }));
}

http.createServer((req, res) => {
	let body = '';
	req.on('data', (chunk) => (body += chunk));
	req.on('end', async () => {
		const url = new URL(req.url, 'http://x');
		if (url.pathname === '/__log') return json(res, 200, { runs: log, balance, feedback: feedbackCount });
		if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) return json(res, 401, { error: { code: 'unauthorized', message: 'Valid bearer token required' } });
		if (url.pathname === '/v1/balance') return json(res, 200, { available: balance, reserved: 0, topUpUrl: 'https://looot.ai/usage' });
		if (url.pathname === '/v1/catalog/search') {
			const capability = url.searchParams.get('capability');
			if (capability) return json(res, 200, { query: url.searchParams.get('q'), prefer: url.searchParams.get('prefer') ?? 'balanced', total: jobRows(capability).length, endpoints: jobRows(capability) });
			return json(res, 200, { query: url.searchParams.get('q'), total: 3, endpoints: [
				{ endpointId: 'mock-company-enrich', provider: 'MockCo', name: 'MockCo / Enrich a company from its domain', category: 'enrichment', access: 'runs_now', estimatedPrice: 0.0019, costPerSuccessUsd: 0.0021, works: { rate: 0.91, runs: 840, p50Ms: 420, thin: false }, job: { id: 'company.enrich', title: 'Enrich a company' } },
				{ endpointId: 'mock-company-news', provider: 'MockCo', name: 'MockCo / Recent news about a company', category: 'search', access: 'runs_now', estimatedPrice: 0.01, costPerSuccessUsd: 0.014, works: { rate: 0.71, runs: 96, p50Ms: 1900, thin: false }, job: { id: 'company.news', title: 'Company news' } },
				{ endpointId: 'mock-company-filings', provider: 'MockCo', name: 'MockCo / Company filings', category: 'finance', access: 'coming_soon', estimatedPrice: 0.02, job: { id: 'company.filings', title: 'Company filings' } },
			] });
		}
		if (url.pathname.startsWith('/v1/operations/')) {
			return json(res, 200, { endpoint: { id: decodeURIComponent(url.pathname.split('/').pop()) }, estimatedMaxCost: 0.0019, inputSchema: { type: 'object', properties: { domain: { type: 'string', description: 'Company website domain' }, include_funding: { type: 'boolean', description: 'Add funding data' } }, required: ['domain'] } });
		}
		if (url.pathname === '/v1/feedback' && req.method === 'POST') {
			feedbackCount++;
			log.push({ feedback: JSON.parse(body || '{}') });
			return json(res, 201, { feedbackId: `fb_mock_${feedbackCount}`, status: 'new' });
		}
		if (url.pathname.startsWith('/v1/runs/') && req.method === 'GET') {
			const run = [...runs.values()].find((entry) => entry.runId === decodeURIComponent(url.pathname.split('/').pop()));
			return run ? json(res, 200, run) : json(res, 404, { error: { code: 'not_found', message: 'No such run' } });
		}
		if (url.pathname === '/v1/runs' && req.method === 'POST') {
			const request = JSON.parse(body || '{}');
			log.push({ endpointId: request.endpointId, key: request.idempotencyKey, fallback: request.fallback ?? null, rows: request.rows?.length, quoteOnly: request.quoteOnly ?? false, suggestionId: request.suggestionId });
			if (request.rows) { const [status, answer] = await batch(request); return json(res, status, answer); }
			return json(res, 201, await runOnce(request.endpointId, request.input ?? {}, request.fallback, request.idempotencyKey));
		}
		return json(res, 404, { error: { code: 'not_found', message: `mock: ${url.pathname}` } });
	});
}).listen(PORT, '127.0.0.1', () => console.log(`mock looot on http://127.0.0.1:${PORT}`));

/* ───────────── OpenAI-compatible model for "Find rows" ───────────── */

if (process.argv.includes('--openai')) {
	http.createServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			if (req.url?.endsWith('/models')) return json(res, 200, { object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
			if (!req.url?.includes('/chat/completions')) return json(res, 404, { error: { message: `mock: ${req.url}` } });
			const request = JSON.parse(body || '{}');
			const tools = (request.tools ?? []).map((tool) => tool.function.name);
			const messages = request.messages ?? [];
			const toolMessages = messages.filter((m) => m.role === 'tool');
			const completion = (message, finishReason = 'stop') => json(res, 200, { id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: 0, model: 'mock-model', choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
			const call = (name, args, i = 0) => ({ id: `call_${Date.now()}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
			if (tools.includes('searchPeople')) {
				if (!toolMessages.length) return completion({ role: 'assistant', content: null, tool_calls: [call('findCompanies', { query: 'Series B fintech companies in New York' })] }, 'tool_calls');
				if (toolMessages.length === 1) {
					let found = [];
					try { found = JSON.parse(toolMessages[0].content).companies ?? []; } catch { /* nothing */ }
					return completion({ role: 'assistant', content: null, tool_calls: found.map((c, i) => call('searchPeople', { job_title: 'VP of Sales', domain: c.domain, limit: 10 }, i)) }, 'tool_calls');
				}
				return completion({ role: 'assistant', content: 'Found VPs of Sales at the Series B fintech companies.' });
			}
			if (request.response_format?.type === 'json_schema') {
				const text = JSON.stringify(messages.map((m) => m.content));
				if (/discovery|list|supplied specific people/.test(text)) return completion({ role: 'assistant', content: JSON.stringify({ mode: 'discovery', people: [] }) });
			}
			return completion({ role: 'assistant', content: 'ok' });
		});
	}).listen(4545, '127.0.0.1', () => console.log('mock openai on http://127.0.0.1:4545/v1'));
}
