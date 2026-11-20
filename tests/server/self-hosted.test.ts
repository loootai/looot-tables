import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { NextRequest } from 'next/server';
import { proxy } from '../../src/proxy';
import { newSecret, readSession, SESSION_COOKIE } from '../../src/lib/server/auth';
import { selfHostedEnabled } from '../../src/lib/server/deployment';
import { serverKeyAvailability } from '../../src/lib/server/provider-access';
import { requestGrant } from './access-fixture';
import { workspaceId } from '../../src/lib/server/database';
import { SELF_HOSTED_SECONDS } from '../../src/lib/server/self-hosted';

function configure(t: TestContext) {
 const values = { NODE_ENV: 'production', LOOOT_TABLES_APP_URL: '', LOOOT_TABLES_SESSION_SECRET: '', LOOOT_TABLES_DEV_AUTH: '', OPENAI_API_KEY: 'server-key', LOOOT_TABLES_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD: 'false', LOOOT_TABLES_PASSWORD: '' };
 const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
 Object.assign(process.env, values);
 t.after(() => { for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const origin = 'https://my-copy.vercel.app';

test('self-hosted app initializes an isolated browser workspace without OAuth or session secrets', t => {
 configure(t);
 const response = proxy(new NextRequest(`${origin}/app`));
 assert.equal(response.status, 307);
 const cookie = response.cookies.get(SESSION_COOKIE)!;
 assert.equal(cookie.httpOnly, true);
 assert.equal(cookie.secure, true);
 assert.equal(cookie.sameSite, 'lax');
 assert.equal(cookie.path, '/');
 const account = readSession(cookie.value)!;
 assert.ok(account);
 assert.ok(!JSON.stringify(account).includes(cookie.value));
 assert.deepEqual(readSession(cookie.value), account);
 const other = readSession(`local.${newSecret()}`)!;
 assert.notEqual(workspaceId(account), workspaceId(other));
 assert.notEqual(account.partition, other.partition);
 assert.equal(readSession('local.short'), null);
 const headers = { cookie: `${SESSION_COOKIE}=${cookie.value}`, 'x-looot-tables-account': account.partition, 'x-looot-tables-session': account.sessionId, origin };
 assert.equal(proxy(new NextRequest(`${origin}/app`, { headers })).status, 200);
 assert.equal(proxy(new NextRequest(`${origin}/api/sheets`, { method: 'POST', headers })).status, 200);
 assert.equal(proxy(new NextRequest(`${origin}/api/sheets`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.test' } })).status, 403);
 assert.equal(proxy(new NextRequest(`${origin}/api/sheets`, { headers: { ...headers, 'x-looot-tables-account': other.partition } })).status, 409);
 assert.equal(proxy(new NextRequest(`${origin}/api/sheets`)).status, 401);
 assert.equal(proxy(new NextRequest('http://localhost:3107/api/sheets', { method: 'POST', headers: { ...headers, host: '127.0.0.1:3107', origin: 'http://127.0.0.1:3107' } })).status, 200);
 assert.equal(proxy(new NextRequest('http://localhost:3107/api/sheets', { method: 'POST', headers: { ...headers, host: '127.0.0.1:3107', origin: 'http://attacker.test' } })).status, 403);
 assert.equal(proxy(new NextRequest(`${origin}/login`)).headers.get('location'), `${origin}/app`);
});

test('self-hosted workspace cookies slide forward on page visits so active workspaces never expire', t => {
 configure(t);
 const token = `local.${newSecret()}`;
 const account = readSession(token)!;
 const page = proxy(new NextRequest(`${origin}/app/settings`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
 assert.equal(page.status, 200);
 const renewed = page.cookies.get(SESSION_COOKIE)!;
 assert.equal(renewed.value, token, 'The same workspace is kept, never replaced');
 assert.equal(renewed.maxAge, SELF_HOSTED_SECONDS);
 assert.equal(renewed.httpOnly, true); assert.equal(renewed.secure, true); assert.equal(renewed.sameSite, 'lax'); assert.equal(renewed.path, '/');
 const api = proxy(new NextRequest(`${origin}/api/sheets`, { headers: { cookie: `${SESSION_COOKIE}=${token}`, 'x-looot-tables-account': account.partition, 'x-looot-tables-session': account.sessionId } }));
 assert.equal(api.status, 200);
 assert.equal(api.cookies.get(SESSION_COOKIE), undefined, 'API calls do not rewrite the cookie');
});

test('self-hosted deployments use manual keys, expose no sign-in routes and never offer sponsored AI', async t => {
 configure(t);
 process.env.LOOOT_TABLES_APP_URL = origin;
 assert.equal(selfHostedEnabled(), true);
 for (const path of ['start', 'callback', 'logout', 'dev']) assert.equal(proxy(new NextRequest(`${origin}/api/auth/${path}`)).status, 404);
 const request = new Request(`${origin}/api/enrich`, { headers: { 'x-openai-key': 'my-openai', 'x-looot-key': 'my-looot' } });
 const credentials = await requestGrant(request);
 assert.equal(credentials.keys.openai, 'my-openai');
 assert.equal(credentials.keys.looot, 'my-looot');
 assert.equal('trialAccount' in credentials, false, 'no run is billed to a shared token on someone else’s behalf');
 const availability = await serverKeyAvailability(request);
 assert.deepEqual(availability, { openai: false, looot: false, typesafe: false, moltsets: false, passwordRequired: false });
});
