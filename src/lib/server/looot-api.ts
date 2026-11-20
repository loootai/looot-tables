import 'server-only';

/* A small typed client for the public looot REST API (https://api.looot.ai/openapi.json): the five routes this app
   uses, over fetch. The shapes follow the looot-js SDK. Kept local rather than imported so the test runner, which loads
   CommonJS, and the Next bundler read the same code. */

export type Prefer = 'balanced' | 'cheapest' | 'reliable' | 'fastest';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'stopped' | 'reconciliation_pending' | 'pending_provider';
/** What a run found: a hit, a weak hit, nothing, an error, a rejected input, a skip, or still pending. */
export type RunOutcome = 'hit' | 'weak' | 'miss' | 'error' | 'rejected' | 'skipped' | 'pending';

export interface FallbackOptions {
	enabled?: boolean;
	maxAttempts?: number;
	maxCostUsd?: number;
	prefer?: Prefer;
	exclude?: string[];
	stopAtFirstMiss?: boolean;
}

export interface RouteAttempt {
	n: number;
	endpointId: string;
	provider: string;
	outcome: RunOutcome;
	status?: string;
	chargedUsd: number;
	ms?: number;
	reason?: string | null;
}

export interface RunError {
	code: string;
	message: string;
	requestId?: string;
	providerStatus?: number | null;
	whoseError?: 'provider' | 'gateway' | 'customer';
	retryable?: boolean;
	retryHint?: string;
}

export interface Run {
	runId: string;
	status: RunStatus;
	endpointId?: string;
	result?: unknown;
	normalized?: { fields?: Record<string, unknown>; verdict?: string; [key: string]: unknown };
	outcome?: RunOutcome;
	outcomeReason?: string;
	estimatedCost?: number;
	actualCost?: number | null;
	error?: RunError | null;
	replayed?: boolean;
	route?: { servedBy?: string; outcome?: RunOutcome; chargedUsd?: number; capped?: boolean; attempts?: RouteAttempt[]; skipped?: Array<{ endpointId: string; code: string; reason: string }>; summary?: string };
	/** Up to 3 priced follow-up jobs after a hit. Each carries the `run` arguments (with its suggestionId) that would run it. */
	nextSteps?: Array<{ suggestionId?: string; job?: string; title?: string; priceUsd?: number | null; input?: Record<string, unknown>; run?: { endpointId?: string; input?: Record<string, unknown>; suggestionId?: string }; [key: string]: unknown }>;
	[key: string]: unknown;
}

/** A rows batch: one run per row, keyed <idempotencyKey>:row:<index>. Send the same key again while `batch.complete` is false. */
export interface BatchParams {
	endpointId: 'job:people.email.find' | 'job:people.email.verify' | 'job:people.phone.find' | 'job:company.enrich';
	rows: Array<Record<string, unknown>>;
	idempotencyKey: string;
	input?: Record<string, unknown>;
	fallback?: boolean | FallbackOptions;
	wait?: number;
}

/** The answer to a rows batch. The public docs name `batch.complete`, the rows and `summary`; each row is read as a run
    with its `index`. */
export interface BatchAnswer {
	batch?: { complete?: boolean; [key: string]: unknown };
	rows?: Array<Run & { index?: number }>;
	summary?: { hits?: number; strongHits?: number; weak?: number; misses?: number; retryLater?: number; chargedMicros?: number; byProvider?: Record<string, number> };
	[key: string]: unknown;
}

export interface RunParams {
	endpointId: string;
	input: Record<string, unknown>;
	idempotencyKey: string;
	wait?: number;
	fallback?: boolean | FallbackOptions;
}

export interface CatalogEndpoint {
	endpointId: string;
	provider?: string;
	name?: string;
	capability?: string;
	category?: string;
	access?: 'runs_now' | 'needs_your_account' | 'coming_soon';
	estimatedPrice?: number | string | null;
	job?: { id: string; title: string };
	/** Measured: the useful-answer rate, decided runs and p50 latency. */
	works?: { rate?: number | null; runs?: number; p50Ms?: number | null; thin?: boolean };
	/** The price divided by works.rate: what one useful answer costs. */
	costPerSuccessUsd?: number | null;
	[key: string]: unknown;
}

export interface SearchResult { endpoints: CatalogEndpoint[]; total?: number; [key: string]: unknown }

export interface InspectResult {
	endpoint?: { id?: string; estimatedPrice?: unknown; [key: string]: unknown };
	inputSchema?: Record<string, unknown>;
	usageHints?: Record<string, unknown>;
	estimatedMaxCost?: number;
	[key: string]: unknown;
}

export interface Balance { available: number; reserved: number; topUpUrl?: string | null; [key: string]: unknown }

/** Thrown for any non-2xx answer. `code` is the gateway's error code, e.g. insufficient_balance. */
export class LoootError extends Error {
	constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string, readonly body?: unknown) {
		super(message);
		this.name = 'LoootError';
	}
}

export class Looot {
	readonly #base: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(options: { token: string; baseUrl: string; fetch: typeof fetch; timeoutMs?: number }) {
		this.#token = options.token;
		this.#base = options.baseUrl.replace(/\/+$/, '');
		this.#fetch = options.fetch;
		this.#timeoutMs = options.timeoutMs ?? 75_000;
	}

	async #request<T>(method: 'GET' | 'POST', path: string, options: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
		const url = new URL(this.#base + path);
		for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
		const response = await this.#fetch(url, {
			method,
			headers: { accept: 'application/json', authorization: `Bearer ${this.#token}`, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			cache: 'no-store',
			redirect: 'error',
			signal: AbortSignal.timeout(this.#timeoutMs),
		});
		const text = await response.text();
		let data: unknown = null;
		try { data = text ? JSON.parse(text) : null; } catch { data = text; }
		if (!response.ok) {
			const error = (data as { error?: { code?: string; message?: string; requestId?: string } } | null)?.error;
			throw new LoootError(response.status, error?.code ?? `http_${response.status}`, error?.message ?? `${method} ${path} failed with HTTP ${response.status}`, error?.requestId, data);
		}
		return data as T;
	}

	/** Paid. A reused idempotency key returns the same run. A resolved promise is not success: read `status`, `outcome` and `error`. */
	run({ wait, ...body }: RunParams): Promise<Run> {
		return this.#request('POST', '/v1/runs', { query: { wait }, body });
	}

	getRun(runId: string): Promise<Run> {
		return this.#request('GET', `/v1/runs/${encodeURIComponent(runId)}`);
	}

	/** Paid. A rows batch (see `BatchParams`). */
	batch({ wait, ...body }: BatchParams): Promise<BatchAnswer> {
		return this.#request('POST', '/v1/runs', { query: { wait }, body });
	}

	/** Free. The most a rows batch can cost; runs nothing. */
	quote(params: Omit<BatchParams, 'wait'>): Promise<Record<string, unknown>> {
		return this.#request('POST', '/v1/runs', { body: { ...params, quoteOnly: true } });
	}

	/** Free. Tell looot a result was wrong, with the run it came from. */
	feedback(body: { kind: 'bug' | 'idea' | 'praise' | 'question'; message: string; runId?: string; endpointId?: string; rating?: number }): Promise<{ feedbackId?: string; status?: string }> {
		return this.#request('POST', '/v1/feedback', { body });
	}

	/** Free. Ranked catalog search; `capability` lists one job's providers with their measured numbers. */
	search(params: { q: string; limit?: number; capability?: string; prefer?: Prefer }): Promise<SearchResult> {
		return this.#request('GET', '/v1/catalog/search', { query: params });
	}

	/** Free. Input schema and price formula of one endpoint. */
	inspect(endpointId: string): Promise<InspectResult> {
		return this.#request('GET', `/v1/operations/${encodeURIComponent(endpointId)}`);
	}

	/** Free. Prepaid balance in USD. */
	balance(): Promise<Balance> {
		return this.#request('GET', '/v1/balance');
	}
}
