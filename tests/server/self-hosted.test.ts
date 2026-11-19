import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { NextRequest } from 'next/server';
import { proxy } from '../../src/proxy';
import { authConfig, newSecret, readSession, SESSION_COOKIE } from '../../src/lib/server/auth';
import { contextSignInEnabled } from '../../src/lib/server/deployment';
import { serverKeyAvailability } from '../../src/lib/server/provider-access';
import { requestGrant } from './access-fixture';
import { workspaceId } from '../../src/lib/server/database';
import { trialEnabled } from '../../src/lib/server/openai-trial';
import { SELF_HOSTED_SECONDS } from '../../src/lib/server/self-hosted';

function configure(t: TestContext) {
 const values = { NODE_ENV: 'production', ENRICHABLE_APP_URL: '', ENRICHABLE_SESSION_SECRET: '', ENRICHABLE_DEV_AUTH: '', CONTEXT_OAUTH_CLIENT_ID: '', CONTEXT_OAUTH_CLIENT_SECRET: '', ENRICHABLE_OPENAI_TRIAL_ENABLED: 'true', OPENAI_API_KEY: 'server-key', ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD: 'false', ENRICHABLE_PASSWORD: '' };
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
 const headers = { cookie: `${SESSION_COOKIE}=${cookie.value}`, 'x-enrichable-account': account.partition, 'x-enrichable-session': account.sessionId, origin };
 assert.equal(proxy(new NextRequest(`${origin}/app`, { headers })).status, 200);
 assert.equal(proxy(new NextRequest(`${origin}/api/sheets`, { method: 'POST', headers })).status, 200);
 assert.equal(proxy(new NextRequest(`${origin}/api/sheets`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.test' } })).status, 403);
 assert.equal(proxy(new NextRequest(`${origin}/api/sheets`, { headers: { ...headers, 'x-enrichable-account': other.partition } })).status, 409);
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
 const api = proxy(new NextRequest(`${origin}/api/sheets`, { headers: { cookie: `${SESSION_COOKIE}=${token}`, 'x-enrichable-account': account.partition, 'x-enrichable-session': account.sessionId } }));
 assert.equal(api.status, 200);
 assert.equal(api.cookies.get(SESSION_COOKIE), undefined, 'API calls do not rewrite the cookie');
});

test('self-hosted deployments use manual keys, ignore inherited OAuth credentials and never offer sponsored AI', async t => {
 configure(t);
 process.env.ENRICHABLE_APP_URL = origin;
 process.env.CONTEXT_OAUTH_CLIENT_ID = 'enrichable';
 process.env.CONTEXT_OAUTH_CLIENT_SECRET = 'c'.repeat(32);
 assert.equal(contextSignInEnabled(), false);
 assert.throws(authConfig, /only available/);
 assert.equal(trialEnabled(), false);
 for (const path of ['start', 'callback', 'logout', 'dev']) assert.equal(proxy(new NextRequest(`${origin}/api/auth/${path}`)).status, 404);
 const request = new Request(`${origin}/api/enrich`, { headers: { 'x-openai-key': 'my-openai', 'x-context-key': 'my-context' } });
 const credentials = await requestGrant(request);
 assert.equal(credentials.keys.openai, 'my-openai');
 assert.equal(credentials.keys.context, 'my-context');
 assert.equal(credentials.trialAccount, undefined);
 const availability = await serverKeyAvailability(request);
 assert.equal(availability.contextConnected, false);
 assert.equal(availability.openaiTrial, undefined);
 assert.equal(availability.openai, false);
});

test('production OAuth is restricted to official domains and cannot accept a self-hosted cookie', t => {
 configure(t);
 for (const host of ['www.enrichable.io', 'enrichable.io']) {
  process.env.ENRICHABLE_APP_URL = `https://${host}`;
  assert.equal(contextSignInEnabled(), true);
  assert.equal(readSession(`local.${newSecret()}`), null);
 }
 for (const host of ['enrichable.io.attacker.test', 'my-copy.vercel.app', 'localhost']) {
  process.env.ENRICHABLE_APP_URL = `https://${host}`;
  assert.equal(contextSignInEnabled(), false);
 }
});
