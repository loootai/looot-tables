import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOp } from '../../src/lib/server/enrich';
import { composeColumn } from '../../src/lib/server/compose';
import { ColumnOpSchema } from '../../src/lib/types';
import { testAccess } from './access-fixture';
const access = testAccess({ keys: { openai: 'test-key' }, model: 'gpt-5.4-mini' });
function response(request: { model: string }, output: unknown) {
 return Response.json({ id: 'resp_doc', created_at: 1, model: request.model, status: 'completed', output: [{ id: 'msg_doc', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
}
test('document generation receives row cells and requests long-form Markdown', async (t) => {
 const markdown = '# Acme brief\n\n## Overview\n\nAcme builds rockets.';
 t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body));
  const input = JSON.stringify(request.input);
  assert.ok(input.includes('Acme'));
  assert.ok(input.includes('builds rockets'));
  assert.ok(input.includes('Markdown document'));
  assert.ok(input.includes('400-550 words'));
  return response(request, { value: markdown, confidence: .9, sources: [] });
 });
 const op = ColumnOpSchema.parse({ kind: 'ai', prompt: 'Give me a one page brief on {{Company}}', output: 'document', research: 'none' });
 const result = await runOp(access, op, { Company: 'Acme', Description: 'Acme builds rockets.' });
 assert.equal(result.error, undefined);
 assert.equal(result.value, markdown);
});
test('plain-language company brief requests compose into Document output', async (t) => {
 t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body));
  assert.ok(JSON.stringify(request.input).includes('one-page briefs'));
  const output = Object.fromEntries(Object.keys(request.text.format.schema.properties).map((key) => [key, null]));
  Object.assign(output, { name: 'Company brief', kind: 'ai', text: 'Write a one page brief on {{Company}} using {{Description}}.', output: 'document', research: 'none', rationale: 'Use the row to write a brief.' });
  return response(request, output);
 });
 const result = await composeColumn(access, { ask: 'Give me a 1 page brief on the company using row data', columns: [{ name: 'Company', type: 'source' }, { name: 'Description', type: 'source' }] });
 assert.equal(result.op.kind, 'ai');
 if (result.op.kind === 'ai') assert.equal(result.op.output, 'document');
});
