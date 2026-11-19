import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { Account } from '../../src/lib/auth-identity';
import { workspaceId } from '../../src/lib/server/database';
import { CompanyContextStore, COMPANY_CONTEXT_TTL } from '../../src/lib/server/company-context-store';
import { companyContextForQuery, companyResearchPages, explicitCompanyDomain, lookupCompanyOnAuthorization, needsCompanyContext, researchCompany } from '../../src/lib/server/company-context';
import { afterSpend, classifyFailure, Spend } from '../../src/lib/server/enrich-failure';
import { testAccess } from './access-fixture';
import { testDatabase } from '../support/database';

const actor = (org = 'one', user = 'alice'): Account => ({ issuer: 'https://test.invalid', user: { id: user, email: `${user}@example.com`, email_verified: true }, organization: { id: org, name: org }, partition: user });
const access = testAccess({ account: actor(), model: 'test' });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
 const { db, database } = await testDatabase(t);
 for (const a of [actor(), actor('two')]) await db.query('INSERT INTO enrichable.workspaces (id,issuer,organization_id,name) VALUES ($1,$2,$3,$4)', [workspaceId(a), a.issuer, a.organization.id, a.organization.name]);
 return new CompanyContextStore(database);
}

test('only company-relative user instructions trigger context; unrelated requests need no storage or keys', async () => {
 for (const query of ['How could they work with my company?', 'Find customers for our product', 'Who needs our products?', 'Could they partner with us?', 'Score fit for our target audience']) assert.equal(needsCompanyContext(query), true, query);
 for (const query of ['Find their pricing', 'Find SaaS companies', 'Summarize {{My Company}}', 'Find the CEO email']) assert.equal(needsCompanyContext(query), false, query);
 assert.equal(await companyContextForQuery(access, 'Find their pricing'), '');
});

test('authorization brand lookup is claimed once across members and negative results persist', async (t) => {
 const store = await fixture(t);
 const original = globalThis.fetch;
 let calls = 0;
 globalThis.fetch = async () => { calls++; return Response.json({ error: { code: 'FREE_EMAIL_DETECTED', message: 'FREE_EMAIL_DETECTED' } }, { status: 422 }); };
 t.after(async () => { globalThis.fetch = original; });
 await Promise.all([lookupCompanyOnAuthorization(actor(), 'test-key', store), lookupCompanyOnAuthorization(actor('one', 'bob'), 'test-key', store)]);
 await lookupCompanyOnAuthorization(actor(), 'test-key', store);
 assert.equal(calls, 1);
 assert.equal((await store.get(actor()))?.lookup_status, 'FREE_EMAIL_DETECTED');
 assert.equal(await store.get(actor('two')), null);
 await assert.rejects(researchCompany(access, store), /could not be identified/);
 assert.equal(calls, 1, 'research never retries brand lookup');
});

test('successful authorization saves brand without crawling or researching', async (t) => {
 const store = await fixture(t);
 const original = globalThis.fetch;
 const urls: string[] = [];
 globalThis.fetch = async (input) => { urls.push(input instanceof Request ? input.url : String(input)); return Response.json({ status: 'ok', brand: { domain: 'acme.example', title: 'Acme', description: 'Widgets' } }); };
 t.after(async () => { globalThis.fetch = original; });
 await lookupCompanyOnAuthorization(actor(), 'another-test-key', store);
 await lookupCompanyOnAuthorization(actor('one', 'bob'), 'another-test-key', store);
 assert.equal(urls.length, 1);
 assert.match(urls[0], /brand\/retrieve/);
 const saved = await store.get(actor());
 assert.equal(saved?.brand?.domain, 'acme.example');
 assert.equal(saved?.profile, null);
});

test('research leases deduplicate across workers, expire safely, and cache profiles for thirty days', async (t) => {
 const store = await fixture(t);
 await store.claimLookup(actor());
 await store.finishLookup(actor(), 'ready', { domain: 'acme.example' });
 const now = Date.now();
 assert.equal(await store.claimResearch(actor(), 'first', now), true);
 assert.equal(await store.claimResearch(actor('one', 'bob'), 'second', now), false);
 assert.equal(await store.claimResearch(actor(), 'second', now + 180_001), true);
 await store.finishResearch(actor(), 'first', { summary: 'stale worker', sources: [] }, now);
 assert.equal((await store.get(actor()))?.profile, null);
 const profile = { summary: 'Acme sells widgets to manufacturers.', sources: ['https://acme.example/'] };
 await store.finishResearch(actor(), 'second', profile, now);
 assert.deepEqual(await researchCompany(access, store), profile, 'cached research needs no provider keys');
 assert.equal(await store.claimResearch(actor(), 'third', now + COMPANY_CONTEXT_TTL - 1), false);
 assert.equal(await store.claimResearch(actor(), 'third', now + COMPANY_CONTEXT_TTL + 1), true);
 await store.failResearch(actor(), 'third', now + COMPANY_CONTEXT_TTL + 2);
 assert.equal(await store.claimResearch(actor(), 'fourth', now + COMPANY_CONTEXT_TTL + 3), false);
});

test('research chooses at most four relevant same-site pages and ignores external or unsafe links', () => {
 const pages = companyResearchPages('https://acme.example/', '[About](/about) [Products](/products) [Customers](/customers) [Cases](/case-studies) [Pricing](/pricing) [Evil](https://evil.example/about) [Bad](javascript:about) [Blog](/blog) [Dup](/about#team)', { pricing: 'https://acme.example/pricing' });
 assert.equal(pages.length, 4);
 assert.equal(new Set(pages).size, 4);
 assert(pages.every((url) => url.startsWith('https://acme.example/')));
 assert(!pages.some((url) => url.includes('/blog')));
 assert(pages.includes('https://acme.example/products'));
});

test('first relevant research reads a bounded website, saves a brief, and concurrent/future requests reuse it', async (t) => {
 const store = await fixture(t);
 await store.claimLookup(actor());
 await store.finishLookup(actor(), 'ready', { domain: 'research.example', title: 'Research Co' });
 const original = globalThis.fetch;
 let scrapes = 0, summaries = 0;
 globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = await request.json();
  if (request.url.endsWith('/web/scrape')) {
   scrapes++;
   return Response.json({ markdown: { success: true, data: body.url === 'https://research.example' ? 'We sell widgets. [About](/about) [Customers](/customers) [Pricing](/pricing) [Product](/product) [Other](/services)' : 'Widgets for manufacturers. Customers include Sample Manufacturing.' }, metadata: { title: 'Research Co' } });
  }
  if (request.url.endsWith('/responses')) {
   summaries++;
   assert.match(JSON.stringify(body), /Widgets for manufacturers/);
   return Response.json({ id: 'resp_company', created_at: 1, model: 'test', status: 'completed', output: [{ id: 'msg_company', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Research Co sells widgets to manufacturers. Source: https://research.example', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
  }
  throw new Error(`Unexpected request: ${request.url}`);
 };
 t.after(async () => { globalThis.fetch = original; });
 const connected = testAccess({ account: actor(), keys: { context: 'research-key', openai: 'model-key' }, model: 'test' });
 const [first, concurrent] = await Promise.all([researchCompany(connected, store), researchCompany(connected, store)]);
 assert.deepEqual(concurrent, first);
 assert.equal(scrapes, 5);
 assert.equal(summaries, 1);
 assert.equal(first.sources.length, 5);
 assert.deepEqual(await researchCompany(connected, store), first);
 assert.equal(scrapes, 5);
 assert.equal(summaries, 1);
});


test('explicit company domains win over missing sign-in context without using an attendee domain', () => {
 const query = "here's people from my event last week can you see if any of them are worth talking to for my company context.dev\nNikhil Radosevich\nAbhijeet Sharma";
 assert.equal(explicitCompanyDomain(query), 'context.dev');
 assert.equal(explicitCompanyDomain('Compare them with our company (https://www.context.dev/about)'), 'context.dev');
 assert.equal(explicitCompanyDomain('My company is context.dev.'), 'context.dev');
 assert.equal(explicitCompanyDomain('Worth talking to for my company? Attendee: jane@example.com'), null);
 assert.equal(explicitCompanyDomain('Research {{My company context.dev}}'), null);
});

test('explicit domain cache works after rejected sign-in and stays isolated from saved brand, other domains and tenants', async (t) => {
 const store = await fixture(t);
 await store.claimLookup(actor());
 await store.finishLookup(actor(), 'FREE_EMAIL_DETECTED', null);
 const explicit = await store.forDomain(actor(), 'context.dev');
 assert.equal((await explicit.get(actor()))?.brand?.domain, 'context.dev');
 const profile = { summary: 'Context.dev provides web data APIs.', sources: ['https://context.dev/'] };
 assert.equal(await explicit.claimResearch(actor(), 'explicit'), true);
 const teammate = await store.forDomain(actor('one', 'bob'), 'context.dev');
 assert.equal(await teammate.claimResearch(actor('one', 'bob'), 'duplicate'), false);
 await explicit.finishResearch(actor(), 'explicit', profile);
 assert.deepEqual(await researchCompany(access, teammate), profile);
 assert.equal((await store.get(actor()))?.lookup_status, 'FREE_EMAIL_DETECTED');
 assert.equal((await store.get(actor()))?.profile, null);
 assert.equal((await (await store.forDomain(actor('two'), 'context.dev')).get(actor('two')))?.profile, null);
 assert.equal((await (await store.forDomain(actor(), 'another.example')).get(actor()))?.profile, null);
});

test('research spends under the cell’s run: a refusal after paid reads is final for that cell, and cells waiting on it may retry', async (t) => {
 const store = await fixture(t);
 await store.claimLookup(actor());
 await store.finishLookup(actor(), 'ready', { domain: 'research-fails.example' });
 t.mock.method(globalThis, 'fetch', async () => Response.json({ markdown: { success: true, data: 'We sell widgets.' }, metadata: {}, key_metadata: { credits_consumed: 1 } }));
 const limited = () => new APICallError({ message: 'Rate limited', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, statusCode: 429, responseBody: '', isRetryable: true });
 const connected = testAccess({ account: actor(), keys: { context: 'research-fails-key', openai: 'model-key' }, model: 'test' }, { openai: () => new MockLanguageModelV4({ doGenerate: async () => { throw limited(); } }) });
 const researcher = new Spend();
 const failed = await researchCompany(connected.withSpend(researcher), store).catch((error: unknown) => error);
 assert.deepEqual([researcher.paid, researcher.credits], [true, 1], 'the homepage read is the cell’s spend');
 assert.deepEqual(afterSpend(classifyFailure(failed, 'openai')!, researcher.paid), { reason: 'rate_limited', retryable: false, provider: 'openai' });
 const waiting = new Spend();
 const blocked = await researchCompany(connected.withSpend(waiting), store).catch((error: unknown) => error);
 assert.equal(waiting.paid, false);
 assert.equal(classifyFailure(blocked, 'openai')?.retryable, true, 'a cell that only waited spent nothing, so it may run again once research can');
});
