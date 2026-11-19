import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/auth/dev/route';
import { POST as logout } from '../../src/app/api/auth/logout/route';
import { DEV_ISSUER, devAuthEnabled, readSession, SESSION_COOKIE } from '../../src/lib/server/auth';
import { CONTEXT_CONNECTION_COOKIE } from '../../src/lib/server/context-connection';
import { proxy } from '../../src/proxy';

const origin = 'http://localhost:3000';
function request(path = '/app/settings', headers: Record<string, string> = {}, url = origin) {
	return new NextRequest(`${url}/api/auth/dev`, {
		method: 'POST', headers: { origin, host: 'localhost:3000', ...headers },
		body: new URLSearchParams({ returnTo: path }),
	});
}
function env(t: TestContext, name: string, value: string) {
	const previous = process.env[name];
	process.env[name] = value;
	t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}
function configure(t: TestContext) {
	env(t, 'NODE_ENV', 'development');
	env(t, 'ENRICHABLE_DEV_AUTH', 'true');
	env(t, 'ENRICHABLE_APP_URL', origin);
	env(t, 'ENRICHABLE_SESSION_SECRET', 'dev-test-session-secret'.repeat(3));
	env(t, 'CONTEXT_OAUTH_CLIENT_ID', '');
	env(t, 'CONTEXT_OAUTH_CLIENT_SECRET', '');
}

test('developer sign-in works without OAuth credentials, uses normal sessions and clears inherited credentials', async t => {
	configure(t);
	assert.equal(proxy(request()).status, 200); // The sign-in route is reachable while signed out.
	const response = await POST(request());
	assert.equal(response.status, 303);
	assert.equal(response.headers.get('location'), `${origin}/app/settings`);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const cookie = response.cookies.get(SESSION_COOKIE)!;
	assert.equal(cookie.httpOnly, true);
	assert.equal(cookie.sameSite, 'lax');
	const account = readSession(cookie.value)!;
	assert.equal(account.issuer, DEV_ISSUER);
	assert.equal(account.organization.id, 'local-development');
	assert.equal(response.cookies.get(CONTEXT_CONNECTION_COOKIE)?.maxAge, 0);
	const again = await POST(request());
	const second = readSession(again.cookies.get(SESSION_COOKIE)?.value)!;
	assert.equal(second.partition, account.partition);
	assert.notEqual(second.sessionId, account.sessionId);
	const headers = { cookie: `${SESSION_COOKIE}=${cookie.value}`, origin, 'x-enrichable-account': account.partition, 'x-enrichable-session': account.sessionId };
	assert.equal(proxy(new NextRequest(`${origin}/api/sheets`, { method: 'POST', headers })).status, 200);
	assert.equal(proxy(new NextRequest(`${origin}/api/sheets`, { method: 'POST', headers: { ...headers, 'x-enrichable-session': 'stale' } })).status, 409);
	assert.match(logout(new NextRequest(`${origin}/api/auth/logout`, { method: 'POST', headers })).headers.get('set-cookie')!, /enrichable\.session=;[^,]*Max-Age=0/i);
	assert.equal((await POST(request('https://attacker.test'))).headers.get('location'), `${origin}/app`);
	env(t, 'ENRICHABLE_DEV_AUTH', 'false');
	assert.equal(readSession(cookie.value), null);
});

test('developer sign-in rejects cross-origin and non-local requests', async t => {
	configure(t);
	assert.equal((await POST(request('/app', { origin: 'https://attacker.test' }))).status, 403);
	assert.equal((await POST(request('/app', { host: 'attacker.test' }))).status, 403);
	assert.equal((await POST(request('/app', {}, 'http://192.168.1.2:3000'))).status, 404);
	for (const app of ['https://enrichable.test', 'http://localhost.attacker.test', 'invalid']) {
		env(t, 'ENRICHABLE_APP_URL', app);
		assert.equal(devAuthEnabled(), false);
		assert.equal((await POST(request())).status, 404);
	}
});

test('developer sign-in and existing developer sessions are disabled in production and test mode', async t => {
	configure(t);
	const cookie = (await POST(request())).cookies.get(SESSION_COOKIE)!.value;
	for (const mode of ['production', 'test']) {
		env(t, 'NODE_ENV', mode);
		assert.equal(devAuthEnabled(), false);
		assert.equal((await POST(request())).status, 404);
		assert.equal(readSession(cookie), null);
	}
});
