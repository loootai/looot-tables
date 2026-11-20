import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyOpenAI } from '../src/lib/server/verify-openai';

test('model-list validation never generates text', async (t) => {
	t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
		assert.equal(url, 'https://api.openai.com/v1/models');
		assert.equal(options.method, 'GET');
		assert.equal(options.body, undefined);
		return Response.json({ data: [] });
	});
	assert.equal((await verifyOpenAI('test-key', 'test-model', null)).ok, true);
});

test('inference validation uses bounded, unstored Responses inference and requires completed text', async (t) => {
	t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
		assert.equal(url, 'https://api.openai.com/v1/responses');
		assert.equal(options.method, 'POST');
		assert.deepEqual(JSON.parse(options.body as string), { model: 'test-model', input: 'Reply with OK.', max_output_tokens: 64, store: false });
		return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] });
	});
	assert.equal((await verifyOpenAI('test-key', 'test-model', null, true)).inference, true);
});

test('incomplete and empty responses never verify inference', async (t) => {
	const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'incomplete', output: [{ content: [{ type: 'output_text', text: 'Partial' }] }] }));
	assert.equal((await verifyOpenAI('key', 'model', null, true)).ok, false);
	mock.mock.mockImplementation(async () => Response.json({ status: 'completed', output: [] }));
	assert.equal((await verifyOpenAI('key', 'model', null, true)).ok, false);
});

test('API billing, key, model, and rate-limit failures have distinct recovery states', async (t) => {
	for (const [status, code, issue] of [[401, 'invalid_api_key', 'key'], [429, 'insufficient_quota', 'billing'], [404, 'model_not_found', 'model'], [429, 'rate_limit_exceeded', 'rate-limit']] as const) {
		const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code, message: 'secret-key-must-not-be-echoed' } }, { status }));
		const result = await verifyOpenAI('secret-key-must-not-be-echoed', 'model', null, true);
		assert.equal(result.ok, false);
		assert.equal(result.issue, issue);
		assert.ok(!JSON.stringify(result).includes('secret-key-must-not-be-echoed'));
		mock.mock.restore();
	}
});

test('restricted model listing allows an explicit inference test without claiming inference success', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'missing_scope' } }, { status: 403 }));
	const result = await verifyOpenAI('key', 'model', null);
	assert.equal(result.ok, true);
	assert.equal(result.inference, undefined);
	assert.equal((await verifyOpenAI('key', 'model', null, true)).ok, false);
});

test('compatible base URLs use Chat Completions for the paid test', async (t) => {
	t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
		assert.equal(url, 'http://localhost:4545/v1/chat/completions');
		assert.equal(JSON.parse(options.body as string).messages[0].content, 'Reply with OK.');
		return Response.json({ choices: [{ message: { content: 'OK' } }] });
	});
	assert.equal((await verifyOpenAI('key', 'model', 'http://localhost:4545/v1', true)).inference, true);
});

test('network errors and malformed success bodies fail safely', async (t) => {
	const mock = t.mock.method(globalThis, 'fetch', async (): Promise<Response> => { throw new Error('secret-key'); });
	const result = await verifyOpenAI('key', 'model', null, true);
	assert.equal(result.issue, 'connection');
	assert.ok(!result.message?.includes('secret-key'));
	mock.mock.mockImplementation(async () => new Response('<html>unavailable</html>'));
	assert.equal((await verifyOpenAI('key', 'model', null, true)).ok, false);
});
