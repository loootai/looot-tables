import 'server-only';

import { createHash } from 'node:crypto';

/* The only module that talks to the MoltSets REST API. A MoltSets key is sent to one host, the MoltSets API (or the
   address a deployer names in MOLTSETS_API_URL), in an Authorization header and nowhere else: never in a URL or body,
   never to a redirect target, never to looot. A MoltSets plan is flat-fee, so no call here costs dollars. */

export const MOLTSETS_API = 'https://api.moltsets.com';

/** The MoltSets API this deployment talks to: the hosted one, or MOLTSETS_API_URL for a proxy or a local stand-in. Server-side only. */
export const moltsetsApiUrl = () => process.env.MOLTSETS_API_URL?.trim().replace(/\/+$/, '') || MOLTSETS_API;

/** The MoltSets tools this app calls. The URL is built from this list only, so no caller can aim a key at another path. */
export const MOLTSETS_TOOLS = ['search_business_email_by_name', 'linkedin_to_business_email', 'linkedin_to_mobile_phone', 'search_linkedin_profile', 'reverse_email_lookup', 'reverse_linkedin_lookup', 'email_to_linkedin', 'get_account'] as const;
export type MoltSetsTool = typeof MOLTSETS_TOOLS[number];

/** hit: an answer. miss: `not_found`, uncharged. exhausted: a fair-use window or the phone tokens are spent. error: the call failed. */
export type MoltSetsOutcome = 'hit' | 'miss' | 'exhausted' | 'error';

export interface MoltSetsAnswer {
	outcome: MoltSetsOutcome;
	/** The `results` body of a hit, as MoltSets sent it. */
	results?: unknown;
	/** MoltSets' own error code (`fair_use_limit_exceeded`, `unauthorized`, ...), or `unreachable`. */
	code?: string;
	message?: string;
	retryAfterSeconds?: number;
	/** Enrichment records left in the current 5 hour window, from `metadata.fair_use`. */
	recordsLeft5h?: number;
}

const TIMEOUT_MS = 20_000;
/** Longest a window cooldown is remembered, and the wait used when MoltSets gives no `retry_after`. */
const MAX_COOLDOWN_S = 5 * 3600;
const DEFAULT_COOLDOWN_S = 600;
const BURST_RETRIES = [500, 1500];

/** Tools whose last answer said the plan is spent, per key. While one is cooling down the app skips the request, so a
    sheet of a thousand rows does not send a thousand calls MoltSets will refuse. In memory, per server instance. */
const cooldowns = new Map<string, number>();
const fingerprint = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** Forget every cooldown. For tests. */
export const resetMoltSetsCooldowns = () => cooldowns.clear();

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const seconds = (value: unknown): number | undefined => { const n = typeof value === 'string' ? Number(value) : value; return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined; };

/** The base URL a key may be sent to: https, or plain http only on this machine (the local stand-in). */
export function checkedBase(base: string): string {
	let url: URL;
	try { url = new URL(base); } catch { throw new Error('MOLTSETS_API_URL is not a valid URL.'); }
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('MOLTSETS_API_URL must be an https address, or http on localhost.');
	if (url.username || url.password) throw new Error('MOLTSETS_API_URL must not carry credentials.');
	return url.origin + url.pathname.replace(/\/+$/, '');
}

export class MoltSetsClient {
	readonly #key: string;
	readonly #base: string;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number) => Promise<void>;

	constructor(options: { key: string; baseUrl?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
		this.#key = options.key;
		this.#base = checkedBase(options.baseUrl ?? moltsetsApiUrl());
		this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	/** One tool call. Never throws: every outcome comes back as data, because a MoltSets miss or a spent window is an
	    answer and the caller falls back to looot. A `not_found` is uncharged and a hit draws from the plan's window. */
	async call(tool: MoltSetsTool, body: Record<string, unknown> = {}): Promise<MoltSetsAnswer> {
		const cooldownKey = `${fingerprint(this.#key)}:${tool}`;
		const until = cooldowns.get(cooldownKey);
		if (until && until > Date.now()) return { outcome: 'exhausted', code: 'cooling_down', message: 'The MoltSets window is spent; not asking again until it reopens.', retryAfterSeconds: Math.ceil((until - Date.now()) / 1000) };
		for (let attempt = 0; ; attempt++) {
			const answer = await this.#send(tool, body);
			if (answer.code === 'rate_limited' || answer.code === 'search_concurrency_exceeded') {
				// A burst guard, not the plan: wait a moment and ask again. Nothing was charged.
				if (attempt < BURST_RETRIES.length) { await this.#sleep(Math.min(BURST_RETRIES[attempt], (answer.retryAfterSeconds ?? 0) * 1000 || BURST_RETRIES[attempt])); continue; }
				return { ...answer, outcome: 'exhausted' };
			}
			if (answer.outcome === 'exhausted') cooldowns.set(cooldownKey, Date.now() + Math.min(answer.retryAfterSeconds ?? DEFAULT_COOLDOWN_S, MAX_COOLDOWN_S) * 1000);
			return answer;
		}
	}

	async #send(tool: MoltSetsTool, body: Record<string, unknown>): Promise<MoltSetsAnswer> {
		let response: Response;
		try {
			response = await this.#fetch(`${this.#base}/api/v1/tools/${tool}`, {
				method: 'POST',
				headers: { authorization: `Bearer ${this.#key}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'looot-tables/1.0' },
				body: JSON.stringify(body),
				cache: 'no-store',
				// A redirect would carry the key to another host. MoltSets does not redirect its API, so any redirect is an error.
				redirect: 'error',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch {
			return { outcome: 'error', code: 'unreachable', message: 'MoltSets did not answer.' };
		}
		const data = object(await response.json().catch(() => null));
		const metadata = object(data.metadata);
		const recordsLeft5h = seconds(object(metadata.fair_use).records_remaining_5h);
		if (response.ok) {
			if (data.status === 'ok') return { outcome: 'hit', results: data.results, recordsLeft5h };
			if (data.status === 'not_found') return { outcome: 'miss', recordsLeft5h };
			return { outcome: 'error', code: 'unexpected_status', message: 'MoltSets answered with a status this app does not know.' };
		}
		const error = object(data.error);
		const code = typeof error.code === 'string' ? error.code : `http_${response.status}`;
		const message = typeof error.message === 'string' ? error.message.slice(0, 200) : `MoltSets answered ${response.status}.`;
		const retryAfterSeconds = seconds(metadata.retry_after) ?? seconds(response.headers.get('retry-after'));
		// Spent windows and spent phone tokens: the plan cannot answer right now, looot can.
		if (['fair_use_limit_exceeded', 'fair_use_requests_exceeded', 'insufficient_tokens', 'insufficient_phone_tokens'].includes(code)) return { outcome: 'exhausted', code, message, retryAfterSeconds };
		return { outcome: 'error', code, message, retryAfterSeconds };
	}
}
