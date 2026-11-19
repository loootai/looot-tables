/* Session boundary state machine. Only a 401 or a different account means signed out;
 * a 5xx, a network blip, or a sync failure becomes a banner and never unmounts the app. */

type Warning = { source: 'session' | 'sync'; message: string };
export type Boundary =
	| { phase: 'booting' }
	| { phase: 'failed'; error: string } // only reachable before the first successful load
	| { phase: 'ready'; warning: Warning | null }
	| { phase: 'leaving'; mounted: boolean }; // mounted: keep the app (and unsaved UI) until the browser navigates away
export type BoundaryEvent =
	| { type: 'loaded' }
	| { type: 'ok'; source: Warning['source'] }
	| { type: 'signed-out' }
	| { type: 'transient'; source: Warning['source']; message: string }
	| { type: 'retry' };

export const SESSION_UNREACHABLE = 'Can’t reach Enrichable right now. Retrying automatically…';

export function boundary(state: Boundary, event: BoundaryEvent): Boundary {
	if (state.phase === 'leaving') return state;
	switch (event.type) {
		case 'signed-out': return { phase: 'leaving', mounted: state.phase === 'ready' };
		case 'loaded': return state.phase === 'ready' ? state : { phase: 'ready', warning: null };
		case 'ok': return state.phase === 'ready' && state.warning?.source === event.source ? { phase: 'ready', warning: null } : state;
		case 'transient': return state.phase === 'ready' ? { phase: 'ready', warning: { source: event.source, message: event.message } } : { phase: 'failed', error: event.message };
		case 'retry': return state.phase === 'failed' ? { phase: 'booting' } : state;
	}
}

/** 'signed-out' for a 401 or a session that now belongs to another account or sign-in; throws for anything transient. */
export async function sessionStatus(response: Response, account: { partition: string; sessionId: string }): Promise<'ok' | 'signed-out'> {
	if (response.status === 401) return 'signed-out';
	if (!response.ok) throw new Error(SESSION_UNREACHABLE);
	const current = await response.json() as { partition?: string; sessionId?: string };
	return current.partition === account.partition && current.sessionId === account.sessionId ? 'ok' : 'signed-out';
}

/** Signing back in returns to the page the session expired on. */
export const loginHref = (location: { pathname: string; search: string }) => `/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
