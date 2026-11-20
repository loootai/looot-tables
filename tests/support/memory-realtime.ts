import type { SealedLiveQuery } from '@neon/realtime/client';
import { WorkspaceRealtime, type CollaborationSnapshot, type LiveState, type RealtimeBundle, type RealtimePorts } from '../../src/lib/workspace-realtime';

type Name = 'index' | 'sheet' | 'presence';
type Handlers = { change(state: LiveState<unknown>): void; renew(): Promise<SealedLiveQuery<unknown>>; exhausted(): void };
type Subscription = { name: Name; query: SealedLiveQuery<unknown>; on: Handlers; open: boolean };

/** Let queued promise callbacks run, as the event loop would between timer ticks. */
export const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };

/**
 * The in-memory Adapter: a manual clock, a scripted capability server, and subscriptions the test drives by name.
 * `instant` subscriptions report live synchronously while subscribing; presence requests take `presenceMs` of clock time.
 */
export function memoryRealtime({ instant = [], presenceMs = 0 }: { instant?: Name[]; presenceMs?: number } = {}) {
	let now = 1_000_000, serial = 0;
	const timers = new Map<number, { at: number; run: () => void; every?: number }>();
	const schedule = (ms: number, run: () => void, every?: number) => { const id = ++serial; timers.set(id, { at: now + ms, run, every }); return () => { timers.delete(id); }; };
	const listeners = new Set<{ visibility(): void; connectivity(): void; pagehide(): void }>();
	const env = { hidden: false, online: true };
	const seal = (name: Name): SealedLiveQuery<never> => ({ capability: `${name}#${++serial}`, queryFingerprint: name, expiresAt: now + 60_000 });
	const enabled = (sheetId?: string): RealtimeBundle => ({ enabled: true, url: 'wss://realtime.test', userId: 'me', index: seal('index'), ...(sheetId ? { sheet: seal('sheet'), presence: seal('presence') } : {}) });
	const request = async (label: string) => {
		t.requests.push(`${label} start`);
		if (presenceMs) await new Promise<void>((resolve) => schedule(presenceMs, resolve));
		const failed = t.failPresence > 0;
		if (failed) t.failPresence--;
		t.requests.push(`${label} ${failed ? 'failed' : 'ok'}`);
		if (failed) throw new Error('Presence unavailable.');
	};
	const ports: RealtimePorts = {
		bundle(sheetId) { t.bundles.push(sheetId); return t.server(sheetId); },
		connect(url) {
			const connection = { url, open: true };
			t.connections.push(connection);
			return {
				subscribe(query, on) {
					const subscription: Subscription = { name: query.queryFingerprint as Name, query, on: on as unknown as Handlers, open: true };
					t.subscriptions.push(subscription);
					if (instant.includes(subscription.name)) on.change({ status: 'live', data: [] });
					return () => { subscription.open = false; };
				},
				close() { connection.open = false; },
			};
		},
		presence: { write: (input, final) => request(`write ${input.sheetId}:${input.rowId ?? ''}:${input.columnId ?? ''}${final ? ' final' : ''}`), leave: () => request('leave') },
		cache: { index: (rows) => { t.applied.push({ kind: 'index', rows }); }, sheet: (sheetId, rows) => { t.applied.push({ kind: 'sheet', rows }); } },
		env: { hidden: () => env.hidden, online: () => env.online, listen(on) { listeners.add(on); return () => { listeners.delete(on); }; } },
		clock: { now: () => now, after: (ms, run) => schedule(ms, run), every: (ms, run) => schedule(ms, run, ms) },
	};
	const t = {
		/** Answers each capability request; replace it to fail or to report realtime disabled. */
		server: async (sheetId?: string): Promise<RealtimeBundle> => enabled(sheetId),
		enabled,
		failPresence: 0,
		bundles: [] as Array<string | undefined>,
		connections: [] as Array<{ url: string; open: boolean }>,
		subscriptions: [] as Subscription[],
		requests: [] as string[],
		applied: [] as Array<{ kind: 'index' | 'sheet'; rows: readonly unknown[] }>,
		snapshots: [] as CollaborationSnapshot[],
		realtime: undefined as unknown as WorkspaceRealtime,
		now: () => now,
		status: () => t.snapshots.at(-1)?.status,
		open: () => t.subscriptions.filter((subscription) => subscription.open),
		subscription: (name: Name) => t.subscriptions.findLast((subscription) => subscription.name === name)!,
		emit: (name: Name, state: LiveState<unknown>) => t.subscription(name).on.change(state),
		live: (...names: Name[]) => { for (const name of names) t.emit(name, { status: 'live', data: [] }); },
		setHidden(hidden: boolean) { env.hidden = hidden; for (const on of [...listeners]) on.visibility(); },
		setOnline(online: boolean) { env.online = online; for (const on of [...listeners]) on.connectivity(); },
		pagehide() { for (const on of [...listeners]) on.pagehide(); },
		/** Move the clock forward, running due timers in order and letting their promises settle. */
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				await settle();
				const [id, timer] = [...timers].filter(([, entry]) => entry.at <= end).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0] ?? [];
				if (!timer) break;
				now = timer.at;
				if (timer.every) timer.at += timer.every; else timers.delete(id!);
				timer.run();
			}
			now = end;
			await settle();
		},
	};
	t.realtime = new WorkspaceRealtime(ports, (snapshot) => { t.snapshots.push(snapshot); });
	return t;
}
