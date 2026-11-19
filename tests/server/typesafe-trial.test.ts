import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noul } from '@typesafe-ai/sdk';
import { MockLanguageModelV4 } from 'ai/test';
import type { Account } from '../../src/lib/auth-identity';
import { CreditBudgetError, DOLLAR_NANO } from '../../src/lib/server/credit-ledger';
import { decideNoul } from '../../src/lib/server/jev';
import { BROWSER_POLICY, MCP_POLICY, resolveGrant, type AccessInputs, type AccessPolicy } from '../../src/lib/server/provider-access';
import { typesafeCharge, typesafeReservation, typesafeTrial, typesafeTrialEnabled, type Jev } from '../../src/lib/server/typesafe-trial';
import { testAccess } from './access-fixture';
import { actor, ledgerFixture } from './ledger-fixture';

const alice = actor();
const request = { model: 'jev-latest', state: 'ROW: Acme builds accounting software.', questions: { answer: noul('Does it build software?') } };
const answered = (inputTokens: number | null) => ({ model: 'jev-1.14.0', answers: { answer: { noul: 0.9 } }, usage: { input_tokens: inputTokens, output_tokens: 4 } });
const fake = (systemOne: () => Promise<unknown>) => ({ systemOne }) as unknown as Jev;
const failed = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const remaining = (spentNano: number) => (DOLLAR_NANO - spentNano) / DOLLAR_NANO;

function withEnv(values: Record<string, string>, run: () => void) {
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	try { run(); } finally {
		for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
}

test('the TypeSafe trial is opt-in, hosted-only, and needs a deployment key', () => {
	const on = { ENRICHABLE_APP_URL: 'https://www.enrichable.io', ENRICHABLE_TYPESAFE_TRIAL_ENABLED: 'true', TYPESAFE_API_KEY: 'ts_server' };
	withEnv(on, () => assert.equal(typesafeTrialEnabled(), true));
	withEnv({ ...on, ENRICHABLE_TYPESAFE_TRIAL_ENABLED: 'false' }, () => assert.equal(typesafeTrialEnabled(), false));
	withEnv({ ...on, TYPESAFE_API_KEY: '   ' }, () => assert.equal(typesafeTrialEnabled(), false));
	withEnv({ ...on, ENRICHABLE_APP_URL: 'https://self-hosted.example.com' }, () => assert.equal(typesafeTrialEnabled(), false));
});

test('the TypeSafe trial meters the deployment key for signed-in browser callers without a key of their own', () => {
	const server = { unlocked: false, keys: { typesafe: 'server-typesafe' }, trial: false, typesafeTrial: true };
	const grant = (policy: AccessPolicy, headers: Record<string, string> = {}, account: Account | null = alice, vault: AccessInputs['vault'] = null) => resolveGrant(policy, { account: account ?? undefined, headers: new Headers(headers), vault, server });
	const sponsored = grant(BROWSER_POLICY);
	assert.deepEqual([sponsored.keys.typesafe, sponsored.typesafeTrialAccount], ['server-typesafe', alice]);
	assert.equal(grant(BROWSER_POLICY, { 'x-typesafe-key': 'server-typesafe' }).typesafeTrialAccount, alice, 'sending the server key back is still metered');
	const own = grant(BROWSER_POLICY, { 'x-typesafe-key': 'own-typesafe' });
	assert.deepEqual([own.keys.typesafe, own.typesafeTrialAccount], ['own-typesafe', undefined]);
	const vault = grant(BROWSER_POLICY, {}, alice, { keys: { typesafe: 'vault-typesafe' }, preferences: {} });
	assert.deepEqual([vault.keys.typesafe, vault.typesafeTrialAccount], ['vault-typesafe', undefined]);
	const signedOut = grant(BROWSER_POLICY, {}, null);
	assert.deepEqual([signedOut.keys.typesafe, signedOut.typesafeTrialAccount], [undefined, undefined], 'TypeSafe is optional, so signing out loses the trial without failing');
	const mcp = grant(MCP_POLICY);
	assert.deepEqual([mcp.keys.typesafe, mcp.typesafeTrialAccount], [undefined, undefined]);
	assert.equal(resolveGrant(BROWSER_POLICY, { account: alice, headers: new Headers(), server: { ...server, typesafeTrial: false } }).keys.typesafe, undefined, 'a locked deployment key is never used without the trial');
	const both = resolveGrant(BROWSER_POLICY, { account: alice, headers: new Headers(), server: { ...server, keys: { openai: 'server-openai', typesafe: 'server-typesafe' }, trial: true } });
	assert.deepEqual([both.keys.openai, both.trialAccount, both.keys.typesafe, both.typesafeTrialAccount], ['server-openai', alice, 'server-typesafe', alice]);
});

test('a TypeSafe charge is 42 nanodollars per reported input token; unknown usage is never free', () => {
	assert.equal(typesafeCharge({ input_tokens: 1_000, output_tokens: 50 }), 42_000);
	assert.equal(typesafeCharge({ input_tokens: 0, output_tokens: 0 }), 0);
	for (const input_tokens of [null, -1, 1.5]) assert.equal(typesafeCharge({ input_tokens, output_tokens: 1 }), null);
	assert.equal(typesafeCharge(undefined), null);
	assert.ok(typesafeReservation(request) >= Buffer.byteLength(JSON.stringify(request)) * 42, 'every byte sent is covered');
	assert.equal(typesafeReservation({ ...request, state: 'x'.repeat(500_000) }), 65_536 * 42, 'capped at the per-request context');
});

test('trial decisions are reserved before they are sent, settled at reported usage, and refunded only when provably unbilled', async (t) => {
	const { ledger, access } = await ledgerFixture(t, 'typesafe');
	const reserved = typesafeReservation(request);
	let during = 1;
	const settled = await typesafeTrial(fake(async () => { during = (await ledger.balance(alice)).remainingUsd; return answered(1_000); }), alice, access).systemOne(request);
	assert.equal(settled.answers.answer.noul, 0.9);
	assert.equal(during, remaining(reserved), 'credit is reserved before TypeSafe sees the request');
	let spent = 42_000;
	assert.equal((await ledger.balance(alice)).remainingUsd, remaining(spent));
	await typesafeTrial(fake(async () => answered(null)), alice, access).systemOne(request);
	spent += reserved;
	assert.equal((await ledger.balance(alice)).remainingUsd, remaining(spent), 'missing usage keeps the whole reservation');
	await assert.rejects(typesafeTrial(fake(async () => { throw failed(429); }), alice, access).systemOne(request), /429/);
	assert.equal((await ledger.balance(alice)).remainingUsd, remaining(spent), 'a refused request is refunded');
	await assert.rejects(typesafeTrial(fake(async () => { throw failed(500); }), alice, access).systemOne(request), /500/);
	spent += reserved;
	assert.equal((await ledger.balance(alice)).remainingUsd, remaining(spent), 'a server error may have been billed');
	assert.equal((await ledger.balance(actor('bob'))).remainingUsd, remaining(spent), 'the credit is shared by the organization');
	assert.equal((await ledger.balance(actor('carol', 'two'))).remainingUsd, 1);
});

test('once the TypeSafe trial is used up, decisions fall back to OpenAI without sending anything to TypeSafe', async (t) => {
	const { ledger, access: typesafeLedger } = await ledgerFixture(t, 'typesafe');
	await ledger.reserve(alice, DOLLAR_NANO);
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected TypeSafe request'); });
	const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
	const models: string[] = [];
	const openai = (_apiKey: string, model: string) => {
		models.push(model);
		return new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify({ reasoning: 'It sells software.', probability: 0.8 }) }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] }) });
	};
	const grant = { account: alice, keys: { typesafe: 'server-typesafe', openai: 'test-openai' }, model: 'gpt-5.4-mini', typesafeTrialAccount: alice };
	const fallback = await decideNoul(testAccess(grant, { openai, typesafeLedger }), 'jev', 'ROW: Acme', 'Software?');
	assert.deepEqual([fallback.engine, fallback.probability, models], ['openai', 0.8, ['gpt-5.4-mini']]);
	const withoutOpenAI = testAccess({ ...grant, keys: { typesafe: 'server-typesafe' } }, { typesafeLedger });
	await assert.rejects(decideNoul(withoutOpenAI, 'jev', 'ROW: Acme', 'Software?'), (error: unknown) => error instanceof CreditBudgetError
		&& /insufficient TypeSafe trial credit/.test(error.message)
		&& JSON.stringify(error.failure) === JSON.stringify({ reason: 'credits_exhausted', retryable: false, provider: 'typesafe' }));
});
