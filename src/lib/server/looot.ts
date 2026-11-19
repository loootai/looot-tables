import 'server-only';

import { randomUUID } from 'node:crypto';
import { Looot, LoootError, type BatchAnswer, type BatchParams, type FallbackOptions, type Prefer, type RouteAttempt, type Run, type RunOutcome } from './looot-api';
import type { LoootCallMeta, NextStep } from '../types';
import { CredentialError } from './credentials';
import { EnrichError, failure, retryUnbilled, type Spend } from './enrich-failure';

/* Every outside lookup in the app is one looot run. This module is the only place that talks to the looot REST API:
   it sends a run, waits for it to settle, reads status, outcome and error from the run body (never the HTTP code),
   records what the run cost into the enrichment's `Spend`, and keeps a compact record of the call for the cell panel. */

export const LOOOT_API = 'https://api.looot.ai';

/** The looot API this deployment talks to: the hosted one, or LOOOT_API_URL for a proxy or a local stand-in. Server-side only. */
export const loootApiUrl = () => process.env.LOOOT_API_URL?.trim().replace(/\/+$/, '') || LOOOT_API;

/** The looot jobs this app runs. Each id was checked against the live catalog overview. */
export const JOBS = {
	webSearch: 'web.search',
	scrape: 'web.scrape.markdown',
	companySearch: 'company.search',
	peopleSearch: 'people.search',
	companyEnrich: 'company.enrich',
	linkedinProfile: 'linkedin.person.profile',
	peopleEnrich: 'people.enrich',
	emailFind: 'people.email.find',
	emailVerify: 'people.email.verify',
	phoneFind: 'people.phone.find',
} as const;
export type JobId = (typeof JOBS)[keyof typeof JOBS];

export const PREFER_VALUES = ['balanced', 'cheapest', 'reliable', 'fastest'] as const;
export type { Prefer };

/** Seconds one request waits for the run to settle; looot allows up to 60. */
const WAIT_SECONDS = 45;
/** Longest a run may stay unsettled before the cell reports a timeout instead of polling on. */
const SETTLE_DEADLINE_MS = 120_000;
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'stopped']);

export interface RunOptions {
	prefer?: Prefer;
	/** Cap for the whole route in USD. */
	maxCostUsd?: number;
	/** `false` runs the named provider only. Jobs always walk to the next provider on a miss. */
	fallback?: boolean | FallbackOptions;
	signal?: AbortSignal;
}

/** What one settled run gave back. `fields` is looot's `normalized.fields` when the job has one; `result` is the
    provider's own body, whose shape differs from provider to provider. */
export interface LoootResult {
	run: Run;
	outcome: RunOutcome;
	costUsd: number;
	fields: Record<string, unknown>;
	result: unknown;
	call: LoootCallMeta;
}

/** A client bound to one token and one enrichment's spend record. */
export class LoootClient {
	readonly #api: Looot;
	readonly #spend: Spend;
	readonly #calls: LoootCallMeta[];
	readonly #attempt: string;
	readonly #capUsd: number | undefined;
	#sequence = 0;

	/** `capUsd` is the most this client's runs may spend together: each job run is sent with the rest as
	    fallback.maxCostUsd, and no run starts once it is used up. */
	constructor(options: { token: string; spend: Spend; calls?: LoootCallMeta[]; attempt?: string; capUsd?: number; baseUrl?: string; fetch?: typeof fetch }) {
		this.#spend = options.spend;
		this.#calls = options.calls ?? [];
		this.#attempt = options.attempt ?? randomUUID();
		this.#capUsd = options.capUsd && options.capUsd > 0 ? options.capUsd : undefined;
		// Only a 429 or a connection that never opened is resent, and the resend carries the same idempotency key.
		this.#api = new Looot({ token: options.token, baseUrl: options.baseUrl ?? loootApiUrl(), fetch: retryUnbilled(options.fetch ?? ((input, init) => globalThis.fetch(input, init))), timeoutMs: 75_000 });
	}

	/** Every call this client made, in order. */
	get calls(): readonly LoootCallMeta[] {
		return this.#calls;
	}

	/** A fresh key for each call of this cell attempt; a resend of the same call reuses it. */
	#key(): string {
		return `lt-${this.#attempt}-${++this.#sequence}`;
	}

	/** What this client may still spend, or undefined without a cap. */
	get remainingUsd(): number | undefined {
		return this.#capUsd === undefined ? undefined : Math.max(0, Math.round((this.#capUsd - this.#spend.costUsd) * 1e6) / 1e6);
	}

	/** The cap for the next run: the caller's, never above what is left. Throws once nothing is left. */
	#maxCost(requested?: number): number | undefined {
		const remaining = this.remainingUsd;
		if (remaining !== undefined && remaining <= 0) throw new EnrichError(`This cell reached its spend cap of $${this.#capUsd}. Nothing more was run for it.`, failure('spend_capped', 'looot'));
		if (remaining === undefined) return requested || undefined;
		return requested ? Math.min(requested, remaining) : remaining;
	}

	/** Run a job. looot picks the provider (in `prefer` order) and walks to the next one on a miss. */
	async job(job: string, input: Record<string, unknown>, options: RunOptions = {}): Promise<LoootResult> {
		const maxCostUsd = this.#maxCost(options.maxCostUsd);
		const fallback: FallbackOptions | boolean = options.fallback === false ? false : { ...(typeof options.fallback === 'object' ? options.fallback : {}), enabled: true, ...(options.prefer ? { prefer: options.prefer } : {}), ...(maxCostUsd ? { maxCostUsd } : {}) };
		return this.#run(`job:${job}`, input, fallback, options.signal);
	}

	/** Run one named endpoint, with fallback to the job's other providers only when asked. */
	async endpoint(endpointId: string, input: Record<string, unknown>, options: RunOptions = {}): Promise<LoootResult> {
		const maxCostUsd = this.#maxCost(options.maxCostUsd);
		const fallback = options.fallback ? { ...(typeof options.fallback === 'object' ? options.fallback : {}), enabled: true, ...(maxCostUsd ? { maxCostUsd } : {}) } : false;
		return this.#run(endpointId, input, fallback, options.signal);
	}

	/** One call of a rows batch. The same `idempotencyKey` continues an incomplete batch: settled rows replay at no charge. */
	async batch(params: Omit<BatchParams, 'wait'>, signal?: AbortSignal): Promise<BatchAnswer> {
		signal?.throwIfAborted();
		try {
			const answer = await this.#api.batch({ ...params, wait: 50 });
			return answer;
		} catch (error) {
			throw this.#httpFailure(error);
		}
	}

	/** Free. The most a rows batch can cost, in USD, or null when looot's answer names no total. */
	async quote(params: Omit<BatchParams, 'wait'>): Promise<number | null> {
		try { return quotedUsd(await this.#api.quote(params)); }
		catch (error) { throw this.#httpFailure(error); }
	}

	/** Free. Report a wrong result against its run. */
	feedback(body: Parameters<Looot['feedback']>[0]) {
		return this.#api.feedback(body);
	}

	async #run(endpointId: string, input: Record<string, unknown>, fallback: boolean | FallbackOptions, signal?: AbortSignal): Promise<LoootResult> {
		signal?.throwIfAborted();
		const idempotencyKey = this.#key();
		let run: Run;
		try {
			run = await this.#api.run({ endpointId, input, idempotencyKey, wait: WAIT_SECONDS, ...(fallback ? { fallback } : {}) });
			const deadline = Date.now() + SETTLE_DEADLINE_MS;
			while (!TERMINAL.has(run.status) && Date.now() < deadline) {
				signal?.throwIfAborted();
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				run = await this.#api.getRun(run.runId);
			}
		} catch (error) {
			throw this.#httpFailure(error);
		}
		const costUsd = runCost(run);
		const call = callMeta(run, endpointId);
		this.#calls.push(call);
		// An unsettled run may still bill; record it as paid so nothing reruns it automatically.
		if (costUsd > 0 || !TERMINAL.has(run.status)) this.#spend.record(costUsd);
		if (!TERMINAL.has(run.status)) throw new EnrichError('looot has not settled this run yet. Check it in your usage page before running it again.', failure('timeout', 'looot', false));
		const result: LoootResult = { run, outcome: run.outcome ?? (run.status === 'completed' ? 'hit' : 'error'), costUsd, fields: normalizedFields(run), result: run.result, call };
		const failed = runFailure(run, costUsd);
		if (failed) throw failed;
		return result;
	}

	/** An HTTP-level failure, before any run settled. Nothing was billed unless the request may have been processed. */
	#httpFailure(error: unknown): Error {
		if (error instanceof EnrichError || error instanceof CredentialError) return error;
		if (error instanceof LoootError) {
			const text = error.message || `looot answered ${error.status}`;
			if (error.status === 401 || error.status === 403) return new CredentialError('looot rejected this token. Update it in Configuration.', 401, 'credential_invalid', 'looot');
			if (error.status === 402 || error.code === 'insufficient_balance') return new EnrichError('Your looot balance is too low for this run. Top up at https://looot.ai/usage and run it again.', failure('credits_exhausted', 'looot'));
			if (error.status === 429) return new EnrichError('looot rate limited this request. Wait a moment and try again.', failure('rate_limited', 'looot'));
			if (error.status === 400 || error.status === 422) return new EnrichError(text, failure('input_invalid', 'looot'));
			this.#spend.record();
			return new EnrichError(`looot request failed (${error.status}). ${text}`, failure('provider_error', 'looot'));
		}
		this.#spend.record();
		if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return new EnrichError('looot did not answer in time. The run may still be settling, so check your usage before running it again.', failure('timeout', 'looot'));
		return error instanceof Error ? error : new Error(String(error));
	}

	/** Free. Ranked catalog search. */
	search(query: string, limit = 10, filters: { capability?: string; prefer?: Prefer } = {}) {
		return this.#api.search({ q: query, limit, ...filters });
	}

	/** Free. Input schema and price formula of one endpoint. */
	inspect(endpointId: string) {
		return this.#api.inspect(endpointId);
	}

	/** Free. Prepaid balance in USD. */
	balance() {
		return this.#api.balance();
	}
}

/** A settled run as the operations read it, without recording spend (a batch records its own). */
export function settledResult(run: Run, requested: string): LoootResult {
	return { run, outcome: run.outcome ?? (run.status === 'completed' ? 'hit' : 'error'), costUsd: runCost(run), fields: normalizedFields(run), result: run.result, call: callMeta(run, requested) };
}

/** The total a quoteOnly answer names, in USD. The public docs say it is "the batch quote (the most it can cost)" without
    naming the field, so the usual names are all read. */
export function quotedUsd(answer: Record<string, unknown>): number | null {
	const quote = (answer.quote && typeof answer.quote === 'object' ? answer.quote : answer) as Record<string, unknown>;
	for (const key of ['maxCostUsd', 'maxUsd', 'estimatedMaxCost', 'estimatedMaxCostUsd', 'totalUsd']) if (typeof quote[key] === 'number' && Number.isFinite(quote[key])) return quote[key] as number;
	for (const key of ['maxCostMicros', 'estimatedMaxCostMicros', 'totalMicros']) if (typeof quote[key] === 'number' && Number.isFinite(quote[key])) return (quote[key] as number) / 1e6;
	return null;
}

/** Follow-up jobs a run suggests, trimmed to what the sheet keeps. Provider wording never comes along. */
export function nextStepsOf(run: Run): NextStep[] {
	if (!Array.isArray(run.nextSteps)) return [];
	return run.nextSteps.slice(0, 3).flatMap((step) => {
		const job = typeof step.job === 'string' ? step.job : typeof step.run?.endpointId === 'string' && step.run.endpointId.startsWith('job:') ? step.run.endpointId.slice(4) : '';
		if (!/^[a-z0-9_.-]{3,80}$/i.test(job)) return [];
		const input = step.run?.input ?? step.input ?? {};
		return [{ ...(typeof (step.suggestionId ?? step.run?.suggestionId) === 'string' ? { suggestionId: String(step.suggestionId ?? step.run?.suggestionId) } : {}), job, title: typeof step.title === 'string' ? step.title.slice(0, 80) : job, priceUsd: typeof step.priceUsd === 'number' && Number.isFinite(step.priceUsd) ? step.priceUsd : null, input: typeof input === 'object' && input ? Object.fromEntries(Object.entries(input).slice(0, 12).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))) : {} }];
	});
}

/** A copy of normalized fields small enough to keep on a cell. */
function compactFields(fields: Record<string, unknown>): Record<string, unknown> | undefined {
	const kept = Object.fromEntries(Object.entries(fields).slice(0, 40).filter(([, value]) => value !== null && value !== undefined && JSON.stringify(value).length <= 600));
	return Object.keys(kept).length ? kept : undefined;
}

/** What a run cost in USD: the settled charge, else the route's total. */
export function runCost(run: Run): number {
	const cost = typeof run.actualCost === 'number' ? run.actualCost : typeof run.route?.chargedUsd === 'number' ? run.route.chargedUsd : 0;
	return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/** looot's own field map for the job, when it has one. */
export function normalizedFields(run: Run): Record<string, unknown> {
	const fields = run.normalized?.fields;
	return fields && typeof fields === 'object' && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {};
}

function attemptMeta(attempt: RouteAttempt): NonNullable<LoootCallMeta['attempts']>[number] {
	return { provider: attempt.provider, endpointId: attempt.endpointId, outcome: attempt.outcome, costUsd: typeof attempt.chargedUsd === 'number' ? attempt.chargedUsd : 0, ...(typeof attempt.ms === 'number' ? { ms: Math.round(attempt.ms) } : {}), ...(attempt.reason ? { reason: String(attempt.reason).slice(0, 200) } : {}) };
}

/** The compact record of one run kept on the cell. Provider wording is data, so it is trimmed and never executed. */
export function callMeta(run: Run, requested: string): LoootCallMeta {
	const attempts = run.route?.attempts?.map(attemptMeta);
	const served = run.route?.attempts?.find((attempt) => attempt.endpointId === run.route?.servedBy) ?? run.route?.attempts?.at(-1);
	const raw = run as unknown as { servedProviderId?: unknown; servedEndpointId?: unknown };
	const endpointId = (typeof raw.servedEndpointId === 'string' && raw.servedEndpointId) || run.route?.servedBy || run.endpointId || requested;
	const provider = served?.provider ?? (typeof raw.servedProviderId === 'string' ? raw.servedProviderId : undefined);
	const normalized = compactFields(normalizedFields(run));
	const nextSteps = nextStepsOf(run);
	return {
		runId: run.runId,
		job: requested.startsWith('job:') ? requested.slice(4) : undefined,
		endpointId,
		...(provider ? { provider } : {}),
		outcome: run.outcome ?? (run.status === 'completed' ? 'hit' : 'error'),
		costUsd: runCost(run),
		...(attempts?.length ? { attempts } : {}),
		...(run.route?.skipped?.length ? { skipped: run.route.skipped.length } : {}),
		...(run.route?.capped ? { capped: true } : {}),
		...(normalized ? { normalized } : {}),
		...(nextSteps.length ? { nextSteps } : {}),
	};
}

/** The failure a settled run reports, or null when it answered (a miss is an answer). Nothing here is retryable once
    the run was billed. */
export function runFailure(run: Run, costUsd = runCost(run)): EnrichError | null {
	const error = run.error;
	if (run.status === 'completed' && run.outcome !== 'error' && run.outcome !== 'rejected') return null;
	const message = (error?.message ?? run.outcomeReason ?? 'looot could not complete this run.').slice(0, 400);
	if (error?.code === 'insufficient_balance' || run.status === 'blocked') return new EnrichError('Your looot balance is too low for this run. Top up at https://looot.ai/usage and run it again.', failure('credits_exhausted', 'looot'));
	if (run.outcome === 'rejected' || error?.whoseError === 'customer' || error?.code === 'validation_error') return new EnrichError(message, failure('input_invalid', 'looot'));
	if (error?.providerStatus === 429 || error?.code === 'rate_limited') return new EnrichError(message, failure('rate_limited', 'looot', costUsd === 0));
	if (error?.providerStatus === 401 || error?.providerStatus === 403) return new EnrichError(message, failure('provider_error', 'looot'));
	return new EnrichError(message, failure('provider_error', 'looot', Boolean(error?.retryable) && costUsd === 0));
}
