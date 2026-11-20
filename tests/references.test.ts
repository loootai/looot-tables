import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROKEN_REFERENCE, danglingReferences, nameTaken, opDependencies, referenceDependents, referenceTokens, renameOpReferences, shiftColumnReferences, shiftReferences, uniqueName } from '../src/lib/references';
import type { Column, ColumnOp } from '../src/lib/types';

const column = (id: string, name = id, op?: ColumnOp): Column => ({ id, name, type: op ? 'enriched' : 'source', op, width: 160, createdAt: 0 });
const template = (text: string): ColumnOp => ({ kind: 'template', template: text });
const text = (op: ColumnOp) => (op as { template: string }).template;
const [a, b, c] = [column('a', 'Name'), column('b', 'Domain'), column('c', 'Notes')];
const sheet = [a, b, c];
const without = (id: string) => sheet.filter((entry) => entry.id !== id);
const move = (id: string, to: number) => { const rest = without(id); rest.splice(to, 0, sheet.find((entry) => entry.id === id)!); return rest; };

test('tokens report names and positions for editors', () => {
	assert.deepEqual(referenceTokens('Hi {{ Name }}, see {{B1:C2}}'), [{ name: 'Name', from: 3, to: 13 }, { name: 'B1:C2', from: 19, to: 28 }]);
	assert.deepEqual(referenceTokens('{{}} and {Name}'), []);
});

test('renames rewrite every reference to the column, whatever its spelling, and nothing else', () => {
	const cases: Array<[ColumnOp, ColumnOp]> = [
		[template('{{Domain}} {{ domain }} {{Domain suffix}} {{B1}}'), template('{{Website}} {{Website}} {{Domain suffix}} {{B1}}')],
		[{ kind: 'scrape', page: { type: 'column', column: ' domain' }, mode: 'extract', fields: [{ name: 'Domain' }], maxChars: 2000 }, { kind: 'scrape', page: { type: 'column', column: 'Website' }, mode: 'extract', fields: [{ name: 'Domain' }], maxChars: 2000 }],
		[{ kind: 'check', question: 'Is {{Domain}} live?', literal: '{{Domain}}', decider: 'jev', threshold: 0.5 }, { kind: 'check', question: 'Is {{Website}} live?', literal: '{{Domain}}', decider: 'jev', threshold: 0.5 }],
	];
	for (const [before, after] of cases) assert.deepEqual(renameOpReferences(before, 'Domain', 'Website'), after);
	const untouched = template('{{Name}}');
	assert.equal(renameOpReferences(untouched, 'Domain', 'Website'), untouched, 'unchanged definitions keep their identity');
});

test('cell references follow their columns when columns are inserted, moved or deleted', () => {
	const inserted = [column('x'), ...sheet];
	const appended = [...sheet, column('x')];
	const cases: Array<{ name: string; after: Column[]; from: string; to: string }> = [
		{ name: 'insert before', after: inserted, from: '{{A1}} {{$C$2}} {{a1:c3}}', to: '{{B1}} {{$D$2}} {{B1:D3}}' },
		{ name: 'insert inside a range widens it', after: [a, column('x'), b, c], from: '{{A1:B1}} {{B1}}', to: '{{A1:C1}} {{C1}}' },
		{ name: 'append leaves cells in place', after: appended, from: '{{a1}} {{$C1:A$2}}', to: '{{a1}} {{$C1:A$2}}' },
		{ name: 'past the last column shifts like a column', after: inserted, from: '{{E1}}', to: '{{F1}}' },
		{ name: 'move', after: move('a', 2), from: '{{A1}} {{B1}} {{C$1}}', to: '{{C1}} {{A1}} {{B$1}}' },
		{ name: 'delete before', after: without('a'), from: '{{B1}} {{$C$1}} {{B1:C1}}', to: '{{A1}} {{$B$1}} {{A1:B1}}' },
		{ name: 'delete the cell', after: without('b'), from: '{{B1}} {{B1:B9}}', to: `{{${BROKEN_REFERENCE}}} {{${BROKEN_REFERENCE}}}` },
		{ name: 'delete a range edge shrinks it', after: without('c'), from: '{{A1:C1}} {{C2:B2}} {{$C$1:A1}}', to: '{{A1:B1}} {{B2:B2}} {{$B$1:A1}}' },
		{ name: 'delete inside a range', after: without('b'), from: '{{A1:C1}}', to: '{{A1:B1}}' },
		{ name: 'named references never move', after: without('a'), from: '{{Domain}} {{Name}}', to: '{{Domain}} {{Name}}' },
	];
	for (const { name, after, from, to } of cases) assert.equal(text(shiftReferences(template(from), sheet, after)), to, name);
	const named = [column('a', 'A1'), b];
	assert.equal(text(shiftReferences(template('{{A1}}'), named, [b, named[0]])), '{{A1}}', 'a column named like a cell is a name');
	const page: ColumnOp = { kind: 'scrape', page: { type: 'column', column: 'B1' }, mode: 'url', maxChars: 2000 };
	assert.deepEqual(shiftReferences(page, sheet, inserted), { ...page, page: { type: 'column', column: 'C1' } });
});

test('every operation in a layout is shifted, and an unchanged layout is returned as is', () => {
	const reader = column('r', 'Reader', template('{{B1}} {{Domain}}'));
	const before = [...sheet, reader];
	const same = [...before];
	assert.equal(shiftColumnReferences(before, same), same);
	const after = shiftColumnReferences(before, [b, a, c, reader]);
	assert.equal(text(after[3].op!), '{{A1}} {{Domain}}');
	assert.equal(after[0], b, 'columns without operations are reused');
	const created = column('n', 'New', template('{{C1}}'));
	assert.equal(text(shiftColumnReferences(sheet, [created, ...sheet])[0].op!), '{{D1}}', 'a new column’s references were written against the old layout');
});

test('dangling references are the ones that resolve to no column', () => {
	const cases: Array<[string, string[]]> = [
		['{{Name}} {{ domain }} {{A1}} {{$C$1:C9}}', []],
		['{{Deleted}} {{D1}} {{#REF!}}', ['Deleted', 'D1', '#REF!']],
		['{{B1:Z1}}', []],
		['{{D1:Z1}}', ['D1:Z1']],
	];
	for (const [from, dangling] of cases) assert.deepEqual(danglingReferences(template(from), sheet), dangling, from);
});

test('dependents are the operations that read a column by name or through a cell range', () => {
	const byName = column('n', 'Greeting', template('Hi {{name}}'));
	const byRange = column('r', 'Summary', { kind: 'ai', prompt: 'Summarize {{A1:B1}}', output: 'text', research: 'none' });
	const byPage = column('p', 'Page', { kind: 'scrape', page: { type: 'homepage', column: 'Domain' }, mode: 'url', maxChars: 2000 });
	const columns = [...sheet, byName, byRange, byPage];
	const dependents = (id: string) => referenceDependents(columns, id).map((entry) => entry.name);
	assert.deepEqual(dependents('a'), ['Greeting', 'Summary']);
	assert.deepEqual(dependents('b'), ['Summary', 'Page']);
	assert.deepEqual(dependents('c'), []);
	assert.deepEqual(dependents('missing'), []);
});

test('names compare trimmed and case-insensitively, and new names never collide', () => {
	assert.equal(uniqueName(' Notes ', ['notes', 'Notes 2']), 'Notes 3');
	assert.equal(uniqueName('Score', ['Scores']), 'Score');
	assert.equal(nameTaken('domain ', sheet), true);
	assert.equal(nameTaken('Domain', sheet, 'b'), false, 'a column may keep its own name');
	assert.deepEqual(opDependencies({ kind: 'search', query: '{{ Domain }} and {{Domain}}', pick: 'url', numResults: 3 }), ['Domain']);
});
