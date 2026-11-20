import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitCell, admitChange, fitGuessedFormat, invalidCell, redefinedColumns, type CellSource } from '../src/lib/cell-admission';
import type { Cell, CellValue, Column, ColumnOp } from '../src/lib/types';

const column = (format: Column['format'], extra: Partial<Column> = {}): Column => ({ id: 'c', name: 'Field', type: 'source', width: 180, createdAt: 1, format, ...extra });
const website = column('website');
const currency = column('currency');
const category = column('category', { categoryOptions: ['New', 'Done'] });
const checkbox = column('checkbox');
const ai: ColumnOp = { kind: 'ai', prompt: 'Website of {{Company}}', output: 'text', research: 'web' };
const aiWebsite = column('website', { type: 'enriched', op: ai });
const aiText = column(undefined, { type: 'enriched', op: ai });
const template = column(undefined, { type: 'enriched', op: { kind: 'template', template: '{{Company}}' } });
const done = (v: CellValue): Cell => ({ v, s: 'done', t: 5 });

type Expected = { v: CellValue; s?: Cell['s']; e?: RegExp } | { rejected: RegExp };
const cases: Array<[string, Column, Cell, CellSource, Expected]> = [
	// Values that fit are normalized the same way for every source.
	['edit normalizes a website', website, done('https://www.Example.com/about'), 'edit', { v: 'example.com', s: 'done' }],
	['agent normalizes an amount', currency, done('$1,200'), 'agent', { v: 1200 }],
	['import normalizes a checkbox', checkbox, done('TRUE'), 'import', { v: true }],
	['an empty category takes the first option', category, { v: null, s: 'idle', t: 5 }, 'edit', { v: 'New', s: 'done' }],
	['untyped columns keep any value', column(undefined), done('n/a'), 'edit', { v: 'n/a' }],
	// A value that does not fit: each source's policy.
	['edit refuses', website, done('n/a'), 'edit', { rejected: /valid website/ }],
	['agent refuses, naming the value', website, done('n/a'), 'agent', { rejected: /“n\/a” is not a website/ }],
	['agent lists the categories', category, done('Lost'), 'agent', { rejected: /Use one of: New, Done/ }],
	['import keeps the text as an error', website, done('n/a'), 'import', { v: 'n/a', s: 'error', e: /“n\/a” is not a website\. Edit it/ }],
	['find-rows drops the value', currency, done('Undisclosed'), 'find-rows', { v: null, s: 'idle' }],
	['enrichment fails the cell', aiWebsite, done('N/A'), 'enrichment', { v: null, s: 'error', e: /The answer “N\/A” is not a website/ }],
	['formula keeps the formula as an error', currency, { ...done('abc'), f: '=A1' }, 'formula', { v: null, s: 'error', e: /The result “abc” is not an amount/ }],
	// Placeholders from providers mean no answer; templates are literal.
	['enrichment placeholder is empty', aiText, done(' — '), 'enrichment', { v: null, s: 'done' }],
	['enrichment placeholder fits a typed column', aiWebsite, done('null'), 'enrichment', { v: null, s: 'done' }],
	['template text stays literal', template, done('-'), 'enrichment', { v: '-' }],
	['edits keep placeholders literal', aiText, done('-'), 'edit', { v: '-' }],
	// Cells without a value of their own are stored as given.
	['a pending cell is exempt', website, { v: 'n/a', s: 'running', t: 5 }, 'enrichment', { v: 'n/a', s: 'running' }],
	['a failed cell is exempt', website, { v: null, s: 'error', e: 'Timed out', t: 5 }, 'edit', { v: null, s: 'error', e: /Timed out/ }],
	['a formula waits for its result', website, { ...done('n/a'), f: '=A1' }, 'edit', { v: 'n/a', s: 'done' }],
];

for (const [name, target, cell, source, expected] of cases) test(`admission: ${name}`, () => {
	const admission = admitCell(target, cell, source);
	if ('rejected' in expected) {
		assert.equal(admission.ok, false);
		if (!admission.ok) assert.match(admission.error, expected.rejected);
		return;
	}
	assert.equal(admission.ok, true);
	if (!admission.ok) return;
	assert.deepEqual(admission.cell.v, expected.v);
	if (expected.s) assert.equal(admission.cell.s, expected.s);
	if (expected.e) assert.match(admission.cell.e ?? '', expected.e);
	assert.deepEqual(admitCell(target, admission.cell, source), { ok: true, cell: admission.cell }, 'admitting an admitted cell changes nothing');
});

test('a guessed format gives way to imported values that do not fit it', () => {
	const guessed = column('website', { name: 'Domain' });
	assert.equal(fitGuessedFormat(guessed, ['acme.com', undefined, null]).format, 'website');
	assert.equal(fitGuessedFormat(guessed, ['acme.com', 'n/a']).format, 'text');
	assert.equal(fitGuessedFormat(column(undefined), ['n/a']).format, undefined);
});

test('a grid change admits only what it wrote, and every cell of a redefined column', () => {
	const sites = column('website', { id: 'site', name: 'Website' });
	const row = (id: string, cells: Record<string, Cell>) => ({ id, sheetId: 's', order: 0, createdAt: 1, cells });
	// A value stored before admission existed (say, by an older MCP client).
	const before = { columns: [sites], rows: [row('legacy', { site: done('n/a') }), row('ok', { site: done('acme.com') })] };
	const edited = structuredClone(before);
	edited.rows[1].cells.site = done('https://www.orbit.example/');
	admitChange(before, edited, 'edit');
	assert.equal(edited.rows[1].cells.site.v, 'orbit.example');
	assert.equal(edited.rows[0].cells.site.v, 'n/a', 'unchanged legacy values are not rechecked');
	assert.equal(invalidCell(before, edited), null);

	const refused = structuredClone(before);
	refused.rows[1].cells.site = done('also n/a');
	assert.throws(() => admitChange(before, refused, 'edit'), /“Website”: Enter a valid website/);
	assert.match(invalidCell(before, refused) ?? '', /Row “ok”, column “Website”: “also n\/a” does not fit/);

	// A format change rechecks everything and refuses rather than rewriting values.
	const redefined = { columns: [{ ...sites, format: 'webpage' as const }], rows: structuredClone(before.rows) };
	assert.deepEqual([...redefinedColumns(before.columns, redefined.columns)], ['site']);
	assert.throws(() => admitChange(before, redefined, 'edit'), /Existing values were kept/);
	assert.match(invalidCell(before, redefined) ?? '', /Row “legacy”/);
});

test('imported text kept as an error fits again once the format allows it', () => {
	const typed = column('currency', { id: 'cost', name: 'Cost' });
	const flagged = admitCell(typed, done('TBD'), 'import');
	assert.ok(flagged.ok && flagged.cell.s === 'error');
	const before = { columns: [typed], rows: [{ id: 'r', sheetId: 's', order: 0, createdAt: 1, cells: { cost: flagged.ok ? flagged.cell : done(null) } }] };
	const asText = { columns: [{ ...typed, format: 'category' as const, categoryOptions: ['TBD', 'Paid'] }], rows: structuredClone(before.rows) };
	admitChange(before, asText, 'edit');
	assert.equal(asText.rows[0].cells.cost.v, 'TBD');
	assert.equal(asText.rows[0].cells.cost.s, 'done');
	const stillWrong = { columns: [{ ...typed, format: 'percent' as const }], rows: structuredClone(before.rows) };
	admitChange(before, stillWrong, 'edit');
	assert.equal(stillWrong.rows[0].cells.cost.s, 'error', 'a value that still does not fit stays flagged instead of refusing the change');
});
