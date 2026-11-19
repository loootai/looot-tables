'use client';

import { createRealtimeClient, QueryRefreshController } from '@neon/realtime/client';
import { accountHeaders } from './account-storage';
import { applyLiveIndex, applyLiveSheet, refreshWorkspace } from './db';
import { WorkspaceRealtime, type CollaborationSnapshot, type RealtimeBundle, type RealtimePorts } from './workspace-realtime';

const presenceRequest = (method: 'POST' | 'DELETE', body: object, keepalive: boolean) => fetch('/api/realtime/presence', { method, headers: { ...accountHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });

/** The production Adapter: Neon Realtime over one WebSocket, the app's API routes, IndexedDB and the DOM. */
const browserPorts: RealtimePorts = {
	async bundle(sheetId) {
		const response = await fetch(`/api/realtime${sheetId ? `?sheetId=${encodeURIComponent(sheetId)}` : ''}`, { headers: accountHeaders(), cache: 'no-store' });
		if (!response.ok) throw new Error('Live subscription unavailable.');
		return await response.json() as RealtimeBundle;
	},
	connect(url) {
		const client = createRealtimeClient({ url });
		return {
			subscribe(query, on) {
				const subscription = client.subscribe(query);
				const renewal = new QueryRefreshController({ query, renewSubscription: (next) => subscription.renew(next), refreshQuery: on.renew, onRefreshExhausted: on.exhausted });
				renewal.setSubscription(subscription); renewal.start();
				const stop = subscription.onChange(on.change);
				return () => { stop(); renewal.stop(); subscription.unsubscribe(); };
			},
			close: () => client.close(),
		};
	},
	presence: { write: (input, final) => presenceRequest('POST', input, final), leave: (clientId) => presenceRequest('DELETE', { clientId }, true) },
	cache: { index: applyLiveIndex, sheet: applyLiveSheet },
	env: {
		hidden: () => document.hidden,
		online: () => navigator.onLine !== false,
		listen(on) {
			document.addEventListener('visibilitychange', on.visibility);
			window.addEventListener('online', on.connectivity); window.addEventListener('offline', on.connectivity);
			window.addEventListener('pagehide', on.pagehide);
			return () => { document.removeEventListener('visibilitychange', on.visibility); window.removeEventListener('online', on.connectivity); window.removeEventListener('offline', on.connectivity); window.removeEventListener('pagehide', on.pagehide); };
		},
	},
	clock: {
		now: () => Date.now(),
		after(ms, run) { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
		every(ms, run) { const timer = setInterval(run, ms); return () => clearInterval(timer); },
	},
};

const EMPTY: CollaborationSnapshot = { status: 'connecting', peers: [], clientId: '' };
let snapshot = EMPTY;
const listeners = new Set<() => void>();
const publish = (next: CollaborationSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
export const collaborationStore = { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, getSnapshot: () => snapshot, getServerSnapshot: () => EMPTY };
let session: WorkspaceRealtime | undefined;
export const realtimeHealthy = () => snapshot.status === 'live';
export function startWorkspaceRealtime() { session?.close(); const next = new WorkspaceRealtime(browserPorts, publish); session = next; next.start(); return () => { if (session === next) session = undefined; next.close(); }; }
export function watchRealtimeSheet(sheetId: string) { session?.setSheet(sheetId); return () => { if (session?.sheetId === sheetId) session.setSheet(undefined); }; }
export function publishSelection(rowId: string | null, columnId: string | null) { session?.setSelection(rowId, columnId); }

/** Poll only when push is unavailable; focus/reconnect still perform a consistency check. */
export function refreshIfNotLive() { if (!realtimeHealthy()) return refreshWorkspace(); return Promise.resolve(); }
