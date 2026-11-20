// A local stand-in for the looot REST API, so the whole app runs without a looot token and without spending money.
// Run: node scripts/mock-looot.mjs [--openai]   then start the app with LOOOT_API_URL=http://127.0.0.1:4546 and any
// token. --openai also starts an OpenAI-compatible model on port 4545 that drives "Find rows" for a people list.
// Shapes follow the public docs (https://api.looot.ai/llms-full.txt). Company names and domains are real public
// companies so screenshots read naturally; every other value (people, emails, phones, headcount, funding) is invented.
import http from 'node:http';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.MOCK_LOOOT_PORT ?? 4546);
/** How long one provider attempt takes, so a running cell can be watched. */
const ATTEMPT_MS = Number(process.env.MOCK_ATTEMPT_MS ?? 650);

// Ten real companies (names, domains, HQ city) with one fictional contact each; the people and every number below are
// made up for screenshots. Headcount and funding are rough round figures, not checked facts.
const COMPANIES = [
	['Stripe', 'stripe.com', 'Payments', 'San Francisco', 8000, 9.4e9, 'Maya Rios', 'Head of RevOps'],
	['Linear', 'linear.app', 'Developer tools', 'San Francisco', 150, 134e6, 'Marcus Bell', 'VP Engineering'],
	['Vercel', 'vercel.com', 'Developer tools', 'San Francisco', 700, 563e6, 'Yuki Tanaka', 'Growth Marketing Lead'],
	['Notion', 'notion.so', 'Productivity', 'San Francisco', 900, 343e6, 'Arjun Mehta', 'Director of Sales Ops'],
	['Figma', 'figma.com', 'Design software', 'San Francisco', 1600, 333e6, 'Ingrid Larsen', 'Chief Revenue Officer'],
	['Datadog', 'datadoghq.com', 'Observability', 'New York', 6500, 148e6, 'Owen Fletcher', 'Account Executive'],
	['Retool', 'retool.com', 'Developer tools', 'San Francisco', 400, 141e6, 'Amara Okafor', 'Head of Partnerships'],
	['Intercom', 'intercom.com', 'Customer service', 'San Francisco', 1000, 241e6, 'Omar Haddad', 'Director of Demand Gen'],
	['Supabase', 'supabase.com', 'Developer tools', 'San Francisco', 150, 396e6, 'Dewi Pratama', 'Product Marketing Manager'], // leak-scan:allow a company domain in demo data, not a Supabase project host
	['Airtable', 'airtable.com', 'Productivity', 'San Francisco', 800, 1.4e9, 'Claire Donovan', 'VP Customer Success'],
];
const INDUSTRIES = COMPANIES.map(([, , industry]) => industry);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
const companies = COMPANIES.map(([name, domain, , city, employees, funding, contact, role], i) => ({ name, domain, city, employees, funding, contact, role, index: i }));
const companyByDomain = (domain) => companies.find((c) => c.domain === String(domain ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
const hash = (text) => parseInt(createHash('sha256').update(String(text)).digest('hex').slice(0, 8), 16);

/** Each job's providers in balanced order, with what one attempt costs and how often it answers. */
const PROVIDERS = {
	'people.email.find': [['prospeo', 0.0042, 0.62, 640], ['hunter', 0.0049, 0.71, 520], ['apollo', 0.0061, 0.58, 880]],
	'people.email.verify': [['bounceban', 0.0019, 0.97, 410], ['zerobounce', 0.0024, 0.95, 380]],
	'people.phone.find': [['contactout', 0.021, 0.44, 1200], ['quickenrich', 0.028, 0.39, 950]],
	'company.enrich': [['apollo', 0.00145, 0.9, 300], ['companyenrich', 0.0098, 0.95, 700]],
	'people.search': [['apollo', 0.00198, 0.8, 900]],
	'web.search': [['serper', 0.001, 0.98, 700]],
	'web.scrape.markdown': [['firecrawl', 0.002, 0.95, 1100]],
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
		// Like the email and phone finders behind looot, a miss bills nothing; only an answer is charged.
		const charged = outcome === 'hit' || outcome === 'weak' ? price : 0;
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
			return finish(base, job, walk, { data: { companies: companies.map((c) => ({ name: c.name, website_url: c.domain, linkedin_url: `https://linkedin.com/company/${slug(c.name)}`, city: c.city, state: c.city === 'New York' ? 'New York' : 'California', country: 'US', industry: INDUSTRIES[c.index], description: `${c.name}: ${INDUSTRIES[c.index].toLowerCase()}.`, company_size: '51-250', funding_stage: 'series_b' })) }, meta: { page: input.page ?? 1, pages: 1, total: companies.length }, success: true });
		}
		case 'people.search': {
			const company = companyByDomain(input.domain);
			const walk = route(job, fallback, () => (company ? 'hit' : 'miss'));
			if (!company) return finish(base, job, walk, { data: [] });
			const [first, ...rest] = company.contact.split(' ');
			const row = { full_name: company.contact, first_name: first, last_name: rest.join(' '), title: input.job_title ? String(input.job_title) : company.role, profile_url: `https://www.linkedin.com/in/${slug(company.contact)}-example`, company_name: company.name, website: company.domain, country_code: 'US' };
			return finish(base, job, walk, { data: [row], returned_count: 1, resolved_company_domain: company.domain });
		}
		case 'people.email.find': {
			const company = companyByDomain(input.domain);
			const idx = company?.index ?? hash(input.domain) % 12;
			const first = String(input.first_name ?? String(input.name ?? '').split(' ')[0] ?? '').toLowerCase();
			const last = String(input.last_name ?? String(input.name ?? '').split(' ').slice(1).join('') ?? '').toLowerCase();
			const email = `${first}${last ? `.${last}` : ''}@${input.domain}`;
			// Every fifth company has nobody findable; otherwise the first, second or third provider answers, by company.
			const walk = route(job, fallback, (provider, n) => (idx % 5 === 4 ? 'miss' : n < idx % 3 ? 'miss' : 'hit'));
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
			const company = companyByDomain(input.domain);
			const h = company ? (company.index % 4 === 3 ? 0 : company.index % 2 === 0 ? 2 : 1) : hash(JSON.stringify(input)) % 3;
			const walk = route(job, fallback, (provider, n) => (h === 0 ? 'miss' : n === 0 && h === 1 ? 'miss' : 'hit'));
			if (walk.outcome === 'miss') return finish(base, job, walk, { data: null });
			const phone = `+1 212 555 0${String(100 + (hash(JSON.stringify(input)) % 899)).padStart(3, '0')}`;
			return finish(base, job, walk, { data: { phone } }, { normalized: { job, fields: { phone }, verdict: 'hit' } });
		}
		case 'company.enrich': {
			const company = companyByDomain(input.domain);
			const walk = route(job, fallback, () => (!company || company.index === 5 ? 'miss' : 'hit'));
			if (!company) return finish(base, job, walk, { data: null });
			const fields = { name: company.name, domain: company.domain, industry: INDUSTRIES[company.index], employees: company.employees, city: company.city, country: 'US', funding_total: company.funding, description: `${company.name}: ${INDUSTRIES[company.index].toLowerCase()}.`, linkedin_url: `https://linkedin.com/company/${slug(company.name)}` };
			const nextSteps = [step('people.search', 'Find decision makers', 0.004, { domain: company.domain, job_title: 'VP of Sales' }, company.domain), step('company.technographics', 'Tech stack', 0.012, { domain: company.domain }, `${company.domain}:tech`)];
			return finish(base, job, walk, { data: fields }, { normalized: { job, fields, verdict: 'hit' }, nextSteps });
		}
		case 'web.search': {
			const company = companies.find((c) => String(input.query ?? '').toLowerCase().includes(c.domain) || String(input.query ?? '').toLowerCase().includes(c.name.toLowerCase()));
			const walk = route(job, fallback, () => (company ? 'hit' : 'miss'));
			if (!company) return finish(base, job, walk, { data: [] });
			return finish(base, job, walk, { data: [
				{ url: `https://${company.domain}/pricing`, title: `Pricing | ${company.name}`, snippet: `Compare ${company.name} plans and prices.` },
				{ url: `https://${company.domain}/`, title: company.name, snippet: `${company.name} home page.` },
			] });
		}
		case 'web.scrape.markdown': {
			const company = companyByDomain(String(input.url ?? '').replace(/^https?:\/\//, ''));
			const walk = route(job, fallback, () => (company ? 'hit' : 'miss'));
			return finish(base, job, walk, { data: { url: input.url, title: company ? `Pricing | ${company.name}` : 'Page', markdown: company ? `# ${company.name} pricing\n\nFree, Pro and Enterprise plans, billed monthly or yearly.` : '' } });
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
			if (tools.includes('quote_run')) return agentTurn(request, res);
			if (tools.includes('searchPeople')) {
				if (!toolMessages.length) return completion({ role: 'assistant', content: null, tool_calls: [call('findCompanies', { query: 'Developer-tools and SaaS companies in the US' })] }, 'tool_calls');
				if (toolMessages.length === 1) {
					let found = [];
					try { found = JSON.parse(toolMessages[0].content).companies ?? []; } catch { /* nothing */ }
					return completion({ role: 'assistant', content: null, tool_calls: found.map((c, i) => call('searchPeople', { job_title: companyByDomain(c.domain)?.role ?? 'VP of Sales', domain: c.domain, limit: 10 }, i)) }, 'tool_calls');
				}
				return completion({ role: 'assistant', content: 'Found revenue and growth leaders at developer-tools and SaaS companies.' });
			}
			// An AI column with web research: search, read the pricing page, then answer with that page as the source.
			if (tools.includes('searchWeb')) {
				const text = JSON.stringify(messages.map((m) => m.content));
				const domain = text.match(/Website:\s*([a-z0-9.-]+\.[a-z]{2,})/i)?.[1] ?? companies.find((c) => text.includes(c.domain))?.domain ?? 'example.com';
				if (!toolMessages.length) return completion({ role: 'assistant', content: null, tool_calls: [call('searchWeb', { query: `${domain} pricing` })] }, 'tool_calls');
				if (toolMessages.length === 1) return completion({ role: 'assistant', content: null, tool_calls: [call('readPage', { url: `https://${domain}/pricing`, focus: 'plans and prices' })] }, 'tool_calls');
				const valueType = request.response_format?.json_schema?.schema?.properties?.value?.type;
				const boolean = (Array.isArray(valueType) ? valueType : [valueType]).includes('boolean');
				return completion({ role: 'assistant', content: JSON.stringify({ value: boolean ? true : `Yes: ${domain}/pricing`, confidence: 0.94, sources: [`https://${domain}/pricing`] }) });
			}
			if (request.response_format?.type === 'json_schema') {
				const text = JSON.stringify(messages.map((m) => m.content));
				if (/discovery|list|supplied specific people/.test(text)) return completion({ role: 'assistant', content: JSON.stringify({ mode: 'discovery', people: [] }) });
			}
			return completion({ role: 'assistant', content: 'ok' });
		});
	}).listen(Number(process.env.MOCK_OPENAI_PORT ?? 4545), '127.0.0.1', () => console.log(`mock openai on http://127.0.0.1:${process.env.MOCK_OPENAI_PORT ?? 4545}/v1`));
}

/* ───────────── The in-app agent, scripted ─────────────
   A fixed conversation for the agent panel's tests and screenshots: find people, add a verified email column, try 5
   rows, run the rest. It answers like a model would, from the tool results it is sent, and streams when asked to. */

const textOf = (content) => typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '';

function agentPlan(request) {
	const messages = request.messages ?? [];
	const sheetId = /sheetId ([A-Za-z0-9_-]+)\)/.exec(textOf(messages.find((m) => m.role === 'system')?.content))?.[1] ?? 'sheet';
	const lastUser = messages.findLastIndex((m) => m.role === 'user');
	const said = textOf(messages[lastUser]?.content);
	const calls = new Map(messages.flatMap((m) => (m.tool_calls ?? []).map((call) => [call.id, call.function.name])));
	const results = messages.slice(lastUser + 1).filter((m) => m.role === 'tool').map((m) => { let data = {}; try { data = JSON.parse(textOf(m.content)); } catch { /* text */ } return { name: calls.get(m.tool_call_id), data }; });
	const last = results.at(-1);
	const tool = (name, args) => ({ tool: name, args });
	if (/^Done: found/i.test(said)) {
		if (!last) return tool('query_rows', { sheetId, limit: 1 });
		if (last.name === 'query_rows') return tool('add_contact_columns', { sheetId, revision: last.data.revision, email: true, verify: true });
		if (last.name === 'add_contact_columns') return tool('quote_run', { sheetId, columnId: last.data.added?.[0]?.columnId ?? 'work_email' });
		return { text: `I added a Work email column that finds each address and verifies it in the same cell. The card covers all ${last.data.cells ?? 10} rows; try 5 rows first to check the fill rate before running the rest.` };
	}
	const ran = /^Done: ran (\d+) rows? of (.+?) \(column ([A-Za-z0-9_-]+)\): (\d+) filled, (\d+) empty, (\d+) errors?, \$([\d.]+) spent\. (\d+) rows? left\./i.exec(said);
	if (ran) {
		const [, rows, column, columnId, filled, empty, , spent, left] = ran;
		if (Number(left) > 0 && !last) return tool('quote_run', { sheetId, columnId });
		if (Number(left) > 0) return { text: `${rows} of ${rows} rows ran: ${filled} verified ${column.toLowerCase()}s, ${empty} not found, $${spent} spent. The card runs the other ${left} rows.` };
		return { text: `Done. ${column} ran on every row: ${filled} found and verified, ${empty} not found, $${spent} spent on this run. You can add phone numbers next, or export the sheet.` };
	}
	if (/\b(find|get)\b/i.test(said)) {
		if (!last) return tool('quote_find_rows', { sheetId, entity: 'people', query: 'B2B SaaS companies with 50 to 500 employees', employeesMin: 50, employeesMax: 500, jobTitle: 'Head of RevOps', limit: 10 });
		return { text: `I priced the search: up to 10 heads of RevOps at SaaS companies with 50 to 500 people, $${last.data.maxUsd} at most. Run it from the card; nothing is spent until you do. Then I will add verified work emails.` };
	}
	return { text: 'I can find people or companies, add columns that research each row, and find and verify emails. Tell me who you are looking for.' };
}

function agentTurn(request, res) {
	const plan = agentPlan(request);
	const message = plan.tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${Date.now()}`, type: 'function', function: { name: plan.tool, arguments: JSON.stringify(plan.args) } }] } : { role: 'assistant', content: plan.text };
	const finish = plan.tool ? 'tool_calls' : 'stop';
	const usage = { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 };
	if (!request.stream) return json(res, 200, { id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: 0, model: 'mock-model', choices: [{ index: 0, message, finish_reason: finish }], usage });
	res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
	const send = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'mock-model', choices, ...extra })}\n\n`);
	(async () => {
		if (plan.tool) send([{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] }, finish_reason: null }]);
		else for (const piece of plan.text.match(/.{1,24}(\s|$)/g) ?? [plan.text]) { send([{ index: 0, delta: { content: piece }, finish_reason: null }]); await sleep(15); }
		send([{ index: 0, delta: {}, finish_reason: finish }]);
		send([], { usage });
		res.end('data: [DONE]\n\n');
	})();
}
