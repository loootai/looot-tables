import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOp } from '../../src/lib/server/enrich';
import { ColumnOpSchema } from '../../src/lib/types';
import { parseEmailDraft } from '../../src/lib/email-draft';
import { testAccess } from './access-fixture';
const access = testAccess({ keys: { openai: 'test-key' }, model: 'gpt-5.4-mini' });
test('email templates run without provider credentials or network calls', async () => {
 const op = ColumnOpSchema.parse({ kind: 'email-draft', mode: 'template', to: '{{Email}}', subject: 'Hi', body: 'Hello {{Name}}' });
 const result = await runOp(testAccess(), op, { Email: 'a@example.com', Name: 'Alice' });
 assert.equal(result.error, undefined);
 assert.equal(parseEmailDraft(result.value).body, 'Hello Alice');
});
test('AI drafts use structured output and preserve explicitly configured recipients', async (t) => {
 t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body));
  assert.equal(request.text.format.type, 'json_schema');
  assert.ok(JSON.stringify(request.input).includes('Alice'));
  return Response.json({ id: 'resp_email', created_at: 1, model: request.model, status: 'completed', output: [{ id: 'msg_email', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ to: 'wrong@example.com', cc: 'unexpected@example.com', bcc: '', subject: 'Let’s connect', body: 'Hi Alice,\nWould you like to talk?' }), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
 });
 const op = ColumnOpSchema.parse({ kind: 'email-draft', prompt: 'Draft an email to {{Name}}', to: '{{Email}}' });
 const result = await runOp(access, op, { Name: 'Alice', Email: 'alice@example.com' });
 assert.equal(result.error, undefined);
 assert.deepEqual(parseEmailDraft(result.value), { to: 'alice@example.com', cc: '', bcc: '', subject: 'Let’s connect', body: 'Hi Alice,\nWould you like to talk?' });
});

test('plain-language email requests compose into a structured Email draft column', async (t) => {
 const { composeColumn } = await import('../../src/lib/server/compose');
 t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body));
  assert.ok(JSON.stringify(request.input).includes('draft an email to'));
  const fields = request.text.format.schema.properties;
  const output = Object.fromEntries(Object.keys(fields).map((key) => [key, null]));
  Object.assign(output, { name: 'Introduction email', kind: 'email-draft', text: 'Introduce our product to {{Name}}', rationale: 'Draft a personalized introduction.', emailMode: 'ai', emailFields: { to: '{{Email}}', cc: '', bcc: '', subject: '', body: '' } });
  return Response.json({ id: 'resp_compose', created_at: 1, model: request.model, status: 'completed', output: [{ id: 'msg_compose', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
 });
 const result = await composeColumn(access, { ask: 'draft an email to {{Name}} introducing our product', columns: [{ name: 'Name', type: 'source' }, { name: 'Email', type: 'source' }] });
 assert.equal(result.op.kind, 'email-draft');
 if (result.op.kind === 'email-draft') assert.equal(result.op.to, '{{Email}}');
});
