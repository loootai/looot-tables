'use client';

import { loootRequest } from './looot-requests';
import { notifyTrialLimit } from './ai-trial';
import { keyHeaders, loadSettings, type Settings } from './keys';
import type { Provider } from './organization-settings';
import { FAILURE_REASONS, type ColumnOp, type ComposeColumnResponse, type EnrichFailure, type EnrichResponse, type FailureProvider, type KeyVerification, type CellValue, type EntityKind } from './types';

export const ENRICHMENT_REQUEST_MS = 330_000;

export class ApiError extends Error {
	status: number;
	/** Why the request failed, when the server says. Branch on this, never on the message. */
	failure?: EnrichFailure;
	constructor(message: string, status: number, failure?: EnrichFailure) {
		super(message);
		this.status = status;
		this.failure = failure;
	}
}

const FAILURE_PROVIDERS: readonly FailureProvider[] = ['openai', 'looot', 'typesafe', 'moltsets'];

/** Accept only a well-formed failure from the response body. */
export function parseFailure(value: unknown): EnrichFailure | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const { reason, retryable, provider } = value as Record<string, unknown>;
	if (!(FAILURE_REASONS as readonly unknown[]).includes(reason) || typeof retryable !== 'boolean') return undefined;
	return { reason: reason as EnrichFailure['reason'], retryable, ...((FAILURE_PROVIDERS as readonly unknown[]).includes(provider) ? { provider: provider as FailureProvider } : {}) };
}

export async function readError(response: Response): Promise<ApiError> {
	let message = `Request failed (${response.status})`, failure: EnrichFailure | undefined;
	try {
		const data = (await response.json()) as { error?: unknown; failure?: unknown };
		if (typeof data.error === 'string' && data.error) message = data.error;
		failure = parseFailure(data.failure);
		notifyTrialLimit(message, failure);
	} catch { /* keep the status message */ }
	return new ApiError(message, response.status, failure);
}

export async function enrichCell(op: ColumnOp, row: Record<string, CellValue>, signal?: AbortSignal, attempt?: string): Promise<EnrichResponse> {
	const settings = loadSettings();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), ENRICHMENT_REQUEST_MS);
	try {
		const response = await loootRequest('/api/enrich', {
			method: 'POST',
			headers: { ...keyHeaders(), 'x-prefer-jev': settings.preferJev ? 'true' : 'false' },
			body: JSON.stringify({ op, row, ...(attempt ? { attempt } : {}) }),
			signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
		});
		if (!response.ok) throw await readError(response);
		const result = (await response.json()) as EnrichResponse;
		const failure = parseFailure(result.failure);
		notifyTrialLimit(result.error, failure);
		return { ...result, failure };
	} catch (error) {
		// A request that outlived the deadline may have been billed, so the runner does not retry it (as the server marks
		// its own provider timeouts).
		if (deadline.signal.aborted && !signal?.aborted) throw new ApiError('This enrichment took too long. Run this cell again.', 0, { reason: 'timeout', retryable: false });
		throw error;
	} finally { clearTimeout(timer); }
}

export async function composeColumn(input: { ask: string; columns: Array<{ name: string; type: 'source' | 'enriched'; sample?: string }>; entity?: EntityKind; hasJev: boolean; excludeFormula?: boolean }): Promise<ComposeColumnResponse> {
	const response = await fetch('/api/compose-column', { method: 'POST', headers: keyHeaders(), body: JSON.stringify(input) });
	if (!response.ok) throw await readError(response);
	return (await response.json()) as ComposeColumnResponse;
}

export async function verifyKeys(options: { settings?: Settings; signal?: AbortSignal; openaiOnly?: boolean; only?: readonly Provider[]; inference?: boolean } = {}): Promise<KeyVerification> {
	const query = new URLSearchParams();
	if (options.openaiOnly) query.set('openaiOnly', 'true');
	if (options.only) query.set('only', options.only.join(','));
	if (options.inference) query.set('inference', 'true');
	const response = await fetch(`/api/keys/verify?${query}`, { method: 'POST', headers: keyHeaders(options.settings), signal: options.signal });
	if (!response.ok) throw await readError(response);
	return (await response.json()) as KeyVerification;
}

export interface ServerKeys {
	openai: boolean;
	looot: boolean;
	typesafe: boolean;
	moltsets: boolean;
	passwordRequired: boolean;
}

export async function serverKeys(): Promise<ServerKeys> {
	const response = await fetch('/api/keys/verify', { headers: keyHeaders() });
	if (!response.ok) throw await readError(response);
	return (await response.json()) as ServerKeys;
}

export async function buildFormula(input: import('./formula-builder').FormulaBuilderRequest, signal?: AbortSignal): Promise<import('./formula-builder').FormulaBuilderResponse> {
	const response = await fetch('/api/formula-builder', { method: 'POST', headers: keyHeaders(), body: JSON.stringify(input), signal });
	if (!response.ok) throw await readError(response);
	return await response.json();
}
