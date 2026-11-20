'use client';

import { keyHeaders } from '@/lib/keys';
import { liveResource, useLiveStore } from '@/lib/live-store';

interface PollOptions { intervalMs?: number; minGapMs?: number; events?: readonly string[] }

/** Coalesces bursts of refresh triggers, spaces requests by `minGapMs` (the usage APIs are rate limited), and stops with `signal`. */
function poll(url: string, { intervalMs, minGapMs = 2_000, events = [] }: PollOptions, signal: AbortSignal, onResult: (response: Response | null) => Promise<void>) {
	let pending = false, inFlight = false, lastStarted = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = async () => {
		timer = undefined; pending = false; inFlight = true; lastStarted = Date.now();
		try { await onResult(await fetch(url, { headers: keyHeaders(), cache: 'no-store', signal })); }
		catch { if (!signal.aborted) await onResult(null); }
		finally {
			inFlight = false;
			if (pending && !signal.aborted) refresh();
		}
	};
	const refresh = () => {
		pending = true;
		if (inFlight || timer || signal.aborted) return;
		timer = setTimeout(run, Math.max(0, minGapMs - (Date.now() - lastStarted)));
	};
	const triggers = ['focus', ...events];
	refresh();
	const interval = intervalMs ? setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, intervalMs) : undefined;
	for (const name of triggers) window.addEventListener(name, refresh);
	return {
		refresh,
		stop: () => {
			clearTimeout(timer);
			clearInterval(interval);
			for (const name of triggers) window.removeEventListener(name, refresh);
		},
	};
}

interface Usage<T> { data?: T; error?: boolean }

/** A polled balance shared by every reader of the same URL and identity (the keys it is fetched with). Keeps the last value when a refresh fails. */
export function usageResource<T>(url: string, parse: (value: unknown) => T | null, options: PollOptions = {}) {
	return liveResource((identity: string) => identity, null as Usage<T> | null, (_identity, { signal, set }) => poll(url, options, signal, async (response) => {
		const data = response?.ok ? parse(await response.json().catch(() => null)) : null;
		set((previous) => data !== null ? { data } : { data: previous?.data, error: true });
	}));
}

/** A sidebar balance from `usageResource`, refreshed on focus and its events while `enabled`. */
export function useUsage<T>(resource: ReturnType<typeof usageResource<T>>, { enabled, identity = '' }: { enabled: boolean; identity?: string }) {
	const state = useLiveStore(resource(enabled ? identity : null));
	return { data: state?.data, error: Boolean(state?.error) };
}
