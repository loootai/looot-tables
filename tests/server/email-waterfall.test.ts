import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { ColumnOpSchema, type ColumnOp } from '../../src/lib/types';
import { opDependencies, renameOpReferences } from '../../src/lib/references';
import type { Provider } from '../../src/lib/organization-settings';
import { testAccess } from './access-fixture';
import { DOLLAR_NANO } from '../../src/lib/server/credit-ledger';
import { emailCandidate, includedRun, runEmailWaterfall, sharedRequest } from '../../src/lib/server/contextdevenrichmentwaterfall';
import { runOp } from '../../src/lib/server/enrich';
import { actor as member, ledgerFixture } from './ledger-fixture';
const actor = (org = 'one', user = 'alice') => member(user, org);
const withKeys = (keys: Partial<Record<Provider, string>> = {}) => testAccess({ keys, model: 'unused' });
const signedIn = () => testAccess({ account: actor(), model: 'unused' });
const op: Extract<ColumnOp, { kind: 'email-enrichment' }> = { kind: 'email-enrichment', name: '{{Name}}', company: '{{Company}}', domain: '{{Domain}}', profileUrl: '', providers: ['hunter', 'apollo'] };
const row = { Name: 'Ada Lovelace', Company: 'Example', Domain: 'example.com' };
const fixture = (t: TestContext) => ledgerFixture(t, 'enrichment');
function includedService(t: TestContext) {
 const values = { ENRICHMENT_API_KEY: 'shared-secret', ENRICHMENT_API_URL: 'https://enrichment.example.com', DATABASE_URL: 'test', ENRICHABLE_APP_URL: 'https://www.enrichable.io', CONTEXT_IDENTITY_ISSUER: 'https://identity.example.com' };
 const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
 Object.assign(process.env, values);
 t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
test('own keys override included service, obey order, and stop at verified result', async t => {
 const calls: string[] = [];
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init); calls.push(request.url);
  assert.equal(request.headers.get('x-api-key'), 'own-hunter');
  return Response.json({ data: { email: 'ada@example.com', verification: { status: 'valid' } } });
 });
 const result = await runEmailWaterfall(withKeys({ hunter: 'own-hunter', apollo: 'own-apollo' }), op, row);
 assert.equal(result.value, 'ada@example.com'); assert.equal(calls.length, 1);
 assert.equal(result.meta?.enrichment?.attempts[0].source, 'own-key');
 assert.equal(result.meta?.enrichment?.costUsd, 0);
 assert.equal(result.meta?.enrichment?.verified, true);
 assert.equal(result.meta?.enrichment?.verificationStatus, 'valid');
});
test('first unverified email wins without verification or later provider calls', async t => {
 const calls: string[] = [];
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = String(input); calls.push(url);
  assert.ok(url.includes('email-finder'));
  return Response.json({ data: { email: 'ada@example.com', verification: { status: 'accept_all' } } });
 });
 const result = await runEmailWaterfall(withKeys({ hunter: 'hunter', apollo: 'apollo' }), op, row);
 assert.equal(result.value, 'ada@example.com'); assert.equal(calls.length, 1);
 assert.equal(result.meta?.enrichment?.verified, false);
 assert.equal(result.meta?.enrichment?.verificationStatus, 'accept_all');
 assert.equal(result.meta?.enrichment?.attempts[0].status, 'Found');
});
test('missing and masked emails continue, then an unknown-status email stops without a verifier key', async t => {
 const calls: string[] = [];
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = String(input); calls.push(url);
  if (url.includes('quickenrich')) return Response.json({ email: 'a***@example.com' });
  if (url.includes('apollo')) return Response.json({ person: {} });
  assert.ok(url.includes('contactout'));
  return Response.json({ profile: { work_email: ['ada@example.com'] } });
 });
 const result = await runEmailWaterfall(withKeys({ quickenrich: 'quick', apollo: 'apollo', contactout: 'contact' }), { ...op, providers: ['quickenrich', 'apollo', 'contactout', 'hunter'] }, row);
 assert.equal(result.value, 'ada@example.com'); assert.equal(calls.length, 3);
 assert.deepEqual(result.meta?.enrichment?.attempts.map(a => a.provider), ['quickenrich', 'apollo', 'contactout']);
 assert.equal(result.meta?.enrichment?.verificationStatus, 'unknown');
 assert.equal(result.meta?.enrichment?.verified, false);
});
test('Prospeo waterfall requests unverified emails too', async t => {
 t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
  assert.equal(JSON.parse(String(init?.body)).only_verified_email, false);
  return Response.json({ error: false, person: { email: { email: 'ada@example.com', status: 'catch_all', revealed: true } } });
 });
 const result = await runEmailWaterfall(withKeys({ prospeo: 'prospeo' }), { ...op, providers: ['prospeo'] }, row);
 assert.equal(result.value, 'ada@example.com');
 assert.equal(result.meta?.enrichment?.verificationStatus, 'catch_all');
});
test('empty provider results return no email without a verification requirement', async t => {
 t.mock.method(globalThis, 'fetch', async () => Response.json({ person: {} }));
 const result = await runEmailWaterfall(withKeys({ apollo: 'apollo' }), { ...op, providers: ['apollo'] }, row);
 assert.equal(result.value, null);
 assert.equal(result.error, undefined);
 assert.equal(result.meta?.reasoning, 'No work email found');
});
test('failed own key never falls back to shared for the same provider and errors do not leak', async t => {
 t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'own-secret' }, { status: 401 }));
 const result = await runOp(withKeys({ hunter: 'own-secret' }), { ...op, providers: ['hunter'] }, row);
 assert.match(result.error!, /unavailable/); assert.ok(!JSON.stringify(result).includes('own-secret'));
 assert.equal(result.meta?.enrichment?.attempts.length, 1);
 assert.deepEqual(result.failure, { reason: 'credential_invalid', retryable: false, provider: 'email' });
});
test('provider verification comes from structured status, not display text', async t => {
 let payload: unknown = { data: { email: 'ada@example.com' } };
 t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
 const unverified = await runEmailWaterfall(withKeys({ hunter: 'hunter' }), { ...op, providers: ['hunter'] }, row);
 assert.equal(unverified.meta?.enrichment?.verificationStatus, 'unknown');
 assert.equal(unverified.meta?.enrichment?.verified, false);
 payload = { error: false, person: { email: { email: 'ada@example.com', status: 'VERIFIED', revealed: true } } };
 const prospeo = await runEmailWaterfall(withKeys({ prospeo: 'prospeo' }), { ...op, providers: ['prospeo'] }, row);
 assert.equal(prospeo.meta?.enrichment?.verified, true);
 assert.equal(prospeo.meta?.enrichment?.verificationStatus, 'VERIFIED');
});
test('own-key rate limits make the waterfall retryable instead of asking for keys', async t => {
 t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 429 }));
 const result = await runEmailWaterfall(withKeys({ apollo: 'apollo' }), { ...op, providers: ['apollo'] }, row);
 assert.equal(result.value, null);
 assert.deepEqual(result.failure, { reason: 'rate_limited', retryable: true, provider: 'email' });
 assert.match(result.error!, /wait a moment/i);
 assert.match(result.meta?.enrichment?.attempts[0].status ?? '', /rate limited/i);
});
test('a rate limit after a provider already ran is final: retrying would pay for that provider again', async t => {
 const { access: ledger } = await fixture(t);
 includedService(t);
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url.includes('apollo')) return Response.json({}, { status: 429 });
  if (request.url.includes('hunter.io')) return Response.json({ data: { email: null } });
  if (request.method === 'POST') return Response.json({ runId: 'paid', status: 'COMPLETED' });
  return Response.json({ runId: 'paid', status: 'COMPLETED', output: { data: { email: null } }, providerResponse: { httpStatus: 200 }, cost: { value: .02, currency: 'USD' } });
 });
 const paid = await runEmailWaterfall(testAccess({ account: actor(), keys: { apollo: 'own-apollo' }, model: 'unused' }), op, row, ledger);
 assert.equal(paid.meta?.enrichment?.costUsd, .02);
 assert.deepEqual(paid.failure, { reason: 'rate_limited', retryable: false, provider: 'email' });
 const answered = await runEmailWaterfall(withKeys({ hunter: 'own-hunter', apollo: 'own-apollo' }), op, row);
 assert.deepEqual(answered.failure, { reason: 'rate_limited', retryable: false, provider: 'email' }, 'Hunter answered on the caller’s own key');
 assert.match(answered.error!, /already ran/);
});
test('a charged run that failed counts as spend, so a later rate limit is final', async t => {
 const { access: ledger } = await fixture(t);
 includedService(t);
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.url.includes('apollo')) return Response.json({}, { status: 429 });
  if (request.url.includes('hunter.io')) return Response.json({ data: { email: null } });
  if (request.method === 'POST') return Response.json({ runId: 'timed-out', status: 'RUNNING' });
  return Response.json({ runId: 'timed-out', status: 'TIMED_OUT', cost: { value: .0072, currency: 'USD' } });
 });
 const result = await runEmailWaterfall(testAccess({ account: actor(), keys: { apollo: 'own-apollo' }, model: 'unused' }), op, row, ledger);
 assert.equal(result.meta?.enrichment?.costUsd, .0072);
 assert.deepEqual(result.failure, { reason: 'rate_limited', retryable: false, provider: 'email' });
});
test('invalid identity and duplicate providers fail before lookup; mappings track dependencies', async t => {
 t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not call'); });
 await assert.rejects(runEmailWaterfall(withKeys(), op, { ...row, Name: '' }), /person name/);
 assert.equal(ColumnOpSchema.safeParse({ ...op, providers: ['hunter', 'hunter'] }).success, false);
 assert.equal(ColumnOpSchema.safeParse({ ...op, providers: [] }).success, false);
 assert.deepEqual(opDependencies(op), ['Name', 'Company', 'Domain']);
 assert.equal((renameOpReferences(op, 'Domain', 'Website') as typeof op).domain, '{{Website}}');
 assert.equal(emailCandidate('hunter', { data: { email: 'x@example.com', score: 100 } }).verified, false);
 assert.equal(emailCandidate('apollo', { person: { email: 'x@example.com', email_status: 'unavailable' } }).verified, false);
});
test('shared execution reserves before HTTP, uses idempotency, reads final cost, and settles', async t => {
 const { ledger: store, access } = await fixture(t);
 includedService(t);
 let calls = 0;
 t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  calls++; const request = new Request(input, init);
  assert.equal(request.headers.get('authorization'), 'Bearer shared-secret');
  if (request.method === 'POST') { assert.equal((await store.balance(actor())).remainingUsd, .9755); assert.ok(request.headers.get('idempotency-key')); return Response.json({ runId: 'run1', status: 'COMPLETED' }); }
  return Response.json({ runId: 'run1', status: 'COMPLETED', output: { data: { email: null } }, providerResponse: { httpStatus: 200 }, cost: { value: 0, currency: 'USD' } });
 });
 const result = await includedRun(signedIn(), sharedRequest('hunter', { name: 'Ada Lovelace', domain: 'example.com', company: '', profileUrl: '' }), access);
 assert.equal(result.costUsd, 0); assert.equal(calls, 2); assert.equal((await store.balance(actor())).remainingUsd, 1);
});
test('a transport timeout retains the reservation and never retries the billable POST', async t => {
 const { ledger: store, access } = await fixture(t);
 includedService(t);
 let calls = 0;
 t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('network failed shared-secret'); });
 await assert.rejects(includedRun(signedIn(), sharedRequest('hunter', { name: 'Ada Lovelace', domain: 'example.com', company: '', profileUrl: '' }), access), /Credit remains reserved/);
 assert.equal(calls, 1); assert.equal((await store.balance(actor())).remainingUsd, .9755);
});
test('all provider requests disable phone and personal email add-ons', () => {
 const identity = { name: 'Ada Lovelace', domain: 'example.com', company: 'Example', profileUrl: 'https://www.linkedin.com/in/ada' };
 assert.equal((sharedRequest('apollo', identity).input.queryParams as Record<string, unknown>).reveal_phone_number, false);
 assert.equal((sharedRequest('apollo', identity).input.queryParams as Record<string, unknown>).reveal_personal_emails, false);
 assert.equal((sharedRequest('prospeo', identity).input.body as Record<string, unknown>).enrichMobile, false);
 assert.equal((sharedRequest('prospeo', identity).input.body as Record<string, unknown>).onlyVerifiedEmail, false);
 assert.deepEqual((sharedRequest('contactout', identity).input.body as Record<string, unknown>).include, ['work_email']);
});
test('included credit reports a rate limit as a retryable wait and exhaustion as add keys, never the reverse', async t => {
 const { db, ledger, access } = await fixture(t);
 includedService(t);
 t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not reach the enrichment service'); });
 await Promise.all(Array.from({ length: 8 }, () => ledger.reserve(actor(), 100)));
 const limited = await runEmailWaterfall(signedIn(), { ...op, providers: ['hunter', 'apollo'] }, row, access);
 const limitedStatus = limited.meta?.enrichment?.attempts[0].status ?? '';
 assert.match(limitedStatus, /too many enrichment requests\. Wait a moment/);
 assert.doesNotMatch(limitedStatus, /add (your own )?provider keys/i);
 assert.deepEqual(limited.failure, { reason: 'rate_limited', retryable: true, provider: 'email' });
 assert.match(limited.error!, /wait a moment/i);
 await db.query("UPDATE enrichable.enrichment_reservations SET status='settled', charged_nano=0");
 await db.query("UPDATE enrichable.enrichment_budgets SET spent_nano=$1 WHERE id <> 'global'", [DOLLAR_NANO]);
 const exhausted = await runEmailWaterfall(signedIn(), { ...op, providers: ['hunter'] }, row, access);
 assert.match(exhausted.meta?.enrichment?.attempts[0].status ?? '', /insufficient enrichment credit.*Add your own provider keys/);
 assert.deepEqual(exhausted.failure, { reason: 'credits_exhausted', retryable: false, provider: 'email' });
 assert.match(exhausted.error!, /check your provider keys/);
});
test('an included 429 is a retryable wait and settles without charge', async t => {
 const { ledger: store, access } = await fixture(t);
 includedService(t);
 t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'busy' }, { status: 429 }));
 await assert.rejects(includedRun(signedIn(), sharedRequest('hunter', { name: 'Ada Lovelace', domain: 'example.com', company: '', profileUrl: '' }), access), (error: unknown) => (error as { failure?: { reason: string } }).failure?.reason === 'rate_limited');
 assert.equal((await store.balance(actor())).remainingUsd, 1);
});
