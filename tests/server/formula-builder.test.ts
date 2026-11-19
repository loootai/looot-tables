import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST } from '../../src/app/api/formula-builder/route';
import { testAccess } from './access-fixture';

const input = { ask: 'Double the value', formula: '=', target: 'B2', columns: [{ name: 'Value', address: 'A' }] };
const request = (body: unknown = input) => new Request('https://enrichable.test/api/formula-builder', { method: 'POST', headers: { 'content-type': 'application/json', 'x-openai-key': 'test-key', 'x-openai-model': 'configured-default' }, body: JSON.stringify(body) });

test('formula generator uses the configured default model and returns structured output', async (t) => {
	t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
		assert.equal(String(url), 'https://api.openai.com/v1/responses');
		const body = JSON.parse(String(init?.body));
		assert.equal(body.model, 'configured-default');
		assert.equal(body.text.format.type, 'json_schema');
		assert.ok(JSON.stringify(body.input).includes('B2'));
		assert.ok(JSON.stringify(body.input).includes('#DIV/0!'));
		assert.ok(JSON.stringify(body.input).includes('Value'));
		return Response.json({ id: 'resp_formula', created_at: 1, model: body.model, status: 'completed', output: [{ id: 'msg_formula', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ formula: '=A2*2', explanation: 'Doubles the value in this row.' }), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
	});
	const result = await POST(request({ ...input, formula: '=A2/0', feedback: { samples: [{ address: 'B2', error: '#DIV/0!', inputs: { Value: '3' } }] } }));
	assert.equal(result.status, 200);
	assert.equal(result.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await result.json(), { formula: '=A2*2', explanation: 'Doubles the value in this row.' });
});

test('formula generator failures say why in a structured failure', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 }));
	const result = await POST(request());
	assert.equal(result.status, 500);
	assert.deepEqual((await result.json()).failure, { reason: 'credential_invalid', retryable: false, provider: 'openai' });
});

test('formula generator rejects bad references and missing descriptions before calling a provider', async () => {
	assert.equal((await POST(request({ ...input, target: 'invalid' }))).status, 400);
	assert.equal((await POST(request({ ...input, ask: ' ' }))).status, 400);
	assert.equal((await POST(new Request('https://enrichable.test/api/formula-builder', { method: 'POST', body: '{' }))).status, 400);
});


test('column composer routes existing-data manipulation to the formula builder', async (t) => {
 const { composeColumn } = await import('../../src/lib/server/compose');
 t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  assert.ok(JSON.stringify(body.input).includes('basic manipulation of existing data'));
  const output = Object.fromEntries(Object.keys(body.text.format.schema.properties).map((key) => [key, null]));
  Object.assign(output, { name: 'Uppercase name', kind: 'formula', text: 'Uppercase the Name column', rationale: 'Use a local formula.' });
  return Response.json({ id: 'resp_compose_formula', created_at: 1, model: body.model, status: 'completed', output: [{ id: 'msg_formula', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
 });
 const result = await composeColumn(testAccess({ keys: { openai: 'test-key' }, model: 'configured-default' }), { ask: 'Uppercase Name', columns: [{ name: 'Name', type: 'source' }] });
 assert.deepEqual(result.op, { kind: 'formula', request: 'Uppercase the Name column' });
});

test('fallback composer excludes formulas and retains the original request', async (t) => {
 const { composeColumn } = await import('../../src/lib/server/compose');
 t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body));
  assert.ok(JSON.stringify(body.input).includes('Do not select formula'));
  assert.ok(!body.text.format.schema.properties.kind.enum.includes('formula'));
  assert.ok(JSON.stringify(body.input).includes('Uppercase Name'));
  const output = Object.fromEntries(Object.keys(body.text.format.schema.properties).map((key) => [key, null]));
  Object.assign(output, { name: 'Uppercase name', kind: 'ai', text: 'Uppercase {{Name}}', output: 'text', research: 'none', rationale: 'Use the row.' });
  return Response.json({ id: 'resp_fallback', created_at: 1, model: body.model, status: 'completed', output: [{ id: 'msg_fallback', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
 });
 const result = await composeColumn(testAccess({ keys: { openai: 'test-key' }, model: 'configured-default' }), { ask: 'Uppercase Name', columns: [{ name: 'Name', type: 'source' }], excludeFormula: true });
 assert.equal(result.op.kind, 'ai');
});

test('formula and column handlers redact provider errors containing server keys', async (t) => {
	const { POST: compose } = await import('../../src/app/api/compose-column/route');
	const values = { NODE_ENV: 'production', ENRICHABLE_APP_URL: 'https://self-hosted.example', ENRICHABLE_DEV_AUTH: '', ENRICHABLE_PASSWORD: 'test-password', OPENAI_API_KEY: 'sk-demonstration-not-real', OPENAI_BASE_URL: '' };
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	delete process.env.OPENAI_BASE_URL;
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: `Invalid API key: ${values.OPENAI_API_KEY}`, type: 'invalid_request_error', code: 'invalid_api_key' } }, { status: 401 }));
	for (const [handler, body] of [[POST, input], [compose, { ask: 'Find the CEO', columns: [{ name: 'Domain', type: 'source' }] }]] as const) {
		const response = await handler(new Request('https://self-hosted.example/api/test', { method: 'POST', headers: { 'content-type': 'application/json', 'x-enrichable-password': values.ENRICHABLE_PASSWORD }, body: JSON.stringify(body) }));
		assert.equal(response.status, 500);
		const result = await response.json();
		assert.ok(!result.error.includes(values.OPENAI_API_KEY));
		assert.match(result.error, /\[redacted\]/);
	}
});
