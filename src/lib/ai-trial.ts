import type { EnrichFailure } from './types';

export const OPENAI_KEY_REQUIRED = 'An OpenAI API key is required for future AI requests.';
export const OPENAI_KEY_REQUIRED_EVENT = 'looot-tables:openai-key-required';

/** Ask for an OpenAI key when the AI trial is used up or no key is available. Message text is only a fallback for responses without `failure`. */
export function notifyTrialLimit(message?: string, failure?: EnrichFailure) {
	if (typeof window === 'undefined') return;
	const required = failure ? failure.provider === 'openai' && (failure.reason === 'credits_exhausted' || failure.reason === 'credential_missing') : Boolean(message?.includes(OPENAI_KEY_REQUIRED));
	if (required) window.dispatchEvent(new CustomEvent(OPENAI_KEY_REQUIRED_EVENT, { detail: message || OPENAI_KEY_REQUIRED }));
}
