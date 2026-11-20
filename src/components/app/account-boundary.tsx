'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { SELF_HOSTED_ISSUER, type Account } from '@/lib/auth-identity';
import { setStorageAccount } from '@/lib/account-storage';
import { connectWorkspace, openAccountDatabase, refreshWorkspace } from '@/lib/db';
import { cloudSheets } from '@/lib/sheet-cloud';
import { liveResource, useLiveStore } from '@/lib/live-store';
import { startWorkspaceRealtime, refreshIfNotLive } from '@/lib/realtime-client';
import { runner } from '@/lib/runner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { boundary, loginHref, SESSION_UNREACHABLE, sessionStatus, type Boundary, type BoundaryEvent } from './session-boundary';
import { ShellSkeleton } from './shell-skeleton';

const WarningContext = createContext<string | null>(null);
/** Session or sync trouble that the shell shows as a banner while the app stays mounted. */
export const useSessionWarning = () => useContext(WarningContext);

async function checkSession(account: Account & { sessionId: string }, signal: AbortSignal) {
	let response: Response;
	try { response = await fetch('/api/auth/session', { cache: 'no-store', signal }); }
	catch { throw new Error(SESSION_UNREACHABLE); }
	return sessionStatus(response, account).catch(() => { throw new Error(SESSION_UNREACHABLE); });
}

/** Polls the session (15 s, focus, other tabs' sign-ins) and shared sheets (30 s) until `signal` aborts. Returns retry and stop. */
function watchSession(account: Account & { sessionId: string }, dispatch: (event: BoundaryEvent) => void, signal: AbortSignal) {
	const live = () => !signal.aborted;
	const send = (event: BoundaryEvent) => { if (live()) dispatch(event); };
	let checking = false, announced = false, loaded = false;
	let stopRealtime: (() => void) | undefined;
	const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('looot-tables.auth');
	const check = async () => {
		if (checking) return;
		checking = true;
		try {
			let status: 'ok' | 'signed-out';
			try { status = await checkSession(account, signal); }
			catch (error) { send({ type: 'transient', source: 'session', message: (error as Error).message }); return; }
			if (!live()) return;
			if (status === 'signed-out') {
				send({ type: 'signed-out' });
				// A hosted session that ends mid-work holds its queue behind the sign-in prompt instead of navigating away.
				if (loaded && account.issuer !== SELF_HOSTED_ISSUER) runner.hold(true);
				else window.location.replace(loginHref(window.location));
				return;
			}
			setStorageAccount(account);
			openAccountDatabase();
			if (!loaded) { await connectWorkspace(cloudSheets); loaded = true; if (live()) stopRealtime = startWorkspaceRealtime(); }
			send({ type: 'loaded' });
			send({ type: 'ok', source: 'session' });
			if (!announced && live()) { announced = true; channel?.postMessage('changed'); }
		} catch (error) { send({ type: 'transient', source: 'sync', message: error instanceof Error ? error.message : 'Could not load your workspace.' }); }
		finally { checking = false; }
	};
	const synced = () => send({ type: 'ok', source: 'sync' });
	const syncFailed = (error: unknown) => send({ type: 'transient', source: 'sync', message: error instanceof Error ? error.message : 'Could not refresh shared sheets.' });
	const onFocus = () => { void check(); if (loaded && document.visibilityState === 'visible') refreshWorkspace().then(synced, syncFailed); };
	const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
	void check();
	const timer = setInterval(() => void check(), 15_000);
	const syncTimer = setInterval(() => { if (loaded && document.visibilityState === 'visible') refreshIfNotLive().then(synced, syncFailed); }, 30_000);
	if (channel) channel.onmessage = () => { void check(); };
	window.addEventListener('focus', onFocus);
	window.addEventListener('pageshow', onPageShow);
	return {
		refresh: () => { send({ type: 'retry' }); void check(); },
		stop: () => { stopRealtime?.(); channel?.close(); clearInterval(timer); clearInterval(syncTimer); window.removeEventListener('focus', onFocus); window.removeEventListener('pageshow', onPageShow); },
	};
}

/** The boundary state for one signed-in session, driven by its watcher while the app is mounted. */
const sessionBoundary = liveResource((account: Account & { sessionId: string }) => `${account.partition}:${account.sessionId}`, { phase: 'booting' } as Boundary, (account, { signal, set }) => watchSession(account, (event) => set((state) => boundary(state, event)), signal));

export function AccountBoundary({ account, children }: { account: Account & { sessionId: string }; children: ReactNode }) {
	const session = sessionBoundary(account);
	const state = useLiveStore(session);
	if (state.phase === 'booting' || state.phase === 'leaving' && !state.mounted) return <ShellSkeleton />;
	if (state.phase === 'failed') return (
		<main className="grid h-dvh place-items-center bg-canvas px-6 text-body-sm text-fg-muted">
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				<p role="alert" className="text-fg">{state.error}</p>
				<div className="flex gap-2">
					<Button size="sm" variant="brand" onClick={session.refresh}>Retry</Button>
					{account.issuer !== SELF_HOSTED_ISSUER && <form action="/api/auth/logout" method="post"><Button type="submit" size="sm">Sign out</Button></form>}
				</div>
			</div>
		</main>
	);
	return <WarningContext.Provider value={state.phase === 'ready' ? state.warning?.message ?? null : null}>
		{children}
		{state.phase === 'leaving' && account.issuer !== SELF_HOSTED_ISSUER && <SessionExpired />}
	</WarningContext.Provider>;
}

/** Over the app while a hosted session is signed out: enrichment waits, and signing in returns to this page. */
function SessionExpired() {
	return (
		<Dialog unframed title="Session expired. Sign in again" description="Enrichment is paused until you do. You’ll come right back to this page." onClose={() => {}} size="sm">
			<div className="flex flex-col items-start gap-4 rounded-window bg-surface p-5 shadow-[var(--shadow-floating)]">
				<div aria-hidden className="flex flex-col gap-1.5">
					<p className="text-h5 text-fg">Session expired. Sign in again</p>
					<p className="text-body-sm text-fg-muted">Enrichment is paused until you do. You’ll come right back to this page.</p>
				</div>
				<Button variant="brand" size="sm" autoFocus onClick={() => window.location.assign(loginHref(window.location))}>Sign in again</Button>
			</div>
		</Dialog>
	);
}
