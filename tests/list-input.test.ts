import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampNumber, fromListRows, parseCommaList, parseListLines, toListRows, type ListRow } from '../src/lib/list-input';

let id = 0;
const makeId = () => `row-${++id}`;
// Typing goes into the rows; the saved list is derived and never fed back, so keystrokes survive.
const type = (rows: ListRow[], index: number, text: string, field: 'label' | 'detail' = 'label') => rows.map((row, position) => position === index ? { ...row, [field]: row[field] + text } : row);

test('list rows keep what the user is typing: Enter adds a blank row, a trailing colon stays', () => {
	let rows = toListRows([{ label: 'Strong fit', detail: 'B2B SaaS' }], makeId);
	rows = type(rows, 0, ':');
	assert.equal(rows[0].label, 'Strong fit:', 'the colon is still in the input');
	rows = [...rows, ...toListRows([{ label: '' }], makeId)]; // Enter
	assert.equal(rows.length, 2, 'the new line survives even while blank');
	assert.deepEqual(fromListRows(rows), [{ label: 'Strong fit:', detail: 'B2B SaaS' }], 'blank rows are only dropped from the saved value');
	rows = type(rows, 1, 'Weak fit ');
	rows = type(rows, 1, ' agencies: or consumer', 'detail');
	assert.deepEqual(fromListRows(rows), [{ label: 'Strong fit:', detail: 'B2B SaaS' }, { label: 'Weak fit', detail: 'agencies: or consumer' }]);
	assert.equal(rows[1].label, 'Weak fit ', 'trailing spaces are kept while typing');
});

test('pasting several lines fills rows and round-trips labels and descriptions', () => {
	assert.equal(parseListLines('Just one line: here', true), null, 'a single line pastes normally');
	const pasted = parseListLines('Strong fit: B2B SaaS: 50-500 employees\r\nWeak fit:\n\n  Unknown  ', true)!;
	assert.deepEqual(pasted, [{ label: 'Strong fit', detail: 'B2B SaaS: 50-500 employees' }, { label: 'Weak fit', detail: undefined }, { label: 'Unknown' }]);
	assert.deepEqual(fromListRows(toListRows(pasted, makeId)), [{ label: 'Strong fit', detail: 'B2B SaaS: 50-500 employees' }, { label: 'Weak fit', detail: undefined }, { label: 'Unknown', detail: undefined }]);
	assert.deepEqual(parseListLines('Tier: 1\nTier: 2', false), [{ label: 'Tier: 1' }, { label: 'Tier: 2' }], 'levels keep colons');
});

test('comma lists parse without eating the comma being typed', () => {
	assert.deepEqual(parseCommaList('linkedin.com,'), ['linkedin.com']);
	assert.deepEqual(parseCommaList('linkedin.com, crunchbase.com ,, linkedin.com\nexample.com'), ['linkedin.com', 'crunchbase.com', 'example.com']);
	assert.deepEqual(parseCommaList(' , '), []);
});

test('number fields fall back instead of snapping to a default, and clamp on commit', () => {
	assert.equal(clampNumber('', { min: 1, max: 10, fallback: 7, integer: true }), 7, 'cleared keeps the last value');
	assert.equal(clampNumber('abc', { min: 1, max: 10, fallback: 3 }), 3);
	assert.equal(clampNumber('25', { min: 1, max: 10, fallback: 3, integer: true }), 10);
	assert.equal(clampNumber('0', { min: 0.05, max: 0.95, fallback: 0.5 }), 0.05, 'zero no longer becomes an invalid threshold');
	assert.equal(clampNumber('4.6', { min: 1, max: 10, fallback: 3, integer: true }), 5);
	assert.equal(clampNumber('0.7', { min: 0.05, max: 0.95, fallback: 0.5 }), 0.7);
});
