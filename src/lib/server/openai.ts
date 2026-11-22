import 'server-only';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { retryUnbilled } from './enrich-failure';

/** The OpenAI SDK adapter behind ProviderAccess.openai(). The default factory uses the Responses API; a custom base URL switches to Chat Completions, which OpenAI-compatible servers support.
    Every call is sent with `maxRetries: 0`: the transport resends only a request OpenAI refused (429) or never received,
    with the SDK's old backoff, inside one model call. */
export function openaiModel(apiKey: string, model: string, baseUrl?: string | null): LanguageModelV4 {
	const transport = (redirect?: RequestRedirect) => retryUnbilled((input, init) => fetch(input, redirect ? { ...init, redirect } : init), 2_000);
	if (baseUrl) return createOpenAI({ apiKey, baseURL: baseUrl, fetch: transport('error') }).chat(model);
	return createOpenAI({ apiKey, fetch: transport() })(model);
}

/** A Claude model on the caller's own Anthropic key, for the in-app agent. Resent only when Anthropic refused (429) or
    never received the request, like OpenAI calls. */
export function anthropicModel(apiKey: string, model: string): LanguageModelV4 {
	return createAnthropic({ apiKey, fetch: retryUnbilled((input, init) => fetch(input, init), 2_000) })(model);
}
