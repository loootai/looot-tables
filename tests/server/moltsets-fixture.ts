import assert from 'node:assert/strict';

/* A stand-in for the MoltSets REST API, shaped from its public docs (developer.moltsets.com): every call that completes
   is HTTP 200 with `status` ok or not_found, and errors are `{ error: { code, message } }` with a 4xx or 5xx status. */

export const MS_KEY = 'ms_test_key_0123456789';
const WINDOW = { records_remaining_5h: 14_990, records_reset_5h: '2026-11-20T18:00:00Z', records_remaining_1w: 74_990, records_reset_1w: '2026-11-27T13:00:00Z' };

export interface RecordedMoltSets { url: string; tool: string; body: Record<string, unknown>; authorization: string | null; redirect: RequestRedirect | undefined }
type Answer = { status: number; body: unknown; headers?: Record<string, string> } | 'redirect';

/** A found record: HTTP 200, status ok. */
export const found = (results: unknown): Answer => ({ status: 200, body: { results, status: 'ok', metadata: { fair_use: WINDOW } } });
/** Nothing found: still HTTP 200, uncharged. */
export const notFound = (results: unknown = { email: null }): Answer => ({ status: 200, body: { results, status: 'not_found', metadata: { fair_use: WINDOW } } });
/** An error: no `results`, and `metadata.retry_after` for the fair use codes. */
export const failed = (status: number, code: string, metadata: Record<string, unknown> = {}): Answer => ({ status, body: { error: { code, message: `${code} (test)` }, ...(Object.keys(metadata).length ? { metadata } : {}) }, headers: metadata.retry_after ? { 'retry-after': String(metadata.retry_after) } : undefined });
export const windowSpent = (retryAfter = 1_800) => failed(429, 'fair_use_limit_exceeded', { retry_after: retryAfter });

/** `handlers` answers by tool name. Every call is recorded, and a call to any host but the MoltSets API fails the test. */
export function fakeMoltSets(handlers: Record<string, (body: Record<string, unknown>, call: RecordedMoltSets) => Answer>, origin = 'https://api.moltsets.com') {
	const calls: RecordedMoltSets[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		assert.equal(url.origin, origin, 'the MoltSets key goes to the MoltSets API and nowhere else');
		assert.match(url.pathname, /^\/api\/v1\/tools\/[a-z_]+$/);
		assert.equal(request.method, 'POST');
		const call: RecordedMoltSets = { url: request.url, tool: url.pathname.split('/').pop()!, body: await request.json() as Record<string, unknown>, authorization: request.headers.get('authorization'), redirect: init?.redirect };
		calls.push(call);
		const handler = handlers[call.tool] ?? handlers['*'];
		assert.ok(handler, `unexpected MoltSets call: ${call.tool}`);
		const answer = handler(call.body, call);
		// A redirect: with `redirect: 'error'` the platform fetch throws instead of following it to another host.
		if (answer === 'redirect') { if (init?.redirect === 'error') throw new TypeError('fetch failed: redirect'); return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/steal' } }); }
		return Response.json(answer.body, { status: answer.status, headers: answer.headers });
	};
	return { fetch: fetchImpl, calls };
}
