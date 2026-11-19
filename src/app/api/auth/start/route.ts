import { NextResponse, type NextRequest } from 'next/server';
import { authConfig, cookieOptions, FLOW_COOKIE, newSecret, pkceChallenge, safeReturnTo, seal } from '@/lib/server/auth';

export function GET(request: NextRequest) {
	try {
		const config = authConfig();
		const state = newSecret(), verifier = newSecret();
		const destination = new URL('/oauth2/authorize', config.issuer);
		destination.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback, response_type: 'code', audience: `context-api:${config.clientId}`, scope: 'api.read logolink.read', state, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' }).toString();
		if (config.origin.startsWith('https:')) destination.searchParams.set('logo_uri', `${config.origin}/icon.svg`);
		const response = NextResponse.redirect(destination);
		// An explicit reconnect replaces a disconnected or manual Context.dev connection after consent.
		const reconnect = request.nextUrl.searchParams.get('reconnect') === 'context';
		response.cookies.set(FLOW_COOKIE, seal({ state, verifier, returnTo: safeReturnTo(request.nextUrl.searchParams.get('returnTo')), reconnect }, 'flow', 300), { ...cookieOptions(), maxAge: 300 });
		response.headers.set('Cache-Control', 'no-store');
		return response;
	} catch { return NextResponse.redirect(new URL('/login?error=configuration', request.url)); }
}
