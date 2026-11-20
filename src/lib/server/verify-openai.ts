import type { KeyVerification } from '../types';

type Result = KeyVerification['openai'];

/** A model-list check is free; inference validates model and billing access with a tiny, bounded request. */
export async function verifyOpenAI(key: string, model: string, baseUrl: string | null, inference = false): Promise<Result> {
	try {
		const base = baseUrl ?? 'https://api.openai.com/v1';
		const response = await fetch(`${base}/${inference ? (baseUrl ? 'chat/completions' : 'responses') : 'models'}`, {
			method: inference ? 'POST' : 'GET',
			headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
			body: inference ? JSON.stringify(baseUrl
				? { model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_completion_tokens: 64, store: false }
				: { model, input: 'Reply with OK.', max_output_tokens: 64, store: false }) : undefined,
			signal: AbortSignal.timeout(20_000),
			cache: 'no-store',
			redirect: 'error',
		});
		if (!response.ok) {
			if (response.status === 401) return { ok: false, issue: 'key', message: 'This key was rejected. Create a new key and paste it here.' };
			// Read codes for recovery, but never echo provider text that could contain credentials.
			const code = (await response.json().catch(() => null))?.error?.code;
			if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' || response.status === 402) return { ok: false, issue: 'billing', message: 'API billing needs attention. Add credits or check your project spending limit, then test again.' };
			if (code === 'model_not_found' || response.status === 404) return { ok: false, issue: 'model', message: `The selected model (${model}) is unavailable. Choose another model and test again.` };
			if (!inference && response.status === 403) return { ok: true, message: 'Model listing is restricted. Run the inference test to check this key.' };
			if (response.status === 403) return { ok: false, issue: 'model', message: 'This key or project cannot use the selected model. Check its permissions in OpenAI.' };
			if (response.status === 429) return { ok: false, issue: 'rate-limit', message: 'OpenAI is rate limiting requests. Wait a moment, then test again.' };
			return { ok: false, issue: 'connection', message: `The provider could not complete the check (${response.status}). Try again.` };
		}
		if (!inference) return { ok: true, message: 'Key accepted. Test inference to confirm model and billing access.' };
		const data = await response.json().catch(() => null);
		const text = baseUrl
			? data?.choices?.[0]?.message?.content
			: data?.output?.flatMap((item: { content?: Array<{ type: string; text?: string }> }) => item.content ?? []).filter((item: { type: string }) => item.type === 'output_text').map((item: { text?: string }) => item.text ?? '').join('');
		if ((!baseUrl && data?.status !== 'completed') || typeof text !== 'string' || !text.trim()) return { ok: false, issue: 'connection', message: 'The test did not return a completed answer. Try again or choose another model in Configuration.' };
		return { ok: true, inference: true, message: 'Inference works. Your connection is ready.' };
	} catch {
		return { ok: false, issue: 'connection', message: 'Could not reach the provider before the check timed out. Try again.' };
	}
}
