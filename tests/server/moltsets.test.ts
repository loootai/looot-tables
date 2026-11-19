import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { rowSchema } from '../../src/lib/workspace';
import { riskGrade, riskTone } from '../../src/lib/moltsets-risk';
import { costPerCell, missingProviders } from '../../src/lib/operations';
import { runOp } from '../../src/lib/server/enrich';
import { MoltSetsClient, checkedBase, resetMoltSetsCooldowns } from '../../src/lib/server/moltsets';
import { checkMoltSets, parsePlan } from '../../src/lib/server/moltsets-plan';
import { testAccess } from './access-fixture';
import { failed, fakeMoltSets, found, MS_KEY, notFound, windowSpent } from './moltsets-fixture';
import { fakeLooot, hit, routed } from './looot-fixture';

beforeEach(() => resetMoltSetsCooldowns());

const accessWith = (fetchImpl: typeof fetch) => testAccess({ keys: { looot: 'test-looot-token', openai: 'test-openai', moltsets: MS_KEY }, model: 'test' }, { moltsets: fetchImpl });
const cellSchemaCheck = (result: { value: unknown; meta?: object }) => rowSchema.parse({ id: 'r1', sheetId: 's1', order: 0, createdAt: 1, cells: { c: { v: result.value, s: 'done', t: 1, m: result.meta } } });

const emailOp = { kind: 'email-enrichment' as const, name: '{{Name}}', company: '', domain: '{{Website}}', profileUrl: '', prefer: 'balanced' as const };
const ada = { Name: 'Ada Lovelace', Website: 'https://www.example.com' };
const loootEmail = (email: string) => () => hit({ data: { email } }, { normalized: { fields: { email } }, actualCost: 0.0245, route: routed([{ provider: 'hunter', outcome: 'hit', chargedUsd: 0.0245 }]) });

test('a MoltSets hit is the answer: looot is never called, the cell costs $0 and keeps the risk score', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => assert.fail('a MoltSets hit never reaches looot') });
	const moltsets = fakeMoltSets({ search_business_email_by_name: () => found({ email: 'ada@example.com', linkedin_url: 'https://linkedin.com/in/ada-example', last_validated_at: '2026-03-04', risk_score: 'A' }) });
	const result = await runOp(accessWith(moltsets.fetch), emailOp, ada, 'cell-1-0');
	assert.equal(result.error, undefined);
	assert.equal(result.value, 'ada@example.com');
	assert.equal(runs.length, 0);
	assert.deepEqual(moltsets.calls[0].body, { name: 'Ada Lovelace', company: 'example.com' });
	assert.equal(result.meta?.costUsd, undefined, 'no dollars were spent');
	assert.equal(result.meta?.looot, undefined);
	assert.deepEqual({ tool: result.meta?.moltsets?.tool, outcome: result.meta?.moltsets?.outcome, risk: result.meta?.moltsets?.riskScore, validated: result.meta?.moltsets?.lastValidatedAt, recordsLeft5h: result.meta?.moltsets?.recordsLeft5h }, { tool: 'search_business_email_by_name', outcome: 'hit', risk: 'A', validated: '2026-03-04', recordsLeft5h: 14_990 });
	cellSchemaCheck(result);
});

test('a LinkedIn URL on the row goes to the LinkedIn lookup instead of the name search', async (t) => {
	fakeLooot(t, { '*': () => assert.fail('not called') });
	const moltsets = fakeMoltSets({ linkedin_to_business_email: () => found({ email: 'ada@example.com', risk_score: 'B' }) });
	const result = await runOp(accessWith(moltsets.fetch), { ...emailOp, profileUrl: 'https://www.linkedin.com/in/ada-example' }, ada);
	assert.equal(result.value, 'ada@example.com');
	assert.deepEqual(moltsets.calls.map((call) => call.tool), ['linkedin_to_business_email']);
	assert.deepEqual(moltsets.calls[0].body, { linkedin_url: 'https://www.linkedin.com/in/ada-example' });
});

test('a MoltSets not_found falls back to looot with the same idempotency key as before, and both attempts stay on the cell', async (t) => {
	const { runs } = fakeLooot(t, { 'job:people.email.find': loootEmail('ada@example.com') });
	const moltsets = fakeMoltSets({ '*': () => notFound({ email: null, linkedin_url: null, last_validated_at: null }) });
	const result = await runOp(accessWith(moltsets.fetch), emailOp, ada, 'cell-1-0');
	assert.equal(result.value, 'ada@example.com');
	assert.equal(runs.length, 1);
	assert.equal(runs[0].idempotencyKey, 'lt-cell-1-0-1', 'the MoltSets attempt does not move the looot key');
	assert.equal(result.meta?.moltsets?.outcome, 'miss');
	assert.equal(result.meta?.looot?.length, 1);
	assert.equal(result.meta?.costUsd, 0.0245, 'only the looot run costs money');
	cellSchemaCheck(result);
});

test('a spent 5 hour window falls back to looot, and the next rows skip MoltSets until the window reopens', async (t) => {
	const { runs } = fakeLooot(t, { 'job:people.email.find': loootEmail('ada@example.com') });
	const moltsets = fakeMoltSets({ '*': () => windowSpent(1_800) });
	const access = accessWith(moltsets.fetch);
	const first = await runOp(access, emailOp, ada, 'cell-1-0');
	const second = await runOp(access, emailOp, ada, 'cell-2-0');
	assert.equal(first.value, 'ada@example.com');
	assert.equal(first.meta?.moltsets?.outcome, 'exhausted');
	assert.equal(first.meta?.moltsets?.retryAfterSeconds, 1_800);
	assert.equal(second.value, 'ada@example.com');
	assert.equal(second.meta?.moltsets?.outcome, 'exhausted');
	assert.equal(moltsets.calls.length, 1, 'the second row did not ask MoltSets again');
	assert.equal(runs.length, 2);
});

test('the request window, a burst limit that outlasts its retries, and an account error all fall back to looot', async (t) => {
	const { runs } = fakeLooot(t, { 'job:people.email.find': loootEmail('ada@example.com') });
	for (const [answer, outcome] of [[failed(429, 'fair_use_requests_exceeded', { retry_after: 60 }), 'exhausted'], [failed(429, 'rate_limited'), 'exhausted'], [failed(401, 'unauthorized'), 'error'], [failed(500, 'internal_error'), 'error']] as const) {
		resetMoltSetsCooldowns();
		const moltsets = fakeMoltSets({ '*': () => answer });
		const client = new MoltSetsClient({ key: MS_KEY, baseUrl: 'https://api.moltsets.com', fetch: moltsets.fetch, sleep: async () => {} });
		assert.equal((await client.call('search_business_email_by_name', { name: 'Ada Lovelace', company: 'example.com' })).outcome, outcome);
		const result = await runOp(accessWith(moltsets.fetch), emailOp, ada);
		assert.equal(result.value, 'ada@example.com');
		assert.equal(result.meta?.moltsets?.outcome, outcome);
	}
	assert.equal(runs.length, 4);
});

test('a burst limit is retried before it counts as spent, and nothing is charged for it', async () => {
	let calls = 0;
	const moltsets = fakeMoltSets({ '*': () => ++calls < 3 ? failed(429, 'rate_limited') : found({ email: 'ada@example.com', risk_score: 'A' }) });
	const client = new MoltSetsClient({ key: MS_KEY, baseUrl: 'https://api.moltsets.com', fetch: moltsets.fetch, sleep: async () => {} });
	const answer = await client.call('search_business_email_by_name', {});
	assert.equal(answer.outcome, 'hit');
	assert.equal(moltsets.calls.length, 3);
});

test('risk scores map to a grade and a tone: A and B green, C amber, D red, F grey, and a missing grade is F', async (t) => {
	assert.deepEqual(['A', 'B', 'C', 'D', 'F'].map((grade) => riskTone(riskGrade(grade))), ['good', 'good', 'caution', 'bad', 'none']);
	assert.equal(riskGrade(undefined), 'F');
	assert.equal(riskGrade(null), 'F');
	assert.equal(riskGrade('z'), 'F');
	assert.equal(riskGrade(' b '), 'B');
	fakeLooot(t, { '*': () => assert.fail('not called') });
	for (const [sent, kept] of [['C', 'C'], ['D', 'D'], [undefined, 'F']] as const) {
		const moltsets = fakeMoltSets({ '*': () => found({ email: 'ada@example.com', ...(sent ? { risk_score: sent } : {}) }) });
		const result = await runOp(accessWith(moltsets.fetch), emailOp, ada);
		assert.equal(result.meta?.moltsets?.riskScore, kept);
	}
});

test('the MoltSets key is sent to the MoltSets API only: in the Authorization header, never the URL or body, and never to looot or a redirect', async (t) => {
	const looot = fakeLooot(t, { 'job:people.email.find': loootEmail('ada@example.com') });
	const moltsets = fakeMoltSets({ '*': () => notFound() });
	await runOp(accessWith(moltsets.fetch), emailOp, ada, 'cell-9-0');
	for (const call of moltsets.calls) {
		assert.equal(call.authorization, `Bearer ${MS_KEY}`);
		assert.ok(call.url.startsWith('https://api.moltsets.com/api/v1/tools/'));
		assert.ok(!call.url.includes(MS_KEY) && !JSON.stringify(call.body).includes(MS_KEY));
		assert.equal(call.redirect, 'error', 'a redirect is an error, so the key never follows one');
	}
	assert.ok(!JSON.stringify(looot.runs).includes(MS_KEY), 'looot never sees the MoltSets key');
	// A redirect answer ends as an error outcome and the run falls back to looot, with nothing sent to the target.
	const redirected = fakeMoltSets({ '*': () => 'redirect' });
	const result = await runOp(accessWith(redirected.fetch), emailOp, ada);
	assert.equal(result.meta?.moltsets?.outcome, 'error');
	assert.equal(redirected.calls.length, 1);
	// A deployer can point the client at a local stand-in over http, but never at a plain-http public host or one with credentials.
	assert.equal(checkedBase('http://127.0.0.1:4547'), 'http://127.0.0.1:4547');
	assert.throws(() => checkedBase('http://api.moltsets.example'), /https/);
	assert.throws(() => checkedBase(`https://${['user', 'secret'].join(':')}@api.moltsets.example`), /credentials/);
	assert.throws(() => new MoltSetsClient({ key: MS_KEY, baseUrl: 'http://evil.example' }), /https/);
});

test('looot only never asks MoltSets, and MoltSets only never asks looot', async (t) => {
	const looot = fakeLooot(t, { 'job:people.email.find': loootEmail('ada@example.com') });
	const miss = fakeMoltSets({ '*': () => notFound() });
	const loootOnly = await runOp(accessWith(miss.fetch), { ...emailOp, source: 'looot' }, ada);
	assert.equal(loootOnly.value, 'ada@example.com');
	assert.equal(miss.calls.length, 0);
	assert.equal(loootOnly.meta?.moltsets, undefined);
	const only = await runOp(accessWith(miss.fetch), { ...emailOp, source: 'moltsets' }, ada);
	assert.equal(only.value, null, 'a MoltSets miss is an empty cell');
	assert.equal(only.error, undefined);
	assert.equal(looot.runs.length, 1, 'only the looot-only column ran looot');
	const spent = await runOp(accessWith(fakeMoltSets({ '*': () => windowSpent() }).fetch), { ...emailOp, source: 'moltsets' }, ada);
	assert.match(spent.error ?? '', /no room left/);
	assert.deepEqual({ reason: spent.failure?.reason, provider: spent.failure?.provider, retryable: spent.failure?.retryable }, { reason: 'rate_limited', provider: 'moltsets', retryable: true });
	const noKey = await runOp(testAccess({ keys: { looot: 'test-looot-token', openai: 'test-openai' } }), { ...emailOp, source: 'moltsets' }, ada);
	assert.equal(noKey.failure?.reason, 'credential_missing');
	assert.equal(noKey.failure?.provider, 'moltsets');
});

test('without a MoltSets key a column behaves exactly as before: looot answers and nothing is attempted', async (t) => {
	fakeLooot(t, { 'job:people.email.find': loootEmail('ada@example.com') });
	const result = await runOp(testAccess({ keys: { looot: 'test-looot-token', openai: 'test-openai' }, model: 'test' }), emailOp, ada);
	assert.equal(result.value, 'ada@example.com');
	assert.equal(result.meta?.moltsets, undefined);
});

test('a mobile from a LinkedIn URL uses the mobile lookup; from a name, MoltSets finds the profile first and only trusts a clear match', async (t) => {
	fakeLooot(t, { '*': () => assert.fail('not called') });
	const phone = { kind: 'phone-find' as const, name: '{{Name}}', company: '', domain: '{{Website}}', profileUrl: '', prefer: 'balanced' as const };
	const viaUrl = fakeMoltSets({ linkedin_to_mobile_phone: () => found({ mobile_phone: '+15555550100', last_validated_at: '2026-03-04' }) });
	const direct = await runOp(accessWith(viaUrl.fetch), { ...phone, profileUrl: 'https://www.linkedin.com/in/ada-example' }, ada);
	assert.equal(direct.value, '+15555550100');
	assert.deepEqual(viaUrl.calls.map((call) => call.tool), ['linkedin_to_mobile_phone']);
	const viaName = fakeMoltSets({
		search_linkedin_profile: () => found([{ full_name: 'Ada Lovelace', linkedin_url: 'https://linkedin.com/in/ada-example' }]),
		linkedin_to_mobile_phone: () => found({ mobile_phone: '5555550100' }),
	});
	const named = await runOp(accessWith(viaName.fetch), phone, ada);
	assert.equal(named.value, '5555550100');
	assert.deepEqual(viaName.calls.map((call) => call.tool), ['search_linkedin_profile', 'linkedin_to_mobile_phone']);
	assert.deepEqual(viaName.calls[0].body, { name: 'Ada Lovelace', company: 'example.com' });
});

test('an ambiguous profile match or spent phone tokens leave the mobile to looot', async (t) => {
	const { runs } = fakeLooot(t, { 'job:people.phone.find': () => hit({ data: { mobile: '+15555550199' } }, { normalized: { fields: { mobile: '+15555550199' } }, actualCost: 0.03 }) });
	const phone = { kind: 'phone-find' as const, name: '{{Name}}', company: '', domain: '{{Website}}', profileUrl: '', prefer: 'balanced' as const };
	const ambiguous = fakeMoltSets({ search_linkedin_profile: () => found([{ full_name: 'Ada King', linkedin_url: 'https://linkedin.com/in/ada-king' }, { full_name: 'Ada Byron', linkedin_url: 'https://linkedin.com/in/ada-byron' }]) });
	const first = await runOp(accessWith(ambiguous.fetch), phone, ada);
	assert.equal(first.value, '+15555550199');
	assert.equal(first.meta?.moltsets?.outcome, 'miss');
	assert.deepEqual(ambiguous.calls.map((call) => call.tool), ['search_linkedin_profile'], 'no mobile lookup for a guessed person');
	resetMoltSetsCooldowns();
	const noTokens = fakeMoltSets({ linkedin_to_mobile_phone: () => failed(402, 'insufficient_phone_tokens') });
	const second = await runOp(accessWith(noTokens.fetch), { ...phone, profileUrl: 'https://www.linkedin.com/in/ada-example' }, ada);
	assert.equal(second.value, '+15555550199');
	assert.equal(second.meta?.moltsets?.outcome, 'exhausted');
	assert.equal(runs.length, 2);
});

test('a person field from an email is read from the reverse lookup, and a field MoltSets does not return goes to looot', async (t) => {
	const { runs } = fakeLooot(t, { '*': () => hit({ data: { skills: ['Maths'] } }, { normalized: { fields: { skills: ['Maths'] } }, actualCost: 0.016 }) });
	const person = { kind: 'person' as const, email: '{{Email}}', field: 'title' as const };
	const moltsets = fakeMoltSets({ reverse_email_lookup: () => found({ first_name: 'Ada', last_name: 'Lovelace', title: 'Analyst', current_company: 'Analytical Engines', current_company_url: 'https://www.example.com', linkedinurl: 'https://www.linkedin.com/in/ada-example', country: 'United Kingdom' }), email_to_linkedin: () => found({ linkedin_url: 'https://www.linkedin.com/in/ada-example' }) });
	const row = { Email: 'ada@example.com' };
	assert.equal((await runOp(accessWith(moltsets.fetch), person, row)).value, 'Analyst');
	assert.equal((await runOp(accessWith(moltsets.fetch), { ...person, field: 'company_domain' }, row)).value, 'example.com');
	assert.equal((await runOp(accessWith(moltsets.fetch), { ...person, field: 'full_name' }, row)).value, 'Ada Lovelace');
	assert.equal((await runOp(accessWith(moltsets.fetch), { ...person, field: 'linkedin' }, row)).value, 'https://www.linkedin.com/in/ada-example');
	assert.deepEqual(moltsets.calls.map((call) => call.tool), ['reverse_email_lookup', 'reverse_email_lookup', 'reverse_email_lookup', 'email_to_linkedin']);
	assert.equal(runs.length, 0);
	const skills = await runOp(accessWith(moltsets.fetch), { ...person, field: 'skills' }, row);
	assert.equal(skills.meta?.moltsets?.outcome, 'skipped');
	assert.equal(runs.length, 1, 'skills come from looot');
});

test('the plan meter reads the 5 hour window and phone tokens from get_account, and a bad key is reported as the key', async () => {
	const account = { id: 'acct', name: 'Test', status: 'active', plan: 'subscription_97', token_balance: -1, unlimited: true, phone_token_balance: 98, fair_use: { enrich: { records: { '5h': { limit: 15_000, used: 10, remaining: 14_990, resets_at: '2026-11-20T18:00:00Z' }, '1w': { limit: 75_000, used: 10, remaining: 74_990, resets_at: '2026-11-27T13:00:00Z' } } } } };
	const ok = new MoltSetsClient({ key: MS_KEY, baseUrl: 'https://api.moltsets.com', fetch: fakeMoltSets({ get_account: () => found(account) }).fetch });
	const check = await checkMoltSets(ok);
	assert.equal(check.ok, true);
	assert.deepEqual(check.plan, { plan: 'subscription_97', active: true, recordsLeft5h: 14_990, recordsLimit5h: 15_000, resetsAt5h: '2026-11-20T18:00:00Z', recordsLeft1w: 74_990, phoneTokens: 98 });
	assert.deepEqual(parsePlan({ status: 'active', fair_use: { enrich: { records: { '5h': { resets_at: null } } } } }), { active: true, resetsAt5h: null });
	const rejected = await checkMoltSets(new MoltSetsClient({ key: MS_KEY, baseUrl: 'https://api.moltsets.com', fetch: fakeMoltSets({ get_account: () => failed(401, 'unauthorized') }).fetch }));
	assert.deepEqual({ ok: rejected.ok, issue: rejected.issue }, { ok: false, issue: 'key' });
	const inactive = await checkMoltSets(new MoltSetsClient({ key: MS_KEY, baseUrl: 'https://api.moltsets.com', fetch: fakeMoltSets({ get_account: () => failed(403, 'account_inactive') }).fetch }));
	assert.equal(inactive.issue, 'plan');
});

test('a MoltSets-only column needs only a MoltSets key and costs no dollars; every other source still needs looot', () => {
	const base = { ...emailOp };
	assert.deepEqual(missingProviders({ ...base, source: 'moltsets' }, (provider) => provider === 'moltsets'), []);
	assert.deepEqual(missingProviders({ ...base, source: 'moltsets' }, (provider) => provider === 'looot'), ['moltsets']);
	assert.deepEqual(missingProviders(base, (provider) => provider === 'moltsets'), ['looot']);
	assert.deepEqual(missingProviders({ ...base, source: 'looot' }, () => false), ['looot']);
	assert.equal(costPerCell({ ...base, source: 'moltsets' }), 0);
	assert.ok(costPerCell(base) > 0, 'a MoltSets then looot column still shows looot as the most it can cost');
});
