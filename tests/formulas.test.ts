import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { initSync } from '@ironcalc/wasm';
import { calculateFormulas, type FormulaGrid } from '../src/lib/formulas';
import { cellFromInput, cellInput, columnAddress } from '../src/lib/formula-input';
import type { Cell, Column, Row } from '../src/lib/types';

const require = createRequire(`${process.cwd()}/package.json`);
initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) });
const cell = (v: Cell['v']): Cell => ({ v, s: 'done', t: 0 });
const formula = (f: string): Cell => ({ ...cell(null), f });
const columns: Column[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, type: 'source', width: 180, createdAt: 0 }));
const row = (id: string, cells: Row['cells'], order = 0): Row => ({ id, cells, sheetId: 's', order, createdAt: 0 });
const result = (grid: FormulaGrid, next?: FormulaGrid) => Object.fromEntries(calculateFormulas({ grid, next }).map((r) => [`${r.rowId}:${r.columnId}`, r.cell]));

test('sums ranges and recalculates formula chains when source or enrichment values change', () => {
	const grid = { columns, rows: [row('r1', { a: cell(10), b: formula('=SUM(A1:A2)'), c: formula('=B1*2'), d: formula('=IF(C1>50,"High","Low")') }), row('r2', { a: cell(20) }, 1)] };
	assert.equal(result(grid)['r1:b'].v, 30);
	assert.equal(result(grid)['r1:c'].v, 60);
	assert.equal(result(grid)['r1:d'].v, 'High');
	grid.rows[1].cells.a = cell(5);
	assert.equal(result(grid)['r1:c'].v, 30);
	assert.equal(result(grid)['r1:d'].v, 'Low');
});

test('preserves numeric precision, booleans, blanks, and literal text', () => {
	const grid = { columns, rows: [row('r', { a: formula('=1/3'), b: formula('=1E-20'), c: formula('=TRUE()'), d: formula('="=literal"') })] };
	const values = result(grid);
	assert.ok(Math.abs(Number(values['r:a'].v) - 1 / 3) < 1e-16);
	assert.equal(values['r:b'].v, 1e-20);
	assert.equal(values['r:c'].v, true);
	assert.equal(values['r:d'].v, '=literal');
	assert.equal(result({ columns, rows: [row('r', { a: cell('=1+2'), b: formula('=A1'), c: formula('=SUM(D1:D10)') })] })['r:b'].v, '=1+2');
	assert.equal(result({ columns, rows: [row('r', { a: cell('001'), b: formula('=A1') })] })['r:b'].v, '001');
});

test('reports formula errors and circular dependencies without throwing', () => {
	const values = result({ columns, rows: [row('r', { a: formula('=1/0'), b: formula('=C1'), c: formula('=B1'), d: formula('=NOT_A_FUNCTION(1)') })] });
	assert.equal(values['r:a'].e, '#DIV/0!');
	assert.equal(values['r:b'].s, 'error');
	assert.equal(values['r:c'].s, 'error');
	assert.equal(values['r:d'].s, 'error');
});

test('rewrites references when inserting, moving, and deleting columns', () => {
	const grid = { columns: columns.slice(0, 3), rows: [row('r', { a: cell(10), b: cell(20), c: formula('=$A$1+B1') })] };
	const added: Column = { ...columns[3], id: 'new' };
	let values = result(grid, { columns: [added, ...grid.columns], rows: grid.rows });
	assert.equal(values['r:c'].f, '=$B$1+C1');
	assert.equal(values['r:c'].v, 30);
	values = result(grid, { columns: [columns[1], columns[0], columns[2]], rows: grid.rows });
	assert.equal(values['r:c'].f, '=$B$1+A1');
	assert.equal(values['r:c'].v, 30);
	values = result(grid, { columns: [columns[1], columns[2]], rows: grid.rows });
	assert.equal(values['r:c'].s, 'error');
	assert.match(values['r:c'].f!, /#REF!/);
});

test('deleting a row shrinks ranges and updates surviving formula addresses', () => {
	const grid = { columns, rows: [row('r1', { a: cell(10) }), row('r2', { a: cell(20) }, 1), row('r3', { b: formula('=SUM(A1:A2)'), c: formula('=A2') }, 2)] };
	const values = result(grid, { columns, rows: grid.rows.slice(1) });
	assert.equal(values['r3:b'].v, 20);
	assert.equal(values['r3:c'].f, '=A1');
	assert.equal(values['r3:c'].v, 20);
});

test('hidden columns remain addressable; display sorting does not change the calculation grid', () => {
	const grid = { columns: columns.map((c, i) => ({ ...c, hidden: i === 0 })), rows: [row('r1', { a: cell(12), b: formula('=A2') }), row('r2', { a: cell(34) }, 1)] };
	assert.equal(result(grid)['r1:b'].v, 34);
});

test('cell input preserves formulas and supports numbers, clearing, and escaped literals', () => {
	assert.equal(cellFromInput(' =SUM(A1:A3) ', {}).f, '=SUM(A1:A3)');
	assert.equal(cellFromInput('42', {}).v, 42);
	assert.equal(cellFromInput('00123', {}).v, '00123');
	assert.equal(cellFromInput("'=1+2", {}).v, '=1+2');
	assert.equal(cellInput(cellFromInput("'=1+2", {})), "'=1+2");
	assert.equal(cellFromInput('', {}).v, null);
	assert.equal(cellFromInput('false', { format: 'boolean' }).v, false);
	assert.equal(cellInput(formula('=A1*2')), '=A1*2');
	assert.equal(columnAddress(26), 'AA');
});

test('fill copies formulas with relative, absolute, mixed references and ranges in every direction', () => {
	const grid = { columns, rows: [row('r1', { a: cell(10) }), row('r2', { a: cell(20), b: formula('=A2+$A$1+A$1+$A2+SUM(A1:A2)+IF(TRUE,"A2","")') }, 1), row('r3', { a: cell(30) }, 2)] };
	const copies = ['r1', 'r3'].map((rowId) => ({ source: { rowId: 'r2', columnId: 'b' }, target: { rowId, columnId: 'b' } }));
	copies.push({ source: { rowId: 'r2', columnId: 'b' }, target: { rowId: 'r2', columnId: 'c' } });
	copies.push({ source: { rowId: 'r2', columnId: 'b' }, target: { rowId: 'r2', columnId: 'a' } });
	const results = Object.fromEntries(calculateFormulas({ grid, copies }).map((entry) => [`${entry.rowId}:${entry.columnId}`, entry.cell]));
	assert.equal(results['r3:b'].f, '=A3+$A$1+A$1+$A3+SUM(A2:A3)+IF(TRUE,"A2","")');
	assert.equal(results['r2:c'].f, '=B2+$A$1+B$1+$A2+SUM(B1:B2)+IF(TRUE,"A2","")');
	assert.match(results['r1:b'].f!, /#REF!/);
	assert.match(results['r2:a'].f!, /^=#REF!\+\$A\$1/);
	assert.equal(grid.rows[1].cells.b.f, '=A2+$A$1+A$1+$A2+SUM(A1:A2)+IF(TRUE,"A2","")');
});
