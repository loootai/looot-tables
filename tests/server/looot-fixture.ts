import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

/** One looot run as the REST API answers it, with the fields the app reads. Everything else is left out. */
export interface FakeRun {
	status?: string;
	outcome?: string;
	outcomeReason?: string;
	result?: unknown;
	normalized?: { fields?: Record<string, unknown>; verdict?: string };
	actualCost?: number;
	error?: { code: string; message: string; whoseError?: string; retryable?: boolean; providerStatus?: number | null } | null;
	route?: { servedBy?: string; chargedUsd?: number; attempts?: Array<{ n: number; endpointId: string; provider: string; outcome: string; status?: string; chargedUsd: number; ms?: number; reason?: string | null }>; skipped?: unknown[] };
	servedProviderId?: string;
	servedEndpointId?: string;
	/** An HTTP status other than 201, with its error body. */
	http?: { status: number; body: unknown };
}

export interface RecordedRun { endpointId: string; input: Record<string, unknown>; idempotencyKey: string; fallback?: unknown; wait?: string | null }

/** A looot answer for a hit: the provider's own body in `result`, the cost in USD. */
export const hit = (result: unknown, extra: FakeRun = {}): FakeRun => ({ outcome: 'hit', result, actualCost: 0.001, ...extra });

/** A fallback route that tried each provider in order, the last one answering. */
export const routed = (providers: Array<{ provider: string; outcome: string; chargedUsd: number }>): NonNullable<FakeRun['route']> => ({
	servedBy: `${providers.at(-1)!.provider}-endpoint`,
	chargedUsd: providers.reduce((sum, entry) => sum + entry.chargedUsd, 0),
	attempts: providers.map((entry, index) => ({ n: index + 1, endpointId: `${entry.provider}-endpoint`, provider: entry.provider, outcome: entry.outcome, chargedUsd: entry.chargedUsd, status: 'ok' })),
});

/** Stands in for the looot REST API: `POST /v1/runs` is answered by the handler for the endpoint id, `GET /v1/balance`
    by `balance`. Every run is recorded, so a test can check what was sent. */
export function fakeLooot(t: TestContext, handlers: Record<string, (input: Record<string, unknown>, call: RecordedRun) => FakeRun>, options: { balance?: number } = {}) {
	const runs: RecordedRun[] = [];
	const polled: string[] = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		assert.equal(url.origin, 'https://api.looot.ai', 'only the looot API is called');
		assert.match(request.headers.get('authorization') ?? '', /^Bearer \S+$/);
		if (url.pathname === '/v1/balance') return Response.json({ available: options.balance ?? 5, reserved: 0 });
		if (url.pathname.startsWith('/v1/runs/') && request.method === 'GET') {
			polled.push(url.pathname);
			return Response.json({ runId: url.pathname.split('/').pop(), status: 'completed', outcome: 'hit', result: {}, actualCost: 0 });
		}
		assert.equal(url.pathname, '/v1/runs');
		const body = await request.json() as RecordedRun;
		const call: RecordedRun = { endpointId: body.endpointId, input: body.input, idempotencyKey: body.idempotencyKey, fallback: body.fallback, wait: url.searchParams.get('wait') };
		runs.push(call);
		const handler = handlers[body.endpointId] ?? handlers['*'];
		assert.ok(handler, `unexpected looot run: ${body.endpointId}`);
		const answer = handler(body.input, call);
		if (answer.http) return Response.json(answer.http.body, { status: answer.http.status });
		const failed = answer.status === 'failed' || answer.status === 'blocked';
		return Response.json({
			runId: `run_test_${runs.length}`,
			status: answer.status ?? 'completed',
			endpointId: answer.servedEndpointId ?? answer.route?.servedBy ?? body.endpointId,
			result: answer.result,
			normalized: answer.normalized ? { job: 'test', verdict: 'hit', ...answer.normalized } : undefined,
			outcome: answer.outcome ?? (failed ? 'error' : 'hit'),
			outcomeReason: answer.outcomeReason,
			actualCost: answer.actualCost ?? 0,
			route: answer.route,
			servedProviderId: answer.servedProviderId,
			servedEndpointId: answer.servedEndpointId,
			error: answer.error ?? null,
		}, { status: 201 });
	});
	return { runs, polled };
}
