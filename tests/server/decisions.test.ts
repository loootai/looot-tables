import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { decideChoice, decideNoul, decideScore } from '../../src/lib/server/jev';
import { providerAccess } from '../../src/lib/server/provider-access';
import { requestGrant, testAccess } from './access-fixture';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };

/** An in-memory OpenAI adapter: records each requested model id and answers structured requests with the next output. */
function fakeOpenAI(outputs: object[], models: string[]) {
	return (_apiKey: string, model: string) => {
		models.push(model);
		return new MockLanguageModelV4({
			doGenerate: async (params) => {
				assert.equal(params.responseFormat?.type, 'json');
				const output = outputs.shift();
				assert.ok(output, 'Only the expected decision requests should be sent');
				return { content: [{ type: 'text', text: JSON.stringify(output) }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
			},
		});
	};
}

test('all decision types fall back to OpenAI without a TypeSafe key, even when Jev is preferred', async () => {
	const outputs = [
		{ reasoning: 'The company builds software.', probability: 0.9 },
		{ reasoning: 'The company builds software.', choice: 'Software', confidence: 0.9 },
		{ reasoning: 'The evidence matches the high level.', level: 1, confidence: 0.9 },
	];
	const models: string[] = [];
	const access = testAccess({ keys: { openai: 'test-openai' }, model: 'gpt-5.4-mini' }, { openai: fakeOpenAI(outputs, models) });
	const state = 'The company builds software.';
	const noul = await decideNoul(access, 'jev', state, 'Does it build software?');
	assert.equal(noul.engine, 'openai');
	assert.equal(noul.probability, 0.9);
	const choice = await decideChoice(access, 'jev', state, 'What industry?', [{ label: 'Software' }, { label: 'Retail' }]);
	assert.equal(choice.engine, 'openai');
	assert.equal(choice.choice, 'Software');
	const score = await decideScore(access, 'jev', state, 'How strong is the fit?', ['Low', 'High']);
	assert.equal(score.engine, 'openai');
	assert.equal(score.level, 'High');
	assert.equal(score.score, 1);
	assert.deepEqual(models, ['gpt-5.4-mini', 'gpt-5.4-mini', 'gpt-5.4-mini']);
	assert.equal(outputs.length, 0);
});

test('a separate classifier model overrides Jev for all decision types without changing the main model', async (t) => {
	const { runOp } = await import('../../src/lib/server/enrich');
	const { ColumnOpSchema } = await import('../../src/lib/types');
	const grant = await requestGrant(new Request('http://localhost/api/enrich', { headers: { 'x-openai-key': 'sk-classifier-test', 'x-openai-model': 'general-model', 'x-classifier-model': 'classifier-model', 'x-typesafe-key': 'test-typesafe' } }));
	assert.equal(grant.model, 'general-model');
	assert.equal(grant.classifierModel, 'classifier-model');
	// Jev is configured too; choosing it would reach the network and fail the cell.
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network request'); });
	const outputs = [{ reasoning: 'Evidence.', probability: .9 }, { reasoning: 'Evidence.', choice: 'Software', confidence: .9 }, { reasoning: 'Evidence.', level: 1, confidence: .9 }];
	const models: string[] = [];
	const access = providerAccess(grant, { openai: fakeOpenAI(outputs, models) });
	const operations = [
		{ kind: 'check', question: 'Software?', threshold: .5, decider: 'jev' },
		{ kind: 'classify', question: 'Industry?', options: [{ label: 'Software' }, { label: 'Retail' }], decider: 'jev' },
		{ kind: 'score', question: 'Fit?', levels: ['Low', 'High'], decider: 'jev' },
	] as const;
	for (const input of operations) {
		const result = await runOp(access, ColumnOpSchema.parse(input), { Company: 'Acme builds software' });
		assert.equal(result.error, undefined);
		assert.equal(result.meta?.model, 'classifier-model');
	}
	assert.deepEqual(models, ['classifier-model', 'classifier-model', 'classifier-model']);
});

test('the decider preference comes from the resolved access, not from options threaded through each call', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network request'); });
	const models: string[] = [];
	const base = { keys: { openai: 'test-openai', typesafe: 'test-typesafe' }, model: 'gpt-5.4-mini' };
	assert.equal(testAccess(base).decider('jev'), 'jev');
	assert.equal(testAccess(base).decider('openai'), 'openai', 'a column can ask for OpenAI');
	const preferOpenAI = testAccess({ ...base, preferJev: false }, { openai: fakeOpenAI([{ reasoning: 'Evidence.', probability: .2 }], models) });
	assert.equal(preferOpenAI.decider('jev'), 'openai');
	assert.equal((await decideNoul(preferOpenAI, 'jev', 'State.', 'Question?')).engine, 'openai');
	assert.equal(testAccess({ ...base, classifierModel: 'classifier' }).decider('jev'), 'openai', 'a classifier model forces OpenAI');
	await assert.rejects(decideNoul(testAccess(), 'jev', 'State.', 'Question?'), /TypeSafe or OpenAI key/);
});
