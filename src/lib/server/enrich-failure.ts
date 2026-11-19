import 'server-only';
import { APICallError, RetryError, type LanguageModelMiddleware } from 'ai';
import { APIConnectionError as ContextConnectionError, APIConnectionTimeoutError as ContextTimeoutError, APIError as ContextError } from 'context.dev';
import { APIConnectionError as TypeSafeConnectionError, APITimeoutError as TypeSafeTimeoutError, TypeSafeError } from '@typesafe-ai/sdk';
import type { EnrichFailure, FailureProvider, FailureReason } from '../types';

/* The retry rule for every billable provider. A failure is retryable only when the provider did no work for it: the
   request never reached the provider (`neverSent`), the provider refused it before processing (429), or our own
   pre-flight refused it (the credit ledger's rate limit, company research busy or just failed). Anything after the request was sent (a timeout, a server
   error, a connection reset, a truncated answer) may have been billed, so nothing repeats it automatically, and no
   failure is retryable once its run spent anything (`afterSpend`). The SDKs' own retries are off: their transport
   resends only what this rule allows (`retryUnbilled`), and each run's `Spend` is recorded at the same layer, by the
   clients `ProviderAccess` hands out (`trackedFetch`, `spendMiddleware`), never by the operations that call them. */

/** A failure the server understands. The message is for people; code branches on `failure`. */
export class EnrichError extends Error {
	constructor(message: string, readonly failure: EnrichFailure) { super(message); }
}

export function failure(reason: FailureReason, provider?: FailureProvider, retryable = reason === 'rate_limited'): EnrichFailure {
	return { reason, retryable, ...(provider ? { provider } : {}) };
}

export const inputError = (message: string, provider?: FailureProvider) => new EnrichError(message, failure('input_invalid', provider));

/** Running the operation again would pay again for what it already spent. */
export const afterSpend = (outcome: EnrichFailure, spent: boolean): EnrichFailure => spent && outcome.retryable ? { ...outcome, retryable: false } : outcome;

/** Connection failures that prove a request never reached the provider. */
const UNSENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/** Whether an error, or one it wraps, proves the request never reached the provider. */
export function neverSent(error: unknown): boolean {
	for (let cause = error, depth = 0; cause && typeof cause === 'object' && depth < 5; cause = (cause as { cause?: unknown }).cause, depth++) {
		const code = (cause as { code?: unknown }).code;
		if (typeof code === 'string' && UNSENT.has(code)) return true;
	}
	return false;
}

/** Whether a failed request provably cost nothing: it never reached the provider, or the provider refused it (429). */
export function unbilled(error: unknown): boolean {
	const status = APICallError.isInstance(error) ? error.statusCode : error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
	return status === 429 || neverSent(error);
}

/** What one run spent: whether any provider did, or may have done, billable work for it, and the Context.dev credits it
    consumed (shown on the cell). */
export class Spend {
	paid = false;
	credits = 0;
	record(credits = 0) { this.paid = true; this.credits += credits; }
}

export interface Metering {
	/** Whether the provider may have billed a response; anything but a 429 by default. */
	billed?: (response: Response) => boolean;
	/** The credits a billed response consumed. */
	credits?: (response: Response, input: RequestInfo | URL, init?: RequestInit) => Promise<number>;
}

/** A transport that records into `spend` every request its provider may have billed. It wraps `retryUnbilled`, so it
    sees one final outcome per request, not the resends. */
export function trackedFetch(transport: typeof fetch, spend: Spend, { billed = (response) => response.status !== 429, credits }: Metering = {}): typeof fetch {
	return async (input, init) => {
		let response: Response;
		try { response = await transport(input, init); }
		catch (error) {
			if (!unbilled(error)) spend.record();
			throw error;
		}
		if (billed(response)) spend.record(await credits?.(response, input, init).catch(() => 0));
		return response;
	};
}

/** Records each model call OpenAI may have billed: one that answered, or failed other than refused or never sent. Our
    own refusals (`EnrichError`: the endpoint guard, the trial's limits and its ledger) never reached OpenAI. */
export function spendMiddleware(spend: Spend): LanguageModelMiddleware {
	const tracked = async <T>(call: () => PromiseLike<T>): Promise<T> => {
		try {
			const result = await call();
			spend.record();
			return result;
		} catch (error) {
			if (!(error instanceof EnrichError) && !unbilled(error)) spend.record();
			throw error;
		}
	};
	return { specificationVersion: 'v4', wrapGenerate: ({ doGenerate }) => tracked(doGenerate), wrapStream: ({ doStream }) => tracked(doStream) };
}

/** A transport that resends a request only when the rule allows: rate limited, or never connected. Resends stay within
    the SDK's timeout for the call. */
export function retryUnbilled(transport: typeof fetch, delayMs = 500): typeof fetch {
	return async (input, init) => {
		for (let attempt = 0; ; attempt++) {
			const last = attempt >= 2;
			try {
				const response = await transport(input, init);
				if (response.status !== 429 || last) return response;
				// Not awaited: the shared cache tees its responses, and cancelling one branch settles only with the other.
				void response.body?.cancel().catch(() => {});
			} catch (error) {
				if (last || !neverSent(error)) throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** attempt));
			init?.signal?.throwIfAborted();
		}
	};
}

/** Maps an upstream HTTP status. Only a 429 was refused before processing: Context.dev answers 408 at its own deadline,
    after doing the work, and a server error may come after it too. */
export function httpFailure(status: number | undefined, provider?: FailureProvider, body = ''): EnrichFailure {
	if (status === 429) return /insufficient_quota|billing_hard_limit/.test(body) ? failure('credits_exhausted', provider) : failure('rate_limited', provider);
	if (status === 401 || status === 403) return failure('credential_invalid', provider);
	if (status === 402) return failure('credits_exhausted', provider);
	if (status === 408 || status === 504) return failure('timeout', provider);
	if (status === 400 || status === 413 || status === 422) return failure('input_invalid', provider);
	return failure('provider_error', provider);
}

/** Structured outcome for an error, or undefined when the server cannot tell why it failed. */
export function classifyFailure(error: unknown, provider?: FailureProvider): EnrichFailure | undefined {
	if (error instanceof EnrichError) return provider && !error.failure.provider ? { ...error.failure, provider } : error.failure;
	if (RetryError.isInstance(error)) return classifyFailure(error.lastError, provider);
	const source = APICallError.isInstance(error) ? 'openai' : error instanceof ContextError ? 'context' : error instanceof TypeSafeError ? 'typesafe' : provider;
	if (neverSent(error)) return failure('provider_error', source, true);
	if (APICallError.isInstance(error)) return httpFailure(error.statusCode, source, error.responseBody);
	if (error instanceof ContextTimeoutError || error instanceof TypeSafeTimeoutError || (error instanceof Error && error.name === 'TimeoutError')) return failure('timeout', source);
	if (error instanceof ContextConnectionError || error instanceof TypeSafeConnectionError) return failure('provider_error', source);
	const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
	return typeof status === 'number' ? httpFailure(status, source) : undefined;
}
