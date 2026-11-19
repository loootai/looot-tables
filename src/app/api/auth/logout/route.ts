import { NextResponse, type NextRequest } from 'next/server';
import { sessionConfig, cookieOptions, FLOW_COOKIE, SESSION_COOKIE } from '@/lib/server/auth';

export function POST(request: NextRequest) {
	const config = sessionConfig();
	if (request.headers.get('origin') !== config.origin) return Response.json({ error: 'Invalid origin' }, { status: 403 });
	const response = NextResponse.redirect(new URL('/login', config.origin), 303);
	response.cookies.set(SESSION_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
	response.cookies.set(FLOW_COOKIE, '', { ...cookieOptions(), maxAge: 0 });
	response.headers.set('Cache-Control', 'no-store');
	// No Clear-Site-Data: Chrome's "cache" directive can stall the logout navigation for many seconds, and "storage"
	// would erase un-imported local sheets. Signed-in pages and APIs are already `private, no-store` (see proxy.ts).
	return response;
}
