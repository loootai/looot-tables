import type { SealedLiveQuery } from '@neon/realtime/client';
import { PRESENCE_TTL_MS, currentCollaborators, peerSchema, type Collaborator, type CollaborationStatus, type LiveSheetEntry } from './collaboration';

export type IndexRow = { id: string; revision: number; data: unknown; row_count: number; preview_rows: unknown[] };
export type RealtimeBundle = { enabled: false } | { enabled: true; url: string; userId: string; index: SealedLiveQuery<IndexRow>; sheet?: SealedLiveQuery<LiveSheetEntry>; presence?: SealedLiveQuery<Collaborator> };
export type CollaborationSnapshot = { status: CollaborationStatus; peers: readonly Collaborator[]; clientId: string; userId?: string; sheetId?: string };
export type PresenceInput = { clientId: string; sheetId: string; rowId: string | null; columnId: string | null };
/** One subscription's lifecycle as the SDK reports it, with its latest complete rows. */
export type LiveState<Row> = { status: 'connecting' | 'live' | 'stale' | 'closed' | 'error'; data?: readonly Row[] };

export interface LiveConnection {
	/** `renew` supplies a fresh capability for the same query; `exhausted` means renewal gave up. Returns unsubscribe. */
	subscribe<Row>(query: SealedLiveQuery<Row>, on: { change(state: LiveState<Row>): void; renew(): Promise<SealedLiveQuery<Row>>; exhausted(): void }): () => void;
	close(): void;
}

/** Everything a WorkspaceRealtime needs from outside. realtime-client.ts adapts Neon and the DOM; tests use memory. */
export interface RealtimePorts {
	/** Sealed capabilities for the workspace and, with a sheet, its rows and presence. */
	bundle(sheetId?: string): Promise<RealtimeBundle>;
	connect(url: string): LiveConnection;
	presence: { write(input: PresenceInput, final: boolean): Promise<unknown>; leave(clientId: string): Promise<unknown> };
	cache: { index(rows: readonly IndexRow[], activeSheetId?: string): unknown; sheet(sheetId: string, rows: readonly LiveSheetEntry[]): unknown };
	env: { hidden(): boolean; online(): boolean; listen(on: { visibility(): void; connectivity(): void; pagehide(): void }): () => void };
	clock: { now(): number; after(ms: number, run: () => void): () => void; every(ms: number, run: () => void): () => void };
}

type QueryName = 'index' | 'sheet' | 'presence';
type Watch = { resume(): void; close(): void };
type Subscribed = { phase: 'subscribed'; connection: LiveConnection; watches: Watch[]; statuses: Map<QueryName, LiveState<unknown>['status']>; everLive: boolean };
/** Callbacks hold the state they started in and go quiet once it's replaced. 'disabled' and 'closed' are terminal. */
type State = { phase: 'idle' | 'connecting' | 'disabled' | 'closed' } | { phase: 'waiting'; reason: 'paused' | 'offline' | 'retrying' } | Subscribed;

/** Only 'live' stops polling, so it needs every subscription live. */
function connectionStatus(state: State, online: boolean): CollaborationStatus {
	switch (state.phase) {
		case 'subscribed': return [...state.statuses.values()].every((status) => status === 'live') ? 'live' : state.everLive ? 'reconnecting' : 'connecting';
		case 'waiting': return state.reason !== 'retrying' ? state.reason : online ? 'polling' : 'offline';
		case 'disabled': case 'closed': return online ? 'polling' : 'offline';
		default: return 'connecting';
	}
}

const BACKGROUND_CONNECTION_GRACE_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const noop = () => {};

/** One connection per tab; the SDK handles wire reconnection and capability renewal. */
export class WorkspaceRealtime {
	readonly clientId = crypto.randomUUID();
	sheetId?: string;
	private state: State = { phase: 'idle' };
	private snapshot: CollaborationSnapshot = { status: 'connecting', peers: [], clientId: this.clientId };
	private rawPeers: Collaborator[] = [];
	private rowId: string | null = null;
	private columnId: string | null = null;
	private fetched?: { at: number; sheetId?: string; promise: Promise<RealtimeBundle> };
	private presenceWrites: Promise<unknown> = Promise.resolve();
	private present = false;
	private stopRetry = noop;
	private stopPause = noop;
	private stopPeers = noop;
	private stopSelection = noop;
	private stopHeartbeat = noop;
	private stopListening = noop;

	constructor(private ports: RealtimePorts, private publish: (snapshot: CollaborationSnapshot) => void) {}
	private get live() { return this.snapshot.status === 'live'; }

	start() {
		this.stopListening = this.ports.env.listen({ visibility: () => this.visibility(), connectivity: () => this.restart(), pagehide: () => void this.leave() });
		this.stopHeartbeat = this.ports.clock.every(20_000, () => { if (this.live) void this.presence(); });
		this.restart();
	}
	setSheet(sheetId?: string) { if (this.sheetId === sheetId) return; void this.leave(); this.sheetId = sheetId; this.rowId = null; this.columnId = null; this.restart(); }
	setSelection(rowId: string | null, columnId: string | null) {
		this.rowId = rowId; this.columnId = columnId;
		this.stopSelection();
		if (this.state.phase === 'subscribed') this.stopSelection = this.ports.clock.after(180, () => { if (this.live) void this.presence(); });
	}
	close() {
		if (this.state.phase === 'closed') return;
		this.stopListening(); this.stopHeartbeat(); this.stopSelection(); this.stopPause();
		this.enter({ phase: 'closed' });
		void this.leave();
	}

	private emit(patch: Partial<CollaborationSnapshot>) {
		this.snapshot = { ...this.snapshot, ...patch, status: connectionStatus(this.state, this.ports.env.online()) };
		this.publish(this.snapshot);
	}
	private enter<S extends State>(next: S, patch: Partial<CollaborationSnapshot> = {}) {
		const previous = this.state;
		if (previous.phase === 'subscribed') { for (const watch of previous.watches) watch.close(); previous.connection.close(); }
		this.stopRetry(); this.stopPeers(); this.rawPeers = [];
		this.state = next;
		this.emit({ ...patch, peers: [], sheetId: this.sheetId });
		return next;
	}
	/** Start over from the current sheet, visibility and connectivity. A deployment without realtime is never asked again. */
	private restart() {
		const { phase } = this.state;
		if (phase === 'closed') return;
		if (phase === 'disabled') return this.emit({ sheetId: this.sheetId });
		this.fetched = undefined;
		const { hidden, online } = this.ports.env;
		if (hidden() || !online()) { this.enter({ phase: 'waiting', reason: hidden() ? 'paused' : 'offline' }); return; }
		void this.connect(this.enter({ phase: 'connecting' }));
	}
	private fail(attempt: State) {
		if (this.state !== attempt) return;
		this.enter({ phase: 'waiting', reason: 'retrying' });
		this.stopRetry = this.ports.clock.after(RETRY_MS, () => this.restart());
	}
	private visibility() {
		const { state } = this, { env } = this.ports;
		this.stopPause();
		if (state.phase === 'disabled' || state.phase === 'closed') return;
		if (env.hidden()) {
			// Keep subscriptions warm for quick tab switches, without heartbeats or
			// applying sheet updates in the background. Longer absences still pause.
			if (this.live) void this.presence(true);
			if (state.phase === 'subscribed' || state.phase === 'connecting') this.stopPause = this.ports.clock.after(BACKGROUND_CONNECTION_GRACE_MS, () => { if (env.hidden()) this.restart(); });
		} else if (state.phase === 'subscribed') {
			this.publishPeers();
			for (const watch of state.watches) watch.resume();
			if (this.live) void this.presence();
		} else if (state.phase !== 'connecting') this.restart();
	}
	/** Renewals of every subscription come due together, so one request serves them all. */
	private fetchBundle() {
		const cached = this.fetched, now = this.ports.clock.now();
		if (cached && cached.sheetId === this.sheetId && now - cached.at < 1000) return cached.promise;
		const promise = this.ports.bundle(this.sheetId);
		this.fetched = { at: now, sheetId: this.sheetId, promise };
		return promise;
	}
	private async connect(attempt: State) {
		let owner = attempt;
		try {
			const bundle = await this.fetchBundle();
			if (this.state !== attempt) return;
			if (!bundle.enabled) { this.enter({ phase: 'disabled' }); return; }
			const { cache, clock, env } = this.ports, sheetId = this.sheetId;
			const subscribed: Subscribed = { phase: 'subscribed', connection: this.ports.connect(bundle.url), watches: [], statuses: new Map(), everLive: false };
			const current = () => this.state === subscribed;
			const watch = <Row,>(name: QueryName, query: SealedLiveQuery<Row>, consume: (rows: readonly Row[]) => unknown) => {
				subscribed.statuses.set(name, 'connecting');
				const deferred = () => name !== 'presence' && env.hidden();
				let pending: readonly Row[] | undefined, applying = false, stopDebounce = noop;
				const drain = async () => {
					if (applying || deferred()) return;
					applying = true;
					try { while (pending && current() && !deferred()) { const rows = pending; pending = undefined; await consume(rows); } }
					catch { this.fail(subscribed); }
					finally { applying = false; }
				};
				return () => {
					const unsubscribe = subscribed.connection.subscribe(query, {
						change: (state) => {
							if (!current()) return;
							if (state.status === 'error') return this.fail(subscribed);
							subscribed.statuses.set(name, state.status);
							const wasLive = this.live;
							this.emit({});
							if (state.status === 'live' && state.data !== undefined) { pending = state.data; stopDebounce(); stopDebounce = clock.after(40, () => void drain()); }
							if (this.live) { subscribed.everLive = true; if (!wasLive) void this.presence(); }
						},
						renew: async () => {
							const next = await this.fetchBundle();
							if (!next.enabled && current()) this.enter({ phase: 'disabled' });
							const renewed = next.enabled ? next[name] : undefined;
							if (!renewed) throw new Error('Live subscription unavailable.');
							return renewed as SealedLiveQuery<Row>;
						},
						exhausted: () => this.fail(subscribed),
					});
					const close = () => { stopDebounce(); pending = undefined; unsubscribe(); };
					if (current()) subscribed.watches.push({ resume: () => { stopDebounce(); void drain(); }, close });
					else close();
				};
			};
			const starts = [watch('index', bundle.index, (rows) => cache.index(rows, sheetId))];
			if (bundle.sheet && sheetId) starts.push(watch('sheet', bundle.sheet, (rows) => cache.sheet(sheetId, rows)));
			if (bundle.presence) starts.push(watch('presence', bundle.presence, (rows) => { this.rawPeers = rows.map((row) => peerSchema.parse(row)); this.publishPeers(); }));
			// Every subscription counts as connecting before the phase starts or any reports, so neither an empty
			// set nor one early 'live' can pass for all of them.
			owner = this.enter(subscribed, { userId: bundle.userId });
			for (const start of starts) if (current()) start();
		} catch { this.fail(owner); }
	}
	private publishPeers() {
		this.stopPeers();
		const now = this.ports.clock.now();
		const peers = currentCollaborators(this.rawPeers, this.clientId, now);
		this.emit({ peers: peers.map((peer) => peer.user_id === this.snapshot.userId ? { ...peer, name: 'You (another tab)' } : peer) });
		// Expiry is a local timer: no DELETE request or database wake-up required.
		if (peers.length) this.stopPeers = this.ports.clock.after(Math.min(...peers.map((peer) => peer.updated_at + PRESENCE_TTL_MS - now)) + 1, () => this.publishPeers());
	}
	/** Presence requests run one at a time in call order, so a leave never overtakes the write before it. */
	private enqueue(request: () => Promise<unknown>) {
		this.presenceWrites = this.presenceWrites.catch(noop).then(request);
		return this.presenceWrites.catch(noop);
	}
	private presence(final = false) {
		const { sheetId } = this, { env } = this.ports;
		if (!sheetId || this.state.phase === 'closed' || (!final && env.hidden()) || !env.online()) return Promise.resolve();
		const input = { clientId: this.clientId, sheetId, rowId: this.rowId, columnId: this.columnId };
		this.present = true;
		return this.enqueue(async () => { if (this.state.phase !== 'closed' && this.sheetId === sheetId) await this.ports.presence.write(input, final); });
	}
	/** Only a tab that announced itself has a presence row to remove; one without realtime never does. */
	private leave() {
		if (!this.present) return Promise.resolve();
		this.present = false;
		return this.enqueue(() => this.ports.presence.leave(this.clientId));
	}
}
