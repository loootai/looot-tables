import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOp } from '../../src/lib/server/enrich';
import { verifyContactProvider } from '../../src/lib/server/contact-providers';
import { serverKeyAvailability } from '../../src/lib/server/provider-access';
import { requestGrant, testAccess } from './access-fixture';
import { ColumnOpSchema } from '../../src/lib/types';
import { opDependencies, renameOpReferences } from '../../src/lib/references';
import { rowSchema } from '../../src/lib/workspace';

const credentials = testAccess({ keys: { hunter: 'hunter-secret', prospeo: 'prospeo-secret' }, model: 'unused' });
const finder = { kind: 'hunter', action: 'find', name: '{{Name}}', domain: '{{Website}}' } as const;
const prospeo = { kind: 'prospeo', profileUrl: '{{LinkedIn}}', field: 'email', onlyVerifiedEmail: true } as const;

test('Hunter sends only its own key in a header, maps both actions, and separates provider usage', async (t) => {
 const calls: Request[] = [];
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init); calls.push(request);
  assert.equal(request.headers.get('x-api-key'), 'hunter-secret');
  assert.equal(request.headers.get('x-key'), null);
  assert.ok(!request.url.includes('secret'));
  return Response.json({ data: { email: 'ada@example.com', status: 'accept_all', score: 91, sources: [{ uri: 'https://example.com/team' }] } }, { headers: { 'X-Credits-Used': '0.5', 'X-Credits-Unit': 'verification' } });
 });
 const result = await runOp(credentials, finder, { Name: 'Ada Lovelace', Website: 'https://www.example.com/about' });
 assert.equal(result.value, 'ada@example.com');
 assert.equal(new URL(calls[0].url).searchParams.get('domain'), 'example.com');
 assert.equal(new URL(calls[0].url).searchParams.get('full_name'), 'Ada Lovelace');
 assert.equal(result.meta?.confidence, .91);
 assert.equal(result.meta?.credits, undefined);
 assert.equal(result.meta?.providerCredits, .5);
 assert.equal(result.meta?.providerCreditUnit, 'verification');
 const stored = rowSchema.parse({ id: 'r', sheetId: 's', order: 0, createdAt: 1, cells: { email: { v: result.value, s: 'done', t: 1, m: result.meta } } });
 assert.equal(stored.cells.email.m?.provider, 'hunter');
 const verification = await runOp(credentials, { kind: 'hunter', action: 'verify', email: '{{Email}}' }, { Email: 'ada@example.com' });
 assert.equal(verification.value, 'accept_all');
 assert.equal(new URL(calls[1].url).pathname, '/v2/email-verifier');
});

test('empty inputs and missing credentials never trigger a paid lookup', async (t) => {
 const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
 assert.match((await runOp(credentials, finder, { Name: '', Website: 'example.com' })).error!, /needs a name/);
 assert.match((await runOp(credentials, prospeo, { LinkedIn: '' })).error!, /needs an email/);
 const missing = await runOp(testAccess({ keys: { prospeo: 'prospeo-secret' }, model: 'unused' }), finder, {});
 assert.match(missing.error!, /Add your Hunter/);
 assert.deepEqual(missing.failure, { reason: 'credential_missing', retryable: false, provider: 'email' });
 assert.deepEqual((await runOp(credentials, finder, { Name: '', Website: 'example.com' })).failure, { reason: 'input_invalid', retryable: false, provider: 'email' });
 assert.equal(fetch.mock.callCount(), 0);
});

test('Prospeo mobile is explicitly enabled only for mobile columns and unrevealed values stay empty', async (t) => {
 const bodies: Record<string, unknown>[] = [];
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  assert.equal(request.url, 'https://api.prospeo.io/enrich-person');
  assert.equal(request.headers.get('x-key'), 'prospeo-secret');
  assert.equal(request.headers.get('x-api-key'), null);
  bodies.push(await request.json());
  return Response.json({ error: false, free_enrichment: true, person: { full_name: 'Ada', email: { revealed: false, email: 'a***@example.com' }, mobile: { revealed: true, mobile: '+14155550123' }, location: null }, company: null });
 });
 assert.equal((await runOp(credentials, prospeo, { LinkedIn: 'https://linkedin.com/in/ada' })).value, null);
 const mobile = await runOp(credentials, { ...prospeo, field: 'mobile', onlyVerifiedEmail: false }, { LinkedIn: 'https://linkedin.com/in/ada' });
 assert.equal(mobile.value, '+14155550123');
 assert.equal(mobile.meta?.providerCredits, 0);
 assert.deepEqual(bodies[0], { data: { linkedin_url: 'https://linkedin.com/in/ada' }, only_verified_email: true, enrich_mobile: false });
 assert.equal(bodies[1].enrich_mobile, true);
 assert.equal(bodies[1].only_verified_email, false);
});

test('no match is empty; provider failures are sanitized and rate limits remain retryable', async (t) => {
 let payload: unknown = { error: true, error_code: 'NO_MATCH' }, status = 400;
 t.mock.method(globalThis, 'fetch', async () => Response.json(payload, { status }));
 assert.equal((await runOp(credentials, prospeo, { LinkedIn: 'https://linkedin.com/in/ada' })).error, undefined);
 payload = { error: true, error_code: 'INSUFFICIENT_CREDITS' };
 assert.match((await runOp(credentials, prospeo, { LinkedIn: 'ada' })).error!, /credits.*exhausted/);
 payload = { error: true, error_code: 'INVALID_API_KEY', message: 'prospeo-secret' };
 const invalid = await runOp(credentials, prospeo, { LinkedIn: 'ada' });
 assert.match(invalid.error!, /rejected this API key/); assert.ok(!invalid.error?.includes('secret'));
 assert.deepEqual(invalid.failure, { reason: 'credential_invalid', retryable: false, provider: 'email' });
 status = 429; payload = { error: true };
 const limited = await runOp(credentials, prospeo, { LinkedIn: 'ada' });
 assert.match(limited.error!, /429/);
 assert.deepEqual(limited.failure, { reason: 'rate_limited', retryable: true, provider: 'email' });
 status = 403;
 assert.deepEqual((await runOp(credentials, finder, { Name: 'Ada', Website: 'example.com' })).failure, { reason: 'rate_limited', retryable: true, provider: 'email' }, 'Hunter signals rate limits with 403');
 status = 429;
 assert.deepEqual((await runOp(credentials, finder, { Name: 'Ada', Website: 'example.com' })).failure, { reason: 'credits_exhausted', retryable: false, provider: 'email' }, 'Hunter signals exhausted quota with 429');
 status = 503; payload = { debug: 'hunter-secret' };
 const failed = await runOp(credentials, finder, { Name: 'Ada', Website: 'example.com' });
 assert.match(failed.error!, /503/); assert.ok(!failed.error?.includes('secret'));
 assert.deepEqual(failed.failure, { reason: 'provider_error', retryable: false, provider: 'email' }, 'a server error may come after the lookup was billed');
});

test('free account validation uses documented endpoints and rejects error envelopes', async (t) => {
 const urls: string[] = [];
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => { urls.push(String(input)); return Response.json({ data: {}, error: false }); });
 assert.equal((await verifyContactProvider('hunter', 'key')).ok, true);
 assert.equal((await verifyContactProvider('prospeo', 'key')).ok, true);
 assert.deepEqual(urls, ['https://api.hunter.io/v2/account', 'https://api.prospeo.io/account-information']);
});

test('new identity references participate in dependencies and survive column renaming', () => {
 const op = { ...prospeo, name: '{{Name}}', domain: '{{Website}}' };
 assert.deepEqual(opDependencies(op), ['Name', 'Website', 'LinkedIn']);
 assert.equal((renameOpReferences(op, 'Website', 'Domain') as typeof op).domain, '{{Domain}}');
 assert.equal(ColumnOpSchema.safeParse({ kind: 'hunter', action: 'find' }).success, false);
 assert.equal(ColumnOpSchema.safeParse({ kind: 'prospeo', field: 'email' }).success, false);
});

test('server provider keys stay gated by deployment password and manual keys take precedence', async (t) => {
 t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
 const saved = { hunter: process.env.HUNTER_API_KEY, prospeo: process.env.PROSPEO_API_KEY, password: process.env.ENRICHABLE_PASSWORD, allowed: process.env.ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD, trial: process.env.ENRICHABLE_OPENAI_TRIAL_ENABLED };
 try {
  process.env.HUNTER_API_KEY = 'server-hunter'; process.env.PROSPEO_API_KEY = 'server-prospeo'; process.env.ENRICHABLE_PASSWORD = 'password'; process.env.ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD = 'false'; process.env.ENRICHABLE_OPENAI_TRIAL_ENABLED = 'false';
  const request = (headers = {}) => new Request('http://localhost/api/enrich', { headers });
  assert.equal((await requestGrant(request())).keys.hunter, undefined);
  assert.equal((await serverKeyAvailability(request())).prospeo, false);
  const unlocked = await requestGrant(request({ 'x-enrichable-password': 'password' }));
  assert.equal(unlocked.keys.prospeo, 'server-prospeo');
  assert.equal((await requestGrant(request({ 'x-hunter-key': 'personal-hunter', 'x-enrichable-password': 'password' }))).keys.hunter, 'personal-hunter');
 } finally {
  for (const [key, value] of Object.entries({ HUNTER_API_KEY: saved.hunter, PROSPEO_API_KEY: saved.prospeo, ENRICHABLE_PASSWORD: saved.password, ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD: saved.allowed, ENRICHABLE_OPENAI_TRIAL_ENABLED: saved.trial })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
 }
});

test('API routes validate both personal keys and execute a provider column without using other services', async (t) => {
 const { POST: verify } = await import('../../src/app/api/keys/verify/route');
 const { POST: enrich } = await import('../../src/app/api/enrich/route');
 const calls: string[] = [];
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init); calls.push(request.url);
  assert.ok(request.url.startsWith('https://api.hunter.io/') || request.url.startsWith('https://api.prospeo.io/'));
  if (request.url.includes('email-finder')) return Response.json({ data: { email: 'ada@example.com' } });
  return Response.json({ data: {}, error: false });
 });
 const headers = { 'content-type': 'application/json', 'x-hunter-key': 'hunter-secret', 'x-prospeo-key': 'prospeo-secret' };
 const verified = await verify(new Request('http://localhost/api/keys/verify', { method: 'POST', headers }));
 const status = await verified.json();
 assert.equal(status.hunter.ok, true); assert.equal(status.prospeo.ok, true);
 assert.equal(verified.headers.get('cache-control'), 'no-store');
 const response = await enrich(new Request('http://localhost/api/enrich', { method: 'POST', headers, body: JSON.stringify({ op: finder, row: { Name: 'Ada', Website: 'example.com' } }) }));
 assert.equal((await response.json()).value, 'ada@example.com');
 assert.equal(calls.length, 3);
 const invalid = await enrich(new Request('http://localhost/api/enrich', { method: 'POST', headers, body: JSON.stringify({ op: { kind: 'hunter', action: 'find' }, row: {} }) }));
 assert.equal(invalid.status, 400); assert.equal(calls.length, 3);
});
