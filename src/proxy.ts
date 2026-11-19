import { NextResponse, type NextRequest } from 'next/server';
import { newSecret, sessionConfig, readSession, safeRedirectUrl, safeReturnTo, SESSION_COOKIE } from '@/lib/server/auth';
import { contextSignInEnabled, selfHostedEnabled } from '@/lib/server/deployment';
import { selfHostedCookieOptions } from '@/lib/server/self-hosted';

export function proxy(request: NextRequest) {
	const selfHosted = selfHostedEnabled();
	if (contextSignInEnabled() && process.env.NODE_ENV === 'production' && request.nextUrl.origin !== sessionConfig().origin) {
		return NextResponse.redirect(new URL(request.nextUrl.pathname + request.nextUrl.search, sessionConfig().origin), 308);
	}
	if (selfHosted && ['/api/auth/start', '/api/auth/callback', '/api/auth/dev', '/api/auth/logout'].includes(request.nextUrl.pathname)) return new NextResponse(null, { status: 404 });
	if (['/api/auth/dev', '/api/auth/start', '/api/auth/callback', '/api/auth/session', '/api/auth/logout'].includes(request.nextUrl.pathname)) return NextResponse.next();
	if (request.nextUrl.pathname === '/login') return selfHosted ? NextResponse.redirect(safeRedirectUrl(request.nextUrl.searchParams.get('returnTo'), request.url)) : NextResponse.next();
	const token = request.cookies.get(SESSION_COOKIE)?.value;
	const account = readSession(token);
	const api = request.nextUrl.pathname.startsWith('/api/');
	const secureCookie = process.env.NODE_ENV === 'production' || request.nextUrl.protocol === 'https:';
	if (selfHosted && !account && !api) {
		const response = NextResponse.redirect(request.nextUrl);
		response.cookies.set(SESSION_COOKIE, `local.${newSecret()}`, selfHostedCookieOptions(secureCookie));
		response.headers.set('Cache-Control', 'private, no-store');
		return response;
	}
	if (!account) return api ? NextResponse.json({ error: selfHosted ? 'Open the app to initialize your workspace.' : 'Sign in with Context.dev to continue.' }, { status: 401 }) : NextResponse.redirect(new URL(`/login?returnTo=${encodeURIComponent(safeReturnTo(request.nextUrl.pathname + request.nextUrl.search))}`, request.url));
	if (api && (request.headers.get('x-enrichable-account') !== account.partition || request.headers.get('x-enrichable-session') !== account.sessionId)) return NextResponse.json({ error: 'Your account changed. Reload to continue.' }, { status: 409 });
	// NextURL normalizes loopback IPs to localhost. Preserve the incoming Host
	// when checking browser origins (also supports custom self-hosted domains).
	const origin = selfHosted ? `${request.nextUrl.protocol}//${request.headers.get('host') || request.nextUrl.host}` : sessionConfig().origin;
	if (api && !['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.get('origin') !== origin) return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
	const response = NextResponse.next();
	if (selfHosted && !api) response.cookies.set(SESSION_COOKIE, token!, selfHostedCookieOptions(secureCookie));
	response.headers.set('Cache-Control', 'private, no-store');
	return response;
}

export const config = { matcher: ['/login', '/app/:path*', '/api/:path*'] };
