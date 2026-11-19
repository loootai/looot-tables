'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import { keyHeaders, type Settings } from '@/lib/keys';
import type { Provider } from '@/lib/organization-settings';
import type { KeyVerification } from '@/lib/types';

export type ProviderCheck = { ok: boolean; message?: string; credits?: number; issue?: string };

/** Debounced check of only the listed providers. Inference (a billed test call) runs only when the OpenAI key or model changed. */
export function useVerification(settings: Settings, providers: readonly Provider[], { inference = false, version = '' }: { inference?: boolean; version?: string } = {}) {
	const signature = providers.length ? JSON.stringify([settings, providers, inference, version]) : '';
	const [state, setState] = useState<{ signature: string; result?: KeyVerification; error?: string } | null>(null);
	// The signature changes exactly when these inputs do, so the effect reads them as of its own render.
	const request = useEffectEvent(() => ({ query: new URLSearchParams({ only: providers.join(','), ...(inference ? { inference: 'true' } : {}) }), headers: keyHeaders(settings) }));
	useEffect(() => {
		if (!signature) return;
		const controller = new AbortController();
		const { query, headers } = request();
		const timer = setTimeout(() => {
			fetch(`/api/keys/verify?${query}`, { method: 'POST', headers, signal: controller.signal })
				.then(async (response) => { if (!response.ok) throw new Error('Unavailable'); return await response.json() as KeyVerification; })
				.then((result) => { if (!controller.signal.aborted) setState({ signature, result }); })
				.catch(() => { if (!controller.signal.aborted) setState({ signature, error: 'Could not check right now. It will be checked again on first use.' }); });
		}, 400);
		return () => { clearTimeout(timer); controller.abort(); };
	}, [signature]);
	const current = state?.signature === signature ? state : null;
	return { checking: Boolean(signature) && !current, result: current?.result, error: current?.error };
}

export function providerCheck(result: KeyVerification | undefined, provider: Provider): ProviderCheck | undefined {
	if (!result) return undefined;
	if (provider === 'openai') return result.openai;
	if (provider === 'context') return result.context;
	if (provider === 'typesafe') return result.typesafe.configured ? result.typesafe : undefined;
	if (provider === 'hunter' || provider === 'prospeo') return result[provider]?.configured ? result[provider] : undefined;
	return undefined;
}
