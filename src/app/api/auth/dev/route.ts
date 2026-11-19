import { NextResponse, type NextRequest } from 'next/server';
import { accountFromIdentity, cookieOptions, DEV_ISSUER, devAuthEnabled, FLOW_COOKIE, newSecret, safeRedirectUrl, seal, SESSION_COOKIE, SESSION_SECONDS, sessionConfig } from '@/lib/server/auth';

export async function POST(request: NextRequest) {
	if (!devAuthEnabled(request.nextUrl.origin)) return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
	const config = sessionConfig();
	if (request.headers.get('origin') !== config.origin || request.headers.get('host') !== new URL(config.origin).host) {
		return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
	}
	const form = await request.formData();
	const returnTo = form.get('returnTo');
	const account = accountFromIdentity({
		issuer: DEV_ISSUER,
		user: { id: 'local-developer', email: 'developer@example.com', email_verified: true, name: 'Developer' },
		organization: { id: 'local-development', name: 'Local development' },
	});
	const response = NextResponse.redirect(safeRedirectUrl(typeof returnTo === 'string' ? returnTo : null, config.origin), 303);
	response.cookies.set(SESSION_COOKIE, seal({ ...account, sessionId: newSecret() }, 'session', SESSION_SECONDS), { ...cookieOptions(), maxAge: SESSION_SECONDS });
	response.cookies.set(FLOW_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
	response.headers.set('Cache-Control', 'no-store');
	return response;
}
