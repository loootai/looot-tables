import { hkdfSync } from 'node:crypto';
import { EncryptJWT } from 'jose';
import { CONTEXT_CONNECTION_COOKIE, contextConnectionKey, decryptContextConnection } from '../../src/lib/server/context-connection';
import { serverKeyAvailability } from '../../src/lib/server/provider-access';
import { requestGrant } from './access-fixture';
import { POST as logout } from '../../src/app/api/auth/logout/route';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { accountFromIdentity, authCookieName, cookieOptions, FLOW_COOKIE, pkceChallenge, readSession, safeRedirectUrl, safeReturnTo, seal, SESSION_COOKIE, unseal } from '../../src/lib/server/auth';
import { GET as start } from '../../src/app/api/auth/start/route';
import { GET as callback } from '../../src/app/api/auth/callback/route';
import { proxy } from '../../src/proxy';

process.env.ENRICHABLE_APP_URL = 'https://www.enrichable.io';
process.env.CONTEXT_IDENTITY_ISSUER = 'https://context.test';
process.env.CONTEXT_OAUTH_CLIENT_ID = 'enrichable';
process.env.CONTEXT_OAUTH_CLIENT_SECRET = 'c'.repeat(32);
process.env.ENRICHABLE_SESSION_SECRET = 's'.repeat(32);
const identity = { issuer: 'https://context.test', user: { id: 'alice', email: 'alice@example.com', email_verified: true }, organization: { id: 'org-1', name: 'Example' } };

async function credentialToken(patch: Record<string, unknown> = {}, expiration: string = '1h') {
 return new EncryptJWT({ context_api_key:'ctxt_secret_test', context_api_key_id:'key-1', organization_id:identity.organization.id,scope:'data:execute logs:read',...patch })
  .setProtectedHeader({alg:'dir',enc:'A256GCM',typ:'context-connection+jwt'}).setIssuer(identity.issuer).setAudience('context-api:enrichable').setSubject(identity.user.id).setIssuedAt().setExpirationTime(expiration)
  .encrypt(Buffer.from(hkdfSync('sha256', process.env.CONTEXT_OAUTH_CLIENT_SECRET!, '', 'enrichable:context-connection:v1', 32)));
}

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

test('sign-in callback verifies state and PKCE before creating a session', async (t) => {
	const response = start(new NextRequest('https://www.enrichable.io/api/auth/start?returnTo=/app/settings'));
	const authorization = new URL(response.headers.get('location')!);
	const cookie = response.cookies.get(FLOW_COOKIE)!;
	const flow = unseal(cookie.value, 'flow') as { verifier: string };
	assert.equal(authorization.searchParams.get('code_challenge'), pkceChallenge(flow.verifier));
	assert.equal(authorization.pathname, '/oauth2/authorize');
	assert.equal(authorization.searchParams.get('audience'), 'context-api:enrichable');
	assert.equal(authorization.searchParams.get('scope'), 'api.read logolink.read');
	assert.equal(authorization.searchParams.get('logo_uri'), 'https://www.enrichable.io/icon.svg');
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
		calls++;
		assert.equal(new URL(String(_url)).pathname, '/oauth2/token');
		const body = init.body as URLSearchParams;
		assert.equal(body.get('code_verifier'), flow.verifier);
		assert.equal(body.get('client_secret'), 'c'.repeat(32));
		return Response.json({ ...identity, access_token: await credentialToken() });
	});
	const invoke = (state: string) => callback(new NextRequest(`https://www.enrichable.io/api/auth/callback?code=one-time-code&state=${state}`, { headers: { cookie: `${cookie.name}=${cookie.value}` } }));
	assert.match((await invoke('incorrect')).headers.get('location')!, /error=signin/);
	assert.equal(calls, 0);
	const success = await invoke(authorization.searchParams.get('state')!);
	assert.equal(success.headers.get('location'), 'https://www.enrichable.io/app/settings');
	assert.equal(readSession(success.cookies.get(SESSION_COOKIE)?.value)?.user.id, 'alice');
	const connection = success.cookies.get(CONTEXT_CONNECTION_COOKIE)!;
	assert.equal(connection.httpOnly, true); assert.equal(connection.secure, true);
	assert.ok(!connection.value.includes('ctxt_secret_test'));
	assert.equal(await decryptContextConnection(connection.value, accountFromIdentity(identity)), 'ctxt_secret_test');
	assert.ok(!JSON.stringify(unseal(success.cookies.get(SESSION_COOKIE)?.value, 'session')).includes('ctxt_secret_test'));
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

test('automatic API connections stay encrypted, account-bound, expire, and clear on logout', async () => {
 const account=accountFromIdentity(identity), sessionId='n'.repeat(43);
 const token=await credentialToken();
 const cookie=`${SESSION_COOKIE}=${seal({...account,sessionId},'session',3600)}; ${CONTEXT_CONNECTION_COOKIE}=${token}`;
 const request=new NextRequest('https://www.enrichable.io/api/keys/verify',{headers:{cookie}});
 assert.equal(await contextConnectionKey(request),'ctxt_secret_test');
 assert.equal((await requestGrant(request)).keys.context,'ctxt_secret_test');
 assert.equal((await requestGrant(request)).contextUserEmail, identity.user.email);
 assert.equal((await serverKeyAvailability(request)).contextConnected,true);
 assert.ok(!JSON.stringify(await serverKeyAvailability(request)).includes('ctxt_secret_test'));
 await assert.rejects(decryptContextConnection(token,{...account,user:{...account.user,id:'bob'}}));
 await assert.rejects(decryptContextConnection(token,{...account,organization:{id:'other',name:'Other'}}));
 await assert.rejects(decryptContextConnection(token+'tampered',account));
 await assert.rejects(decryptContextConnection(await credentialToken({},'-1s'),account));
 assert.equal(await contextConnectionKey(new Request(request.url)),null);
 const manual=new Request(request.url,{headers:{cookie,'x-context-key':'manual-key'}});
 assert.equal((await requestGrant(manual)).keys.context,'manual-key');
 assert.equal((await requestGrant(manual)).contextUserEmail, identity.user.email);
 const response=logout(new NextRequest('https://www.enrichable.io/api/auth/logout',{method:'POST',headers:{cookie,origin:'https://www.enrichable.io'}}));
 assert.match(response.headers.get('set-cookie')!, /enrichable\.context=;[^,]*Max-Age=0/i);
 assert.equal(response.headers.get('clear-site-data'),null,'Logout must not send Clear-Site-Data: Chrome stalls on "cache" and "storage" erases un-imported local data');
});

test('an explicit Context.dev reconnect keeps the return path and is carried through the sealed flow', () => {
 const reconnect=start(new NextRequest('https://www.enrichable.io/api/auth/start?returnTo=%2Fapp%2Fsheets%2Fabc&reconnect=context'));
 assert.deepEqual(unseal(reconnect.cookies.get(FLOW_COOKIE)!.value,'flow'),{...unseal(reconnect.cookies.get(FLOW_COOKIE)!.value,'flow') as object,returnTo:'/app/sheets/abc',reconnect:true});
 const plain=start(new NextRequest('https://www.enrichable.io/api/auth/start?returnTo=%2Fapp'));
 assert.equal((unseal(plain.cookies.get(FLOW_COOKIE)!.value,'flow') as {reconnect:boolean}).reconnect,false);
});

test('production cookies are host-only and secure',()=>{
 const mode=process.env.NODE_ENV;Object.assign(process.env,{NODE_ENV:'production'});
 try{assert.equal(authCookieName('session'),'__Host-enrichable.session');assert.equal(authCookieName('context'),'__Host-enrichable.context');assert.equal(cookieOptions().secure,true);assert.equal(cookieOptions().path,'/');assert.ok(!('domain' in cookieOptions()));}
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
