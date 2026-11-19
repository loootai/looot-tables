import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateText, wrapLanguageModel, isStepCount, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { CreditBudgetError, CreditLedger, DOLLAR_NANO, LEDGER_KINDS, LEDGERS, meteredCall, RESERVATION_LEASE_SECONDS, type BudgetReason } from '../../src/lib/server/credit-ledger';
import { providerAccess } from '../../src/lib/server/provider-access';
import { requestGrant } from './access-fixture';
import { accountFromIdentity, seal, SESSION_COOKIE } from '../../src/lib/server/auth';
import { trialCharge, trialInputBound, trialMiddleware, trialEnabled } from '../../src/lib/server/openai-trial';
import { actor, ledgerFixture } from './ledger-fixture';

const refused = (reason: BudgetReason, pattern: RegExp) => (error: unknown) => error instanceof CreditBudgetError && error.reason === reason && pattern.test(error.message);

for (const kind of LEDGER_KINDS) {
	const { budgets, reservations, label } = LEDGERS[kind];

	test(`${kind}: one dollar belongs to a verified organization, survives visits, and is shared concurrently`, async (t) => {
		const { ledger } = await ledgerFixture(t, kind);
		const alice = actor(), teammate = actor('bob');
		assert.equal((await ledger.balance(alice)).remainingUsd, 1);
		const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => ledger.reserve(i % 2 ? teammate : alice, 300_000_000)));
		assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 3);
		assert.equal((await ledger.balance(teammate)).remainingUsd, 0.1);
		assert.equal((await ledger.balance(actor('alice', 'two'))).remainingUsd, 1);
		assert.equal((await ledger.balance(actor('alice', 'one', 'https://other.example.com'))).remainingUsd, 1);
		const held = attempts.find((result) => result.status === 'fulfilled');
		assert.ok(held?.status === 'fulfilled');
		await ledger.settle(held.value, 20_000_000);
		assert.equal((await ledger.balance(alice)).remainingUsd, 0.38);
		await ledger.settle(held.value, 0);
		assert.equal((await ledger.balance(teammate)).remainingUsd, 0.38, 'settlement cannot refund twice');
		const rejected = attempts.find((result) => result.status === 'rejected');
		assert.ok(rejected?.status === 'rejected' && refused('org_exhausted', new RegExp(`insufficient ${label} credit`))(rejected.reason));
	});

	test(`${kind}: the deployment ceiling applies across organizations and uncertain calls keep their debit`, async (t) => {
		const { ledger } = await ledgerFixture(t, kind, 1);
		const id = await ledger.reserve(actor(), 600_000_000);
		await ledger.settle(id, null);
		await ledger.settle(id, 0);
		assert.equal((await ledger.balance(actor())).remainingUsd, 0.4);
		await assert.rejects(ledger.reserve(actor('bob', 'two'), 500_000_000), refused('deployment_exhausted', /deployment/));
		assert.equal((await ledger.balance(actor('bob', 'two'))).remainingUsd, 1, 'failed reservation rolls back');
		assert.equal((await ledger.balance(actor('bob', 'two'))).deploymentAvailable, true);
	});

	test(`${kind}: in-flight and request-rate limits are shared across members and reported as a retryable wait`, async (t) => {
		const { ledger, db } = await ledgerFixture(t, kind);
		const ids = await Promise.all(Array.from({ length: 8 }, () => ledger.reserve(actor(), 100)));
		const limited = await ledger.reserve(actor('bob'), 100).catch((error: unknown) => error);
		assert.ok(refused('rate_limited', new RegExp(`too many ${label} requests\\. Wait a moment`))(limited));
		assert.deepEqual((limited as CreditBudgetError).failure, { reason: 'rate_limited', retryable: true, provider: LEDGERS[kind].provider });
		for (const id of ids) await ledger.settle(id, 0);
		await db.query(`INSERT INTO ${reservations} (id, budget_id, reserved_nano, status) SELECT 'rate-' || n, budget_id, 1, 'settled' FROM generate_series(1,112) n CROSS JOIN (SELECT budget_id FROM ${reservations} LIMIT 1) b`);
		await assert.rejects(ledger.reserve(actor('bob'), 100), refused('rate_limited', /too many/));
		await db.query(`UPDATE ${budgets} SET spent_nano=$1 WHERE id <> 'global'`, [DOLLAR_NANO]);
		const exhausted = await ledger.reserve(actor('bob'), 100).catch((error: unknown) => error);
		assert.ok(refused('org_exhausted', /insufficient/)(exhausted));
		assert.equal((exhausted as CreditBudgetError).failure.retryable, false);
		assert.equal((exhausted as CreditBudgetError).failure.reason, 'credits_exhausted');
	});

	test(`${kind}: a hold past its lease expires as uncertain, keeps its debit, and frees the throttle`, async (t) => {
		const { ledger, db } = await ledgerFixture(t, kind);
		assert.ok(RESERVATION_LEASE_SECONDS > 300, 'the lease must outlive the longest request');
		const ids = await Promise.all(Array.from({ length: 8 }, () => ledger.reserve(actor(), 1_000)));
		await assert.rejects(ledger.reserve(actor(), 1_000), refused('rate_limited', /too many/));
		// Functions killed at maxDuration never settle; one hold is still within its lease.
		await db.query(`UPDATE ${reservations} SET created_at = now() - interval '${RESERVATION_LEASE_SECONDS + 60} seconds' WHERE id <> $1`, [ids[0]]);
		await db.query(`UPDATE ${reservations} SET created_at = now() - interval '${RESERVATION_LEASE_SECONDS - 60} seconds' WHERE id = $1`, [ids[0]]);
		const fresh = await ledger.reserve(actor('bob'), 1_000);
		const statuses = (await db.query<{ id: string; status: string; charged_nano: string | null }>(`SELECT id, status, charged_nano FROM ${reservations}`)).rows;
		assert.deepEqual(statuses.filter((row) => row.status === 'held').map((row) => row.id).sort(), [ids[0], fresh].sort());
		assert.ok(statuses.filter((row) => row.status === 'uncertain').every((row) => Number(row.charged_nano) === 1_000));
		assert.equal((await ledger.balance(actor())).remainingUsd, 1 - 9_000 / DOLLAR_NANO, 'expired holds keep their whole debit');
		await ledger.settle(ids[1], 0);
		assert.equal((await ledger.balance(actor())).remainingUsd, 1 - 9_000 / DOLLAR_NANO, 'a late settlement cannot refund an expired hold');
		await ledger.settle(ids[0], 400);
		assert.equal((await ledger.balance(actor())).remainingUsd, 1 - 8_400 / DOLLAR_NANO);
	});

	test(`${kind}: cap changes apply to existing ledger instances without changing organization spending`, async t => {
		const { ledger, db, database } = await ledgerFixture(t, kind, 1);
		await ledger.settle(await ledger.reserve(actor(), 600_000_000), null);
		await assert.rejects(ledger.reserve(actor('bob', 'two'), 500_000_000), refused('deployment_exhausted', /deployment/));
		await db.query('UPDATE enrichable.credit_limits SET cap_nano=$2 WHERE kind=$1', [kind, 2 * DOLLAR_NANO]);
		const second = new CreditLedger(kind, database);
		await second.reserve(actor('bob', 'two'), 500_000_000);
		await ledger.reserve(actor(), 100_000_000);
		assert.equal((await ledger.balance(actor())).remainingUsd, .3);
		await db.query('UPDATE enrichable.credit_limits SET cap_nano=$2 WHERE kind=$1', [kind, DOLLAR_NANO]);
		assert.equal((await ledger.balance(actor())).deploymentAvailable, false);
		await assert.rejects(second.reserve(actor('carol', 'three'), 1), refused('deployment_exhausted', /deployment/));
		await db.query('DELETE FROM enrichable.credit_limits WHERE kind=$1', [kind]);
		await assert.rejects(ledger.reserve(actor(), 1), /Missing or invalid/);
		await assert.rejects(ledger.balance(actor()), /Missing or invalid/);
	});

	test(`${kind}: database constraints reject invalid caps`, async t => {
		const { db } = await ledgerFixture(t, kind);
		for (const cap of ['0', '-1', '9007199254740992']) {
			await assert.rejects(db.query('UPDATE enrichable.credit_limits SET cap_nano=$2 WHERE kind=$1', [kind, cap]), /check constraint/);
		}
	});
}

test('metered calls settle proven charges, refund proven non-charges, and retain unknown ones', async (t) => {
	const { ledger, access, db } = await ledgerFixture(t, 'enrichment');
	assert.equal(await meteredCall(access, actor(), 100_000_000, async (meter) => { meter.charge = 20_000_000; return 'found'; }), 'found');
	await assert.rejects(meteredCall(access, actor(), 100_000_000, async (meter) => { meter.charge = 0; throw new Error('declined'); }), /declined/);
	await assert.rejects(meteredCall(access, actor(), 100_000_000, async () => { throw new Error('interrupted'); }), /interrupted/);
	assert.equal((await ledger.balance(actor())).remainingUsd, 0.88);
	assert.deepEqual((await db.query<{ status: string }>('SELECT status FROM enrichable.enrichment_reservations ORDER BY status')).rows.map((row) => row.status), ['settled', 'settled', 'uncertain']);
	let called = false;
	await assert.rejects(meteredCall(access, actor(), DOLLAR_NANO, async () => { called = true; }), refused('org_exhausted', /insufficient enrichment credit/));
	assert.equal(called, false, 'a refused reservation never reaches the provider');
});

test('a paid result is returned even when its settlement fails; the hold keeps the whole reservation', async (t) => {
	const { ledger, access, db } = await ledgerFixture(t, 'enrichment');
	t.mock.method(ledger, 'settle', async () => { throw new Error('connection reset'); });
	const logged = t.mock.method(console, 'error', () => {});
	assert.equal(await meteredCall(access, actor(), 100_000_000, async (meter) => { meter.charge = 20_000_000; return 'found'; }), 'found');
	assert.equal(logged.mock.callCount(), 1, 'the failed settlement is logged');
	assert.deepEqual((await db.query<{ status: string }>('SELECT status FROM enrichable.enrichment_reservations')).rows.map((row) => row.status), ['held'], 'it expires as uncertain, keeping the full charge');
	assert.equal((await ledger.balance(actor())).remainingUsd, 0.9);
});

const usage = { inputTokens: { total: 2000, noCache: 1500, cacheRead: 500, cacheWrite: 0 }, outputTokens: { total: 100, text: 80, reasoning: 20 } };
test('trial charges include reasoning output and cached inputs; missing usage is never free', () => {
	assert.equal(trialCharge(usage), 205_000);
	assert.equal(trialCharge({ ...usage, outputTokens: { ...usage.outputTokens, total: undefined } }), null);
	assert.throws(() => trialInputBound({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200_000) }] }] }), /too large/);
	assert.throws(() => trialInputBound({ prompt: [{ role: 'user', content: [{ type: 'file', data: { type: 'data', data: new Uint8Array() }, mediaType: 'image/png' }] }] }), (error: unknown) => /text only/.test(String(error)) && (error as { failure?: unknown }).failure !== undefined);
});

test('trial SDK tool loops reserve and settle every step, cap output and clear provider overrides', async (t) => {
	const { ledger, db, access } = await ledgerFixture(t, 'openai');
	let calls = 0;
	const provider = new MockLanguageModelV4({
		doGenerate: async (params) => {
			assert.equal(params.maxOutputTokens, 4096);
			assert.equal(params.reasoning, 'none');
			assert.deepEqual(params.providerOptions, { openai: { store: false, serviceTier: 'default' } });
			assert.ok((await ledger.balance(actor('bob'))).remainingUsd < 1, 'credit is reserved before provider starts');
			calls++;
			return { content: calls === 1 ? [{ type: 'tool-call', toolCallId: 'lookup', toolName: 'lookup', input: '{}' }] : [{ type: 'text', text: 'Done' }], finishReason: { unified: calls === 1 ? 'tool-calls' : 'stop', raw: undefined }, usage, warnings: [] };
		},
	});
	const model = wrapLanguageModel({ model: provider, middleware: trialMiddleware(actor(), access) });
	const result = await generateText({ model, prompt: 'Research this row.', maxOutputTokens: 100_000, providerOptions: { openai: { serviceTier: 'priority' } }, tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => ({ name: 'Example' }) }) }, stopWhen: isStepCount(3), maxRetries: 0 });
	assert.equal(result.text, 'Done');
	assert.equal(calls, 2);
	assert.equal((await ledger.balance(actor())).remainingUsd, 1 - 410_000 / DOLLAR_NANO);
	assert.equal((await db.query("SELECT * FROM enrichable.openai_reservations WHERE status='settled'")).rows.length, 2);
});

test('trial provider failure retains credit, and exhausted budgets stop calls before reaching the provider', async (t) => {
	const { access, db } = await ledgerFixture(t, 'openai');
	let calls = 0;
	const provider = new MockLanguageModelV4({ doGenerate: async () => { calls++; throw new Error('provider timeout'); } });
	const model = wrapLanguageModel({ model: provider, middleware: trialMiddleware(actor(), access) });
	await assert.rejects(generateText({ model, prompt: 'test', maxRetries: 0 }), /provider timeout/);
	assert.equal(calls, 1);
	assert.equal((await db.query("SELECT * FROM enrichable.openai_reservations WHERE status='uncertain'")).rows.length, 1);
	await db.query("UPDATE enrichable.openai_budgets SET spent_nano=$1 WHERE id <> 'global'", [DOLLAR_NANO]);
	await assert.rejects(generateText({ model, prompt: 'test', maxRetries: 0 }), refused('org_exhausted', /insufficient AI trial credit.*An OpenAI API key is required/));
	assert.equal(calls, 1);
});

test('sponsored credentials require a verified session, pin model and endpoint, and preserve BYOK', async (t) => {
	const values = { ENRICHABLE_OPENAI_TRIAL_ENABLED: 'true', OPENAI_API_KEY: 'test-server-secret', ENRICHABLE_APP_URL: 'https://www.enrichable.io', ENRICHABLE_SESSION_SECRET: 'test-session-secret-with-at-least-32-characters', CONTEXT_IDENTITY_ISSUER: 'https://identity.example.com' };
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	await assert.rejects(requestGrant(new Request('https://www.enrichable.io/api/enrich')), /Sign in/);
	const account = accountFromIdentity(actor());
	const cookie = `${SESSION_COOKIE}=${seal({ ...account, sessionId: 'x'.repeat(40) }, 'session', 60)}`;
	const headers = { cookie, 'x-openai-model': 'gpt-6-astra', 'x-openai-base-url': 'https://other-provider.example.com/v1' };
	const sponsored = await requestGrant(new Request('https://www.enrichable.io/api/enrich', { headers }));
	assert.equal(sponsored.model, 'gpt-6-luna');
	assert.equal(sponsored.openaiBaseUrl, null);
	assert.equal(sponsored.trialAccount?.organization.id, account.organization.id);
	assert.equal(providerAccess(sponsored).openai('gpt-6-astra').modelId, 'gpt-6-luna');
	const manual = await requestGrant(new Request('https://www.enrichable.io/api/enrich', { headers: { ...headers, 'x-openai-key': 'test-own-key' } }));
	assert.equal(manual.trialAccount, undefined);
	assert.equal(manual.model, 'gpt-6-astra');
	assert.equal(manual.openaiBaseUrl, headers['x-openai-base-url']);
	const copiedServerKey = await requestGrant(new Request('https://www.enrichable.io/api/enrich', { headers: { ...headers, 'x-openai-key': 'test-server-secret' } }));
	assert.ok(copiedServerKey.trialAccount, 'passing the sponsored key back must not bypass metering');
	process.env.OPENAI_API_KEY = 'REPLACE_WITH_OPENAI_API_KEY';
	assert.equal(trialEnabled(), false, 'the deployment placeholder must never activate paid requests');
});
