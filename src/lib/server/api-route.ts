import 'server-only';
import { randomUUID } from 'node:crypto';
// The server entry: `next/navigation` resolves to client code outside the Next bundler (e.g. under node --test).
import { unstable_rethrow } from 'next/dist/client/components/unstable-rethrow';
import type { Account } from '../auth-identity';
import { WorkspaceError } from '../workspace';
import { currentAccount } from './auth';
import { CreditBudgetError } from './credit-ledger';
import { CredentialError } from './credentials';
import { withDatabase, type Database } from './database';
import { logWorkspaceError } from './workspace-logging';

/** Who is asking and the storage to answer with: what every signed-in route needs. */
export type RouteContext = { account: Account; database: Database };
type ContextSource = <T>(run: (context: RouteContext) => Promise<T>) => Promise<T>;
export type RequestTrace = { operation: string; requestId: string; started: number; phase?: string };

export const UNAVAILABLE = 'Enrichable could not complete this request. Try again in a moment.';

/** What a caller is told about `error`. Our errors carry a status and a message written for the caller (400 means the
    caller's input failed to parse; see parseInput). Anything else is logged under the request id and answered 503 without
    its text, which can hold SQL, parameters, credentials or provider output. */
export function failureOf(error: unknown, trace: RequestTrace): { status: number; error: string } {
	// Next.js signals redirects, not-found and request-time bailouts (e.g. during prerendering) by throwing; let them through.
	unstable_rethrow(error);
	if (error instanceof WorkspaceError || error instanceof CredentialError || error instanceof CreditBudgetError) return { status: error.status, error: error.message };
	logWorkspaceError(error, { requestId: trace.requestId, operation: trace.operation, phase: trace.phase ?? 'request', durationMs: Math.round(performance.now() - trace.started) });
	return { status: 503, error: UNAVAILABLE };
}

export function errorResponse(error: unknown, trace: RequestTrace) {
	const { status, error: message } = failureOf(error, trace);
	return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store', 'x-request-id': trace.requestId } });
}

export const newTrace = (operation: string): RequestTrace => ({ operation, requestId: randomUUID(), started: performance.now() });

let source: ContextSource = async (run) => {
	const account = await currentAccount();
	if (!account) throw new WorkspaceError('Sign in required.', 401);
	return withDatabase((database) => run({ account, database }));
};

/** Test seam: routes get their account and database from `next` until the returned function restores the session's. */
export function provideRouteContext(next: ContextSource) {
	const previous = source;
	source = next;
	return () => { source = previous; };
}

/** A signed-in JSON route. The handler's result is the body (`{ ok: true }` when it has none); any error becomes
    failureOf's status and message. Nothing is cached, and every response names its request id. */
export function apiRoute<Params extends Record<string, string> = Record<string, never>>(operation: string, handler: (context: RouteContext & { request: Request; params: Params }) => Promise<unknown>) {
	return async (request: Request, route?: { params: Promise<Params> }): Promise<Response> => {
		const trace: RequestTrace = { ...newTrace(operation), phase: 'authentication' };
		try {
			const data = await source(async (context) => {
				trace.phase = 'handler';
				return handler({ ...context, request, params: (await route?.params ?? {}) as Params });
			});
			return Response.json(data ?? { ok: true }, { headers: { 'Cache-Control': 'no-store', 'x-request-id': trace.requestId } });
		} catch (error) { return errorResponse(error, trace); }
	};
}

/** A request's JSON body, bounded; unreadable JSON is the caller's error. */
export async function readJson(request: Request) {
	const body = await request.text();
	if (Buffer.byteLength(body) > 4_000_000) throw new WorkspaceError('This save is too large. Import or update fewer rows at a time.', 413);
	try { return JSON.parse(body) as unknown; } catch { throw new WorkspaceError('Invalid JSON.'); }
}
