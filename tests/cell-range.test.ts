import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellRangeBounds, cellRangeReference, cellRangeTsv, cellsInRange } from '../src/lib/cell-range';
import { formulaReferenceTarget } from '../src/lib/formula-reference';
import type { Column, Row } from '../src/lib/types';
const columns: Column[] = ['a', 'b', 'c'].map((id) => ({ id, name: id, type: 'source', width: 180, createdAt: 0 }));
const rows: Row[] = [1, 2, 3].map((number) => ({ id: `r${number}`, sheetId: 's', order: number - 1, createdAt: 0, cells: Object.fromEntries(columns.map((column, index) => [column.id, { v: number * 10 + index, s: 'done', t: 0 }])) }));
const numbers = new Map(rows.map((row, index) => [row.id, index + 1]));
const range = { anchor: { rowId: 'r3', columnId: 'b' }, focus: { rowId: 'r1', columnId: 'a' } };

test('reverse drag produces a normalized rectangle and spreadsheet reference', () => {
	assert.deepEqual(cellRangeBounds(range, rows.map((r) => r.id), columns.map((c) => c.id)), { top: 0, bottom: 2, left: 0, right: 1 });
	assert.equal(cellRangeReference(range, rows, columns, numbers, columns), 'A1:B3');
	assert.equal(cellsInRange(range, rows, columns).length, 6);
	assert.equal(cellRangeTsv(range, rows, columns), '10\t11\n20\t21\n30\t31');
});
test('filtered and hidden selections reference only selected cells at stable sheet addresses', () => {
	assert.equal(cellRangeReference(range, [rows[2], rows[0]], columns, numbers, columns), 'A1:B1,A3:B3');
	const hidden = { anchor: { rowId: 'r1', columnId: 'a' }, focus: { rowId: 'r3', columnId: 'c' } };
	assert.equal(cellRangeReference(hidden, rows, [columns[0], columns[2]], numbers, columns), 'A1:A3,C1:C3');
	assert.equal(cellRangeReference(range, rows.slice(1), columns, numbers, columns), '');
});
test('reference picking inserts into empty arguments and replaces existing references', () => {
	assert.deepEqual(formulaReferenceTarget('=SUM()', 5), { from: 5, to: 5 });
	assert.deepEqual(formulaReferenceTarget('=SUM(', 5), { from: 5, to: 5 });
	assert.deepEqual(formulaReferenceTarget('=IF(A1>5,)', 9), { from: 9, to: 9 });
	assert.deepEqual(formulaReferenceTarget('=SUM($A$1:B2)', 10), { from: 5, to: 12 });
	assert.deepEqual(formulaReferenceTarget('=SUM(A1:)', 8), { from: 5, to: 8 });
	assert.deepEqual(formulaReferenceTarget('=SUM(A1+B2)', 5, 10), { from: 5, to: 10 });
	assert.deepEqual(formulaReferenceTarget('=', 1), { from: 1, to: 1 });
});
test('normal text, quoted strings, function names and completed formulas do not trigger reference picking', () => {
	assert.equal(formulaReferenceTarget('ordinary text (', 15), null);
	assert.equal(formulaReferenceTarget('=SUM("A1")', 7), null);
	assert.equal(formulaReferenceTarget('=IF("a""b",1)', 8), null);
	assert.equal(formulaReferenceTarget('=SUM()', 6), null);
	assert.equal(formulaReferenceTarget('=SUM(LO)', 7), null);
	assert.equal(formulaReferenceTarget('=SUM(LOG10(A1))', 7), null);
});
