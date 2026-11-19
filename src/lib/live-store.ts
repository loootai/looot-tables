import { useSyncExternalStore } from 'react';

type Update<T> = T | ((previous: T) => T);
/** What a running source gets: its abort signal, and a setter that ignores updates once the source is stopped. */
export interface LiveSource<T> { signal: AbortSignal; set: (update: Update<T>) => void }
type Started = (() => void) | { stop?: () => void; refresh?: () => void } | void;
export interface LiveStore<T> {
	subscribe: (notify: () => void) => () => void;
	getSnapshot: () => T;
	getServerSnapshot: () => T;
	/** Replaces the value while the source runs (after a mutation the server confirmed); ignored when stopped. */
	set: (update: Update<T>) => void;
	/** Asks the running source to fetch again now. */
	refresh: () => void;
}

/**
 * Client server-state owned by a source (a request, a poller, a watcher) instead of a component effect: the first
 * subscriber starts it, every subscriber shares it, and once the last one leaves it is aborted and the value reset.
 * `T` must not be a function type.
 */
export function liveStore<T>(initial: T, start: (source: LiveSource<T>) => Started): LiveStore<T> {
	let value = initial;
	let running: { controller: AbortController; stop?: () => void; refresh?: () => void } | null = null;
	const listeners = new Set<() => void>();
	const apply = (update: Update<T>) => {
		value = typeof update === 'function' ? (update as (previous: T) => T)(value) : update;
		for (const notify of listeners) notify();
	};
	const release = () => {
		if (listeners.size || !running) return;
		running.controller.abort();
		running.stop?.();
		running = null;
		value = initial;
	};
	return {
		subscribe(notify) {
			listeners.add(notify);
			if (!running) {
				const controller = new AbortController();
				running = { controller };
				const started = start({ signal: controller.signal, set: (update) => { if (!controller.signal.aborted) apply(update); } });
				if (typeof started === 'function') running.stop = started;
				else if (started) Object.assign(running, started);
			}
			return () => {
				listeners.delete(notify);
				// StrictMode and key changes unsubscribe and resubscribe within one commit; keep the source running across that.
				queueMicrotask(release);
			};
		},
		getSnapshot: () => value,
		getServerSnapshot: () => initial,
		set: (update) => { if (running) apply(update); },
		refresh: () => running?.refresh?.(),
	};
}

/** One live store per key, created on first use. Stopped stores hold no data, so keeping them costs only the key. */
export function liveResource<P, T>(key: (params: P) => string, initial: T, start: (params: P, source: LiveSource<T>) => Started) {
	const stores = new Map<string, LiveStore<T>>();
	const idle = liveStore(initial, () => {});
	return (params: P | null): LiveStore<T> => {
		if (params === null) return idle;
		const id = key(params);
		let store = stores.get(id);
		if (!store) stores.set(id, store = liveStore(initial, (source) => start(params, source)));
		return store;
	};
}

export function useLiveStore<T>(store: LiveStore<T>) {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}
