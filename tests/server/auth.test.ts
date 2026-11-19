import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { accountFromIdentity, authCookieName, cookieOptions, readSession, safeRedirectUrl, safeReturnTo, seal, SESSION_COOKIE, unseal } from '../../src/lib/server/auth';
import { proxy } from '../../src/proxy';

process.env.ENRICHABLE_APP_URL = 'https://www.enrichable.io';
process.env.CONTEXT_IDENTITY_ISSUER = 'https://context.test';
process.env.CONTEXT_OAUTH_CLIENT_ID = 'enrichable';
process.env.CONTEXT_OAUTH_CLIENT_SECRET = 'c'.repeat(32);
process.env.ENRICHABLE_SESSION_SECRET = 's'.repeat(32);
const identity = { issuer: 'https://context.test', user: { id: 'alice', email: 'alice@example.com', email_verified: true }, organization: { id: 'org-1', name: 'Example' } };

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
	for (const returnTo of ['//attacker.test/app', 'https://attacker.test/app', '/app//attacker.test', null]) assert.equal(safeRedirectUrl(returnTo, 'https://www.enrichable.io').origin, 'https://www.enrichable.io');
	assert.equal(safeRedirectUrl('/app/sheets/s1?x=1', 'https://www.enrichable.io').href, 'https://www.enrichable.io/app/sheets/s1?x=1');
});

test('protected APIs reject signed-out, cross-account, stale-session and cross-origin requests', async () => {
	const alice = accountFromIdentity(identity), sessionId = 'n'.repeat(43);
	const cookie = seal({ ...alice, sessionId }, 'session', 60);
	const headers = { cookie: `${SESSION_COOKIE}=${cookie}`, 'x-enrichable-account': alice.partition, 'x-enrichable-session': sessionId, origin: 'https://www.enrichable.io' };
	assert.equal((await proxy(new NextRequest('https://www.enrichable.io/api/enrich'))).status, 401);
	assert.equal((await proxy(new NextRequest('https://www.enrichable.io/api/enrich', { method: 'POST', headers: { ...headers, 'x-enrichable-account': 'bob' } }))).status, 409);
	assert.equal((await proxy(new NextRequest('https://www.enrichable.io/api/enrich', { method: 'POST', headers: { ...headers, 'x-enrichable-session': 'previous-session' } }))).status, 409);
	assert.equal((await proxy(new NextRequest('https://www.enrichable.io/api/enrich', { method: 'POST', headers: { ...headers, origin: 'https://attacker.test' } }))).status, 403);
	assert.equal((await proxy(new NextRequest('https://www.enrichable.io/api/enrich', { method: 'POST', headers }))).status, 200);
});

test('production cookies are host-only and secure',()=>{
 const mode=process.env.NODE_ENV;Object.assign(process.env,{NODE_ENV:'production'});
 try{assert.equal(authCookieName('session'),'__Host-enrichable.session');assert.equal(cookieOptions().secure,true);assert.equal(cookieOptions().path,'/');assert.ok(!('domain' in cookieOptions()));}
 finally{if(mode===undefined)Reflect.deleteProperty(process.env,'NODE_ENV');else Object.assign(process.env,{NODE_ENV:mode});}
});

test('LogoLink public IDs are account-bound and require an explicit granted OAuth scope', () => {
 const organization={...identity.organization,logolink_public_id:'brandLL_public_workspace'};
 const granted=accountFromIdentity({...identity,organization,scope:'api.read logolink.read',internal_master_key:'never-expose-master'});
 assert.equal(granted.organization.logolink_public_id,'brandLL_public_workspace');
 assert.ok(!JSON.stringify(granted).includes('never-expose-master'));
 assert.equal(accountFromIdentity({...identity,organization,scope:'api.read'}).organization.logolink_public_id,undefined);
 assert.equal(accountFromIdentity({...identity,organization}).organization.logolink_public_id,undefined);
 assert.throws(()=>accountFromIdentity({...identity,scope:'api.read logolink.read',organization:{...organization,logolink_public_id:'ctxt_secret_private'}}));
});
