// A stand-in for the MoltSets REST API, for manual local testing. Synthetic data only, no network, no key needed.
// It follows the public MoltSets docs: every completed call is HTTP 200 with status "ok" or "not_found", errors are
// { error: { code, message } }, and each answer carries metadata.fair_use with the records left in the 5 hour window.
//
//   node scripts/mock-moltsets.mjs            # listens on http://127.0.0.1:4547
//   MOLTSETS_API_URL=http://127.0.0.1:4547 npm run dev
//
// Any Bearer key starting with ms_ is accepted. Names the stand-in knows answer with a hit; any other name is a
// not_found. A name starting with "Spent" answers 429 fair_use_limit_exceeded, like a window that is used up.
import http from 'node:http';

const PORT = Number(process.env.MOCK_MOLTSETS_PORT || 4547);
const LIMIT_5H = 15_000;
let used = 0;
const log = [];

const KNOWN = new Map([
	['maya rios', { email: 'maya.rios@stripe.com', risk_score: 'A', last_validated_at: '2026-11-02', linkedin_url: 'https://linkedin.com/in/maya-rios-example' }], // leak-scan:allow fictional demo contact at a real company domain
	['marcus bell', { email: 'marcus.bell@linear.app', risk_score: 'B', last_validated_at: '2026-11-11', linkedin_url: 'https://linkedin.com/in/marcus-bell-example' }], // leak-scan:allow fictional demo contact at a real company domain
	['yuki tanaka', { email: 'yuki.tanaka@vercel.com', risk_score: 'C', last_validated_at: '2026-10-18', linkedin_url: 'https://linkedin.com/in/yuki-tanaka-example' }], // leak-scan:allow fictional demo contact at a real company domain
	['ingrid larsen', { email: 'ingrid.larsen@figma.com', risk_score: 'D', last_validated_at: '2026-09-30', linkedin_url: 'https://linkedin.com/in/ingrid-larsen-example' }], // leak-scan:allow fictional demo contact at a real company domain
	['amara okafor', { email: 'amara.okafor@retool.com', risk_score: 'F', last_validated_at: '2026-06-03', linkedin_url: 'https://linkedin.com/in/amara-okafor-example' }], // leak-scan:allow fictional demo contact at a real company domain
]);

const fairUse = () => ({ records_remaining_5h: LIMIT_5H - used, records_reset_5h: new Date(Date.now() + 5 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z'), records_remaining_1w: 75_000 - used, records_reset_1w: new Date(Date.now() + 7 * 24 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z') });
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
	let body = '';
	req.on('data', (chunk) => (body += chunk));
	req.on('end', () => {
		const url = new URL(req.url, 'http://x');
		if (url.pathname === '/__log') return json(res, 200, { calls: log, used });
		const tool = url.pathname.match(/^\/api\/v1\/tools\/([a-z_]+)$/)?.[1];
		if (req.method !== 'POST' || !tool) return json(res, 404, { error: { code: 'tool_not_found', message: `mock: ${url.pathname}` } });
		const key = /^Bearer (ms_\S+)$/.exec(req.headers.authorization ?? '')?.[1];
		if (!key) return json(res, 401, { error: { code: 'unauthorized', message: 'Missing, invalid, or revoked API key' } });
		const input = JSON.parse(body || '{}');
		log.push({ tool, input, keyPrefix: key.slice(0, 5) });
		if (tool === 'get_account') {
			return json(res, 200, { status: 'ok', metadata: {}, results: { id: 'mock', name: 'Mock account', status: 'active', plan: 'subscription_97', token_balance: -1, unlimited: true, phone_token_balance: 98, fair_use: { enrich: { records: { '5h': { limit: LIMIT_5H, used, remaining: LIMIT_5H - used, resets_at: fairUse().records_reset_5h }, '1w': { limit: 75_000, used, remaining: 75_000 - used, resets_at: fairUse().records_reset_1w } } } }, personal_email_available: true, api_key_count: 1, user_count: 1 } });
		}
		if (tool === 'search_business_email_by_name') {
			const name = String(input.name ?? `${input.first_name ?? ''} ${input.last_name ?? ''}`).trim().toLowerCase();
			if (name.startsWith('spent')) return json(res, 429, { error: { code: 'fair_use_limit_exceeded', message: 'The 5 hour window is used up.' }, metadata: { retry_after: 1800 } }, { 'retry-after': '1800' });
			const known = KNOWN.get(name);
			if (!known) return json(res, 200, { status: 'not_found', results: { email: null, linkedin_url: null, last_validated_at: null }, metadata: { fair_use: fairUse() } });
			used += 1;
			return json(res, 200, { status: 'ok', results: known, metadata: { fair_use: fairUse() } });
		}
		return json(res, 200, { status: 'not_found', results: {}, metadata: { fair_use: fairUse() } });
	});
}).listen(PORT, '127.0.0.1', () => console.log(`mock MoltSets on http://127.0.0.1:${PORT}`));
