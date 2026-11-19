import 'server-only';

import ContextDev from 'context.dev';
import type { FailureReason } from '../types';
import { COUNTRY_CODES } from '../countries';
import { taggedContextFetch } from './context-tags';
import { classifyFailure, EnrichError, failure, retryUnbilled, trackedFetch, type Spend } from './enrich-failure';
import { toDomain, toUrl } from '../template';

const BASE_URL = 'https://api.context.dev/v1';

/** Context.dev bills the requests it processes; the SDK's own retries would repeat timeouts and server errors. With a
    `spend`, every request it may have billed is recorded there; a response the shared cache reused cost nothing. */
export function contextClient(apiKey: string, userEmail?: string, spend?: Spend) {
	const transport = retryUnbilled(taggedContextFetch(userEmail));
	return new ContextDev({ apiKey, timeout: 90_000, maxRetries: 0, fetch: spend ? trackedFetch(transport, spend, { billed: (response) => response.status !== 429 && response.headers.get('x-enrichable-cache') !== 'HIT', credits: contextCredits }) : transport });
}

/** Documented costs for responses that omit `key_metadata.credits_consumed`; other endpoints cost 1. */
const ENDPOINT_CREDITS: Record<string, number> = { '/v1/company/search': 2, '/v1/web/answers': 10 };

async function contextCredits(response: Response, input: RequestInfo | URL, init?: RequestInit): Promise<number> {
	const data = response.headers.get('content-type')?.includes('json') ? await response.clone().json().catch(() => null) as { key_metadata?: { credits_consumed?: unknown } } | null : null;
	const consumed = data?.key_metadata?.credits_consumed;
	if (typeof consumed === 'number') return consumed;
	if (!response.ok) return 0;
	const path = new URL(input instanceof Request ? input.url : input).pathname;
	if (path === '/v1/web/answers' && answersMode(init) === 'ultra') return 100;
	return ENDPOINT_CREDITS[path] ?? 1;
}

function answersMode(init?: RequestInit): unknown {
	try {
		const body: unknown = JSON.parse(String(init?.body));
		return body && typeof body === 'object' ? (body as { mode?: unknown }).mode : undefined;
	} catch {
		return undefined;
	}
}

export interface PageText {
	url: string;
	text: string;
	title?: string;
}

function stripMarkdownNoise(markdown: string): string {
	return markdown
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** Scrape a page to clean text. Throws with a readable message when the page can't be read. */
export async function readPage(client: ContextDev, url: string, options: { maxChars?: number; query?: string; maxAgeMs?: number; preserveMarkdown?: boolean } = {}): Promise<PageText> {
	const maxChars = options.maxChars ?? 12_000;
	const wantHighlights = Boolean(options.query);
	const response = await client.web.scrape({
		url,
		formats: { markdown: true, highlights: wantHighlights },
		...(wantHighlights ? { highlightsParams: { query: options.query!.slice(0, 2000), maxCharacters: Math.min(maxChars, 20_000) } } : {}),
		sharedParams: { mainContentOnly: true, dismissCookies: true },
		markdownParams: { includeLinks: Boolean(options.preserveMarkdown), includeImages: Boolean(options.preserveMarkdown) },
		maxAgeMs: options.maxAgeMs ?? 3 * 24 * 60 * 60 * 1000,
		timeoutOpts: { milliseconds: 60_000, behavior: 'return-partial' },
	});
	const title = response.metadata?.title;
	if (wantHighlights && response.highlights?.success && response.highlights.data?.length) {
		return { url, text: response.highlights.data.join('\n…\n').slice(0, maxChars), title };
	}
	if (response.markdown?.success && response.markdown.data) {
		return { url, text: (options.preserveMarkdown ? response.markdown.data : stripMarkdownNoise(response.markdown.data)).slice(0, maxChars), title };
	}
	const reason = response.markdown?.message ?? response.markdown?.error_code ?? 'no content';
	throw new Error(`Could not read ${url}: ${reason}`);
}

/** Extract an object matching a JSON schema from a page. */
export async function extractFromPage(client: ContextDev, url: string, schema: Record<string, unknown>, instructions?: string) {
	const response = await client.web.scrape({
		url,
		formats: { json: true },
		jsonParams: { schema, instructions },
		sharedParams: { mainContentOnly: true, dismissCookies: true },
		timeoutOpts: { milliseconds: 60_000, behavior: 'fail' },
	});
	if (!response.json?.success) throw new Error(`Could not extract from ${url}: ${response.json?.message ?? response.json?.error_code ?? 'no content'}`);
	return response.json.data as Record<string, unknown>;
}

export interface SearchHit {
	url: string;
	title: string;
	description: string;
	highlights?: string[];
}

export async function webSearch(client: ContextDev, query: string, options: { country?: ContextDev.Web.WebSearchParams['country']; numResults?: number; includeDomains?: string[]; highlights?: boolean; freshness?: 'last_24_hours' | 'last_week' | 'last_month' | 'last_year' } = {}): Promise<{ results: SearchHit[] }> {
	const response = await client.web.search({
		query: query.slice(0, 500),
		numResults: options.numResults ?? 5,
		includeDomains: options.includeDomains,
		country: options.country,
		freshness: options.freshness,
		highlightsOptions: options.highlights ? { enabled: true, maxCharacters: 1500 } : undefined,
		timeoutOpts: { milliseconds: 45_000, behavior: 'return-partial' },
	});
	return {
		results: response.results.map((result) => ({
			url: result.url,
			title: result.title,
			description: result.description,
			highlights: result.highlights?.highlights ?? undefined,
		})),
	};
}

export async function webSearchCountries(client: ContextDev, query: string, countries: string[] | undefined, options: Parameters<typeof webSearch>[2] = {}, signal?: AbortSignal) {
	const codes = [...new Set((countries ?? []).map((code) => code.toLowerCase()))];
	for (const code of codes) {
		if (!COUNTRY_CODES.some((supported) => supported.toLowerCase() === code)) throw new Error(`Unsupported country: ${code}`);
	}
	const locations = codes.length ? codes : [undefined];
	const results: SearchHit[] = [];
	const seen = new Set<string>();
	for (const country of locations) {
		signal?.throwIfAborted();
		const response = await webSearch(client, query, { ...options, country: country as ContextDev.Web.WebSearchParams['country'], numResults: Math.ceil((options.numResults ?? 5) / locations.length) });
		for (const result of response.results) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			results.push(result);
		}
	}
	return { results: results.slice(0, options.numResults ?? 5) };
}

const PAGE_PATHS: Record<string, string[]> = {
	pricing: ['/pricing', '/plans', '/pricing/', '/plans-and-pricing', '/price', '/packages'],
	careers: ['/careers', '/jobs', '/careers/', '/join-us', '/company/careers', '/about/careers'],
	about: ['/about', '/about-us', '/company', '/about/'],
	contact: ['/contact', '/contact-us', '/contact/'],
	blog: ['/blog', '/news', '/blog/', '/resources/blog'],
	team: ['/team', '/about/team', '/our-team', '/leadership', '/about#team'],
	docs: ['/docs', '/documentation', '/developers', '/api'],
	privacy: ['/privacy', '/privacy-policy', '/legal/privacy'],
	terms: ['/terms', '/terms-of-service', '/legal/terms'],
	customers: ['/customers', '/case-studies', '/clients'],
	integrations: ['/integrations', '/apps', '/marketplace'],
	security: ['/security', '/trust', '/legal/security'],
};

/** The domain has no such page: the one lookup failure that is an answer rather than a failure. */
export class PageNotFound extends EnrichError {
	constructor(page: string, domain: string) { super(`No ${page} page found on ${domain}`, failure('input_invalid', 'context')); }
}

const HALTS_LOOKUP = new Set<FailureReason>(['credential_invalid', 'credential_missing', 'credits_exhausted', 'rate_limited']);

/** A failure that says nothing about the page: the run must halt or retry, never answer. Anything else (a timeout, a
    blocked or broken URL) only rules out that candidate. */
function haltsLookup(error: unknown) {
	const outcome = classifyFailure(error, 'context');
	return Boolean(outcome && (outcome.retryable || HALTS_LOOKUP.has(outcome.reason)));
}

/** Find a named page (pricing, careers…) on a domain: common paths first, then a site map search. Throws `PageNotFound`
    when neither finds it. */
export async function findPage(client: ContextDev, domainOrUrl: string, page: string): Promise<string> {
	const domain = toDomain(domainOrUrl);
	if (!domain) throw new Error('No domain to look up');
	const key = page.trim().toLowerCase();
	const candidates = PAGE_PATHS[key] ?? [`/${key.replace(/\s+/g, '-')}`];
	for (const path of candidates.slice(0, 3)) {
		const url = `https://${domain}${path}`;
		try {
			const probe = await client.web.scrape({ url, formats: { markdown: true }, sharedParams: { mainContentOnly: true }, markdownParams: { includeLinks: false }, timeoutOpts: { milliseconds: 25_000, behavior: 'fail' } });
			const text = probe.markdown?.data ?? '';
			if (probe.markdown?.success && text.length > 200 && !isNotFoundPage(text)) return probe.metadata?.canonicalUrl ?? url;
		} catch (error) {
			if (haltsLookup(error)) throw error;
		}
	}
	try {
		const map = await client.web.mapUrls({ domain, search: key, maxLinks: 10 });
		const hit = map.urls.find((entry) => entry.url.toLowerCase().includes(key));
		if (hit) return hit.url;
	} catch (error) {
		if (haltsLookup(error)) throw error;
	}
	throw new PageNotFound(page, domain);
}

function isNotFoundPage(text: string): boolean {
	const head = text.slice(0, 600).toLowerCase();
	return /page not found|404|doesn.t exist|could not be found/.test(head);
}

export function homepageUrl(value: string): string {
	const domain = toDomain(value);
	if (!domain) throw new Error('No domain in this row');
	return `https://${domain}`;
}

export function resolveUrl(value: string): string {
	const url = toUrl(value);
	if (!url) throw new Error(`Not a URL: ${value || '(empty)'}`);
	return url;
}

/* ───────────── Company search (not in the SDK yet; a raw request on the client, so it shares its transport) ───────────── */

export interface CompanyHit {
	name: string;
	domain: string;
	description?: string | null;
	industries?: string[];
	headquarters?: { country_code?: string | null; region?: string | null; city?: string | null };
	employees?: { count?: number | null; min?: number | null; max?: number | null };
	founded_year?: number | null;
	funding?: { total_usd?: number | null; stage?: string | null; latest_round?: { type: string; date?: string | null; amount_usd?: number | null } | null; round_count?: number | null };
	organization_type?: string | null;
	stock_symbols?: string[];
	revenue?: { min_usd?: number | null; max_usd?: number | null };
}

export async function companySearch(client: ContextDev, body: { query: string; filters?: { countries?: string[]; employees_min?: number; employees_max?: number }; cursor?: string }): Promise<{ results: CompanyHit[]; next_cursor: string | null }> {
	const data = await client.post<{ results?: CompanyHit[]; next_cursor?: string | null }>('/company/search', { body: { query: body.query.slice(0, 500), filters: body.filters, cursor: body.cursor }, timeout: 60_000 });
	return { results: data.results ?? [], next_cursor: data.next_cursor ?? null };
}

export async function contextUsage(apiKey: string, userEmail?: string): Promise<{ credits?: number; used?: number }> {
	const response = await taggedContextFetch(userEmail, fetch)(`${BASE_URL}/org/usage`, { headers: { authorization: `Bearer ${apiKey}` }, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw Object.assign(new Error(`Context.dev rejected the key (${response.status})`), { status: response.status });
	const data = (await response.json()) as Record<string, unknown>;
	const credits = pickNumber(data, ['credits_remaining', 'remaining_credits', 'credits', 'balance']);
	const period = data.period as { credits_used?: number } | null | undefined;
	return { credits, used: typeof period?.credits_used === 'number' ? period.credits_used : undefined };
}

function pickNumber(data: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = data[key];
		if (typeof value === 'number') return value;
		if (value && typeof value === 'object') {
			const nested = pickNumber(value as Record<string, unknown>, keys);
			if (nested !== undefined) return nested;
		}
	}
	return undefined;
}

/** Bounded page assets and domain URL discovery; no model or OpenAI key required. */
export async function readWebOutput(client: ContextDev, url: string, mode: 'links' | 'map' | 'html' | 'images' | 'emails' | 'phone-numbers', maxChars: number) {
	if (mode === 'map') {
		const result = await client.web.mapUrls({ domain: toDomain(url), maxLinks: 100, timeoutOpts: { milliseconds: 60_000, behavior: 'return-partial' } });
		return boundedValues(result.urls.map((entry) => entry.url), maxChars);
	}
	const parser = mode === 'links' || mode === 'emails' || mode === 'phone-numbers' ? mode : null;
	const result = await client.web.scrape({
		url,
		formats: parser ? { parse: true } : mode === 'html' ? { html: true } : { images: true },
		...(parser ? { parseParams: { type: 'prebuilt' as const, parser } } : {}),
		timeoutOpts: { milliseconds: 60_000, behavior: 'fail' },
	});
	const output = parser ? result.parsed : mode === 'html' ? result.html : result.images;
	if (!output?.success) throw new Error(`Could not get ${mode} from ${url}: ${output?.message ?? 'no content'}`);
	if (mode === 'html') return (result.html.data ?? '').slice(0, maxChars);
	if (mode === 'images') return boundedValues((result.images.data ?? []).map((image) => image.url).filter((value) => /^https?:\/\//i.test(value)), maxChars);
	const key = mode === 'phone-numbers' ? 'phone_numbers' : mode;
	const property = mode === 'links' ? 'url' : mode === 'emails' ? 'email' : 'phone';
	const entries = result.parsed.data?.[key];
	const values = Array.isArray(entries) ? entries.flatMap((entry: unknown) => {
		if (!entry || typeof entry !== 'object') return [];
		const value = (entry as Record<string, unknown>)[property];
		return typeof value === 'string' ? [value] : [];
	}) : [];
	return boundedValues(values, maxChars);
}

function boundedValues(values: string[], maxChars: number): string[] {
	let length = 0;
	const bounded: string[] = [];
	for (const value of new Set(values)) {
		if (bounded.length >= 100 || length + value.length > maxChars) break;
		bounded.push(value);
		length += value.length;
	}
	return bounded;
}
