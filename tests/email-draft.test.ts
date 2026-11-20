import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initSync } from '@ironcalc/wasm';
import { calculateFormulas } from '../src/lib/formulas';
import { EMPTY_EMAIL, parseEmailDraft, renderEmailDraft } from '../src/lib/email-draft';
import { ColumnOpSchema, type Column, type Row } from '../src/lib/types';
import { opDependencies, renameOpReferences } from '../src/lib/references';

const op = ColumnOpSchema.parse({ kind: 'email-draft', mode: 'template', to: '{{Email}}', subject: 'Hello {{Name}}', body: 'Hi {{Name}},\nLet’s talk.' });
test('email templates retain multiline values and track/rename recipient and content dependencies', () => {
 assert.equal(op.kind, 'email-draft');
 if (op.kind !== 'email-draft') return;
 const draft = renderEmailDraft(op, { Email: 'a@example.com', Name: 'Alice' });
 assert.deepEqual(parseEmailDraft(JSON.stringify(draft)), { ...EMPTY_EMAIL, to: 'a@example.com', subject: 'Hello Alice', body: 'Hi Alice,\nLet’s talk.' });
 assert.deepEqual(opDependencies(op), ['Email', 'Name']);
 assert.ok(JSON.stringify(renameOpReferences(op, 'Name', 'Contact')).includes('{{Contact}}'));
 assert.equal(parseEmailDraft('Hi there').body, 'Hi there');
 assert.equal(parseEmailDraft(null).to, '');
});
test('real spreadsheet formulas produce drafts and recalculate when inputs change', () => {
 const require = createRequire(`${process.cwd()}/package.json`);
 initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) });
 const columns: Column[] = ['Email', 'Draft'].map((name, i) => ({ id: `c${i}`, name, type: 'source', format: i ? 'email-draft' : 'text', width: 180, createdAt: 1 }));
 const rows: Row[] = [{ id: 'r', sheetId: 's', order: 0, createdAt: 1, cells: { c0: { v: 'alice@example.com', s: 'done', t: 1 }, c1: { v: null, f: '=\"To: \"&A1&CHAR(10)&\"Subject: Hello\"&CHAR(10)&\"Body: Hi!\"&CHAR(10)&\"Subject: this stays in the body\"', s: 'done', t: 1 } } }];
 const calculate = () => parseEmailDraft(calculateFormulas({ grid: { columns, rows } })[0].cell.v);
 assert.deepEqual(calculate(), { ...EMPTY_EMAIL, to: 'alice@example.com', subject: 'Hello', body: 'Hi!\nSubject: this stays in the body' });
 rows[0].cells.c0.v = 'bob@example.com';
 assert.equal(calculate().to, 'bob@example.com');
});
