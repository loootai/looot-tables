import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { accountFromIdentity, authCookieName, DEV_ISSUER, cookieOptions, readSession, safeRedirectUrl, safeReturnTo, seal, SESSION_COOKIE, unseal } from '../../src/lib/server/auth';
import { proxy } from '../../src/proxy';

// Signed-in sessions exist only for local development test accounts (LOOOT_TABLES_DEV_AUTH).
const APP = 'http://localhost:3000';
Object.assign(process.env, { NODE_ENV: 'development', LOOOT_TABLES_DEV_AUTH: 'true', LOOOT_TABLES_APP_URL: APP, LOOOT_TABLES_SESSION_SECRET: 's'.repeat(32) });
const identity = { issuer: DEV_ISSUER, user: { id: 'alice', email: 'alice@example.com', email_verified: true }, organization: { id: 'org-1', name: 'Example' } };

test('sessions reject tampering, expiry, wrong purpose, and unverified identity; partitions include user and organization', () => {
	const alice = accountFromIdentity(identity);
	const cookie = seal({ ...alice, sessionId: 'n'.repeat(43) }, 'session', 60);
	assert.equal(readSession(cookie)?.user.id, 'alice');
	assert.equal(readSession(`${cookie.slice(0, -8)}tampered`), null);
	assert.equal(unseal(cookie, 'flow'), null);
	assert.equal(readSession(seal({ ...alice, sessionId: 'n'.repeat(43) }, 'session', -1)), null);
	assert.throws(() => accountFromIdentity({ ...identity, user: { ...identity.user, email_verified: false } }));
	assert.notEqual(alice.partition, accountFromIdentity({ ...identity, user: { ...identity.user, id: 'bob' } }).partition);
	assert.notEqual(alice.partition, accountFromIdentity({ ...identity, organization: { id: 'org-2', name: 'Other' } }).partition);
	assert.equal(safeReturnTo('//attacker.test'), '/app');
	assert.equal(safeReturnTo('/app/\\attacker'), '/app');
	for (const returnTo of ['//attacker.test/app', 'https://attacker.test/app', '/app//attacker.test', null]) assert.equal(safeRedirectUrl(returnTo, APP).origin, APP);
	assert.equal(safeRedirectUrl('/app/sheets/s1?x=1', APP).href, `${APP}/app/sheets/s1?x=1`);
});

test('protected APIs reject signed-out, cross-account, stale-session and cross-origin requests', async () => {
	const alice = accountFromIdentity(identity), sessionId = 'n'.repeat(43);
	const cookie = seal({ ...alice, sessionId }, 'session', 60);
	const headers = { cookie: `${SESSION_COOKIE}=${cookie}`, 'x-looot-tables-account': alice.partition, 'x-looot-tables-session': sessionId, origin: APP };
	assert.equal((await proxy(new NextRequest(`${APP}/api/enrich`))).status, 401);
	assert.equal((await proxy(new NextRequest(`${APP}/api/enrich`, { method: 'POST', headers: { ...headers, 'x-looot-tables-account': 'bob' } }))).status, 409);
	assert.equal((await proxy(new NextRequest(`${APP}/api/enrich`, { method: 'POST', headers: { ...headers, 'x-looot-tables-session': 'previous-session' } }))).status, 409);
	assert.equal((await proxy(new NextRequest(`${APP}/api/enrich`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.test' } }))).status, 403);
	assert.equal((await proxy(new NextRequest(`${APP}/api/enrich`, { method: 'POST', headers }))).status, 200);
});

test('production cookies are host-only and secure',()=>{
 const mode=process.env.NODE_ENV;Object.assign(process.env,{NODE_ENV:'production',LOOOT_TABLES_APP_URL:'https://tables.example.com'});
 try{assert.equal(authCookieName('session'),'__Host-looot-tables-session');assert.equal(cookieOptions().secure,true);assert.equal(cookieOptions().path,'/');assert.ok(!('domain' in cookieOptions()));}
 finally{process.env.LOOOT_TABLES_APP_URL=APP;if(mode===undefined)Reflect.deleteProperty(process.env,'NODE_ENV');else Object.assign(process.env,{NODE_ENV:mode});}
});
