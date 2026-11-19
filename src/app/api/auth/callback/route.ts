import { lookupCompanyOnAuthorization } from '@/lib/server/company-context';
import { CompanyContextStore } from '@/lib/server/company-context-store';
import { withDatabase } from '@/lib/server/database';
import { z } from 'zod';
import { CONTEXT_CONNECTION_COOKIE, readContextConnection } from '@/lib/server/context-connection';
import { OrganizationStore, organizationPersistenceEnabled } from '@/lib/server/organization-store';
import { after, NextResponse, type NextRequest } from 'next/server';
import { accountFromIdentity, authConfig, cookieOptions, FLOW_COOKIE, newSecret, readFlow, safeRedirectUrl, seal, SESSION_COOKIE, SESSION_SECONDS } from '@/lib/server/auth';

export const maxDuration = 90;

export async function GET(request: NextRequest) {
	let response: NextResponse;
	try {
		const config = authConfig();
		const flow = readFlow(request.cookies.get(FLOW_COOKIE)?.value);
		const params = request.nextUrl.searchParams;
		if (!flow || params.getAll('state').length !== 1 || params.get('state') !== flow.state || params.has('error') || params.getAll('code').length !== 1) throw new Error('Invalid sign-in');
		const identity = await fetch(new URL('/oauth2/token', config.issuer), {
			method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.callback, code: params.get('code')!, code_verifier: flow.verifier }),
			cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
		});
		if (!identity.ok) throw new Error('Identity exchange failed');
		const exchange = await identity.json();
		const account = accountFromIdentity(exchange);
		const token = z.string().min(1).max(3800).parse(exchange.access_token);
		const connection = await readContextConnection(token, account);
		const persisted = organizationPersistenceEnabled(account);
		if (persisted) await withDatabase((database) => new OrganizationStore(database).saveSignin(account, connection.key, connection.expiresAt, flow.reconnect || new URL(flow.returnTo, config.origin).searchParams.get('reconnect') === 'context'));
		if (persisted) after(async () => {
			try { await withDatabase((database) => lookupCompanyOnAuthorization(account, connection.key, new CompanyContextStore(database))); }
			catch { console.error('Company brand initialization failed.'); }
		});
		response = NextResponse.redirect(safeRedirectUrl(flow.returnTo, config.origin));
		response.cookies.set(CONTEXT_CONNECTION_COOKIE, persisted ? '' : token, { ...cookieOptions(), maxAge: persisted ? 0 : SESSION_SECONDS });
		response.cookies.set(SESSION_COOKIE, seal({ ...account, sessionId: newSecret() }, 'session', SESSION_SECONDS), { ...cookieOptions(), maxAge: SESSION_SECONDS });
	} catch { response = NextResponse.redirect(new URL('/login?error=signin', request.url)); }
	response.cookies.set(FLOW_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0, secure: request.nextUrl.protocol === 'https:' });
	response.headers.set('Cache-Control', 'no-store');
	response.headers.set('Referrer-Policy', 'no-referrer');
	return response;
}
