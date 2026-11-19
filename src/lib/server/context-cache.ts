import 'server-only';
import { createHash } from 'node:crypto';

const HOUR = 60 * 60 * 1000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const paths = new Set(['/v1/brand/retrieve', '/v1/brand/search', '/v1/company/search', '/v1/people/enrich', '/v1/people/search', '/v1/web/search', '/v1/web/scrape', '/v1/web/urls', '/v1/web/competitors', '/v1/web/styleguide']);

type Entry = { body: string; headers: [string, string][]; expires: number; bytes: number };

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
	return value;
}

/** Full upstream JSON responses, shared across fields and browser tabs in this server process.
 * Credentials are hashed into keys, never stored. Restarting the server clears the cache.
 */
export function createContextFetch(now = Date.now): typeof fetch {
	const entries = new Map<string, Entry>();
	const pending = new Map<string, Promise<Entry | Response>>();
	let bytes = 0;
	function remove(key: string) { const entry = entries.get(key); if (entry) bytes -= entry.bytes; entries.delete(key); }
	function prune() {
		for (const [key, entry] of entries) if (entry.expires <= now()) remove(key);
		while (bytes > MAX_BYTES && entries.size) remove(entries.keys().next().value!);
	}
	function cachedResponse(entry: Entry, reused: boolean) {
		const data = JSON.parse(entry.body);
		// A reused response consumed no new upstream credits.
		if (reused) data.key_metadata = { ...data.key_metadata, credits_consumed: 0 };
		const headers = new Headers(entry.headers);
		headers.delete('content-length');
		headers.delete('content-encoding');
		headers.set('x-enrichable-cache', reused ? 'HIT' : 'MISS');
		return Response.json(data, { headers });
	}
	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin !== 'https://api.context.dev' || !paths.has(url.pathname) || !['GET', 'POST'].includes(request.method)) return fetch(input, init);
		request.signal.throwIfAborted();
		url.searchParams.sort();
		const body = request.method === 'POST' ? await request.clone().text() : '';
		let normalized = body;
		try { normalized = JSON.stringify(canonical(JSON.parse(body))); } catch { /* Non-JSON bodies retain exact matching. */ }
		const key = createHash('sha256').update(JSON.stringify([request.headers.get('authorization'), request.method, url.href, normalized])).digest('hex');
		prune();
		const existing = entries.get(key);
		if (existing) return cachedResponse(existing, true);
		let work = pending.get(key);
		const reused = Boolean(work);
		if (!work) {
			work = (async (): Promise<Entry | Response> => {
				// Each caller can cancel independently without cancelling other cells' shared work.
				const response = await fetch(new Request(request, { signal: AbortSignal.timeout(90_000) }));
				if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response;
				const text = await response.clone().text();
				let data;
				try { data = JSON.parse(text); } catch { return response; }
				if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.status === 'error' || data.status === 'failed' || data.status === 'partial' || data.partial === true || Object.values(data).some((value) => value && typeof value === 'object' && 'success' in value && value.success === false)) return response;
				const entry = { body: text, headers: [...response.headers.entries()], expires: now() + HOUR, bytes: Buffer.byteLength(text) };
				if (entry.bytes <= MAX_ENTRY_BYTES) { entries.set(key, entry); bytes += entry.bytes; prune(); }
				return entry;
			})();
			pending.set(key, work);
			void work.finally(() => { pending.delete(key); }).catch(() => {});
		}
		return new Promise<Response>((resolve, reject) => {
			const abort = () => reject(request.signal.reason);
			request.signal.addEventListener('abort', abort, { once: true });
			if (request.signal.aborted) abort();
			work.then((result) => resolve(result instanceof Response ? result.clone() : cachedResponse(result, reused)), reject).finally(() => request.signal.removeEventListener('abort', abort));
		});
	};
}

export const contextFetch = createContextFetch();
