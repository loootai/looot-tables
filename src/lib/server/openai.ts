import 'server-only';

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import type { Account } from '../auth-identity';
import { retryUnbilled } from './enrich-failure';
import { TRIAL_MODEL, trialMiddleware } from './openai-trial';

/** The OpenAI SDK adapter behind ProviderAccess.openai(). The default factory uses the Responses API; a custom base URL switches to Chat Completions, which OpenAI-compatible servers support.
    Every call is sent with `maxRetries: 0`: the transport resends only a request OpenAI refused (429) or never received,
    with the SDK's old backoff, inside one model call, so a trial call keeps one ledger hold however often it is resent. */
export function openaiModel(apiKey: string, model: string, baseUrl?: string | null, trialAccount?: Account): LanguageModelV4 {
	const transport = (redirect?: RequestRedirect) => retryUnbilled((input, init) => fetch(input, redirect ? { ...init, redirect } : init), 2_000);
	if (trialAccount) return wrapLanguageModel({ model: createOpenAI({ apiKey, baseURL: 'https://api.openai.com/v1', fetch: transport() })(TRIAL_MODEL), middleware: trialMiddleware(trialAccount) });
	if (baseUrl) return createOpenAI({ apiKey, baseURL: baseUrl, fetch: transport('error') }).chat(model);
	return createOpenAI({ apiKey, fetch: transport() })(model);
}
