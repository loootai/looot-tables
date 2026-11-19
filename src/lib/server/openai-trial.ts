import 'server-only';
import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';
import type { Account } from '../auth-identity';
import { meteredCall, openaiLedger, type LedgerAccess } from './credit-ledger';
import { contextSignInEnabled } from './deployment';
import { EnrichError } from './enrich-failure';

export const TRIAL_MODEL = 'gpt-6-luna';
// Nanodollars per token, standard processing, no explicit cache writes.
// https://developers.openai.com/api/docs/pricing
const INPUT_RATE = 100, CACHED_RATE = 10, OUTPUT_RATE = 500;
const MAX_OUTPUT = 4096, MAX_INPUT_BOUND = 180_000;
const trialRestriction = (message: string) => new EnrichError(message, { reason: 'input_invalid', retryable: false, provider: 'openai' });
export const trialEnabled = () => contextSignInEnabled() && process.env.ENRICHABLE_OPENAI_TRIAL_ENABLED === 'true' && Boolean(process.env.OPENAI_API_KEY?.trim()) && process.env.OPENAI_API_KEY?.trim() !== 'REPLACE_WITH_OPENAI_API_KEY';

/** Text-only UTF-8 byte bound, with headroom for message/schema framing. Every tool step is checked anew. */
export function trialInputBound(params: LanguageModelV4CallOptions) {
	for (const message of params.prompt) {
		if (message.role === 'system') continue;
		for (const part of message.content) {
			if (part.type === 'file' || part.type === 'reasoning-file' || part.type === 'custom') throw trialRestriction('AI trial requests support text only.');
		}
	}
	if (params.tools?.some((tool) => tool.type !== 'function')) throw trialRestriction('Hosted tools are not included in the AI trial.');
	const bytes = Buffer.byteLength(JSON.stringify({ prompt: params.prompt, tools: params.tools, responseFormat: params.responseFormat }), 'utf8');
	const bound = bytes + 8192 + params.prompt.length * 256 + (params.tools?.length ?? 0) * 512;
	if (bound > MAX_INPUT_BOUND) throw trialRestriction('This request is too large for the AI trial. Reduce the input or add your own OpenAI key.');
	return bound;
}

export function trialCharge(usage: LanguageModelV4Usage): number | null {
	const input = usage.inputTokens.total, output = usage.outputTokens.total, cached = usage.inputTokens.cacheRead ?? 0;
	if ([input, output, cached].some((value) => value === undefined || !Number.isSafeInteger(value) || value < 0) || cached > input! || (usage.inputTokens.cacheWrite ?? 0) > 0) return null;
	return (input! - cached) * INPUT_RATE + cached * CACHED_RATE + output! * OUTPUT_RATE;
}

export function trialMiddleware(account: Account, access: LedgerAccess = openaiLedger): LanguageModelMiddleware {
	return {
		specificationVersion: 'v4',
		transformParams: async ({ params }) => {
			trialInputBound(params);
			return { ...params, headers: undefined, maxOutputTokens: Math.min(params.maxOutputTokens ?? MAX_OUTPUT, MAX_OUTPUT), reasoning: 'none', providerOptions: { openai: { store: false, serviceTier: 'default' } } };
		},
		wrapGenerate: async ({ params, doGenerate }) => meteredCall(access, account, trialInputBound(params) * INPUT_RATE + (params.maxOutputTokens ?? MAX_OUTPUT) * OUTPUT_RATE, async (meter) => {
			const result = await doGenerate();
			meter.charge = trialCharge(result.usage);
			return result;
		}),
		wrapStream: async () => { throw trialRestriction('Direct model streaming is not enabled for AI trial requests.'); },
	};
}
