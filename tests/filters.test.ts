import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyFilters, applySort, nextSort } from '../src/lib/filters';
import { saveSheetView, sheetView, storedSheetView } from '../src/lib/sheet-view';
import type { Column, Filter, Row, Sort } from '../src/lib/types';

const columns: Column[] = [
	{ id: 'n', name: 'Name', type: 'source', width: 100, createdAt: 0 },
	{ id: 'e', name: 'Employees', type: 'source', width: 100, createdAt: 0, format: 'number' },
	{ id: 'f', name: 'Free', type: 'enriched', width: 100, createdAt: 0 },
];
const row = (id: string, name: string | null, employees: number | null, free: boolean | null, status: 'done' | 'error' = 'done'): Row => ({ id, sheetId: 's', order: Number(id), createdAt: 0, cells: { n: { v: name, s: 'done', t: 0 }, e: { v: employees, s: 'done', t: 0 }, f: { v: free, s: status, t: 0, e: status === 'error' ? 'boom' : undefined } } });
const rows = [row('1', 'Sunrun', 12000, true), row('2', 'Enphase', 3100, false), row('3', 'Aurora', null, null, 'error'), row('4', null, 50, true)];

test('applyFilters supports text, boolean, numeric, empty and error operators', () => {
	assert.deepEqual(applyFilters(rows, [{ id: 'a', columnId: 'n', op: 'contains', value: 'sun' }], '', columns).map((r) => r.id), ['1']);
	assert.deepEqual(applyFilters(rows, [{ id: 'a', columnId: 'f', op: 'true' }], '', columns).map((r) => r.id), ['1', '4']);
	assert.deepEqual(applyFilters(rows, [{ id: 'a', columnId: 'e', op: 'gt', value: '100' }], '', columns).map((r) => r.id), ['1', '2']);
	assert.deepEqual(applyFilters(rows, [{ id: 'a', columnId: 'e', op: 'empty' }], '', columns).map((r) => r.id), ['3']);
	assert.deepEqual(applyFilters(rows, [{ id: 'a', columnId: 'f', op: 'error' }], '', columns).map((r) => r.id), ['3']);
	assert.deepEqual(applyFilters(rows, [{ id: 'a', columnId: 'n', op: 'contains', value: '' }], 'enph', columns).map((r) => r.id), ['2']);
});

test('applySort orders numbers, strings and booleans with empties last', () => {
	assert.deepEqual(applySort(rows, { columnId: 'e', dir: 'asc' }).map((r) => r.id), ['4', '2', '1', '3']);
	assert.deepEqual(applySort(rows, { columnId: 'e', dir: 'desc' }).map((r) => r.id), ['1', '2', '4', '3']);
	assert.deepEqual(applySort(rows, { columnId: 'n', dir: 'asc' }).map((r) => r.id), ['3', '2', '1', '4']);
	assert.deepEqual(applySort(rows, { columnId: 'f', dir: 'desc' }).map((r) => r.id), ['1', '4', '2', '3']);
});

test('numeric filters exclude missing values and preserve legitimate zero values', () => {
	const values = [null, '', '  ', undefined, 0, '0', 5, 100, 'invalid'];
	const candidates: Row[] = values.map((value, index): Row => ({ id: String(index), sheetId: 's', order: index, createdAt: 0, cells: value === undefined ? {} : { e: { v: value, s: 'done', t: 0 } } }));
	assert.deepEqual(applyFilters(candidates, [{ id: 'a', columnId: 'e', op: 'lt', value: '10' }], '', columns).map((r) => r.id), ['4', '5', '6']);
	assert.deepEqual(applyFilters(candidates, [{ id: 'a', columnId: 'e', op: 'gt', value: '-1' }], '', columns).map((r) => r.id), ['4', '5', '6', '7']);
});

test('one sort policy: a header click cycles a column, a menu direction sets it or clears it', () => {
	const by = (columnId: string, dir: Sort['dir']): Sort => ({ columnId, dir });
	assert.deepEqual([nextSort(null, 'n'), nextSort(by('n', 'asc'), 'n'), nextSort(by('n', 'desc'), 'n'), nextSort(by('n', 'desc'), 'e')], [by('n', 'asc'), by('n', 'desc'), null, by('e', 'asc')]);
	assert.deepEqual([nextSort(null, 'n', 'desc'), nextSort(by('n', 'asc'), 'n', 'desc'), nextSort(by('n', 'desc'), 'n', 'desc'), nextSort(by('e', 'desc'), 'n', 'desc')], [by('n', 'desc'), by('n', 'desc'), null, by('n', 'desc')]);
});

test('a viewer’s view starts as the sheet’s saved one, never changes it, and drops deleted columns', () => {
	const saved: Filter[] = [{ id: 'f', columnId: 'n', op: 'contains', value: 'sun' }];
	const sheet = { id: 'viewed', columns, filters: saved, sort: { columnId: 'e', dir: 'asc' } as Sort };
	assert.deepEqual(sheetView(storedSheetView(sheet.id), sheet), { filters: saved, sort: sheet.sort });
	saveSheetView(sheet.id, { filters: [], sort: { columnId: 'n', dir: 'desc' } });
	assert.deepEqual(sheetView(storedSheetView(sheet.id), sheet), { filters: [], sort: { columnId: 'n', dir: 'desc' } });
	assert.deepEqual(sheetView(storedSheetView('another'), sheet).filters, saved, 'views are per sheet');
	assert.deepEqual(sheetView(storedSheetView(sheet.id), { ...sheet, columns: columns.filter((column) => column.id !== 'n') }), { filters: [], sort: null });
	assert.deepEqual(sheetView(JSON.stringify({ filters: saved, sort: { columnId: 'gone', dir: 'asc' } }), sheet), { filters: saved, sort: null });
	assert.deepEqual(sheetView('{"filters":', sheet), { filters: saved, sort: sheet.sort }, 'a damaged entry falls back to the saved view');
});
