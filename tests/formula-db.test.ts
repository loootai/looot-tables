import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, test } from 'node:test';
import { initSync } from '@ironcalc/wasm';
import { calculateFormulas, type FormulaRequest } from '../src/lib/formulas';
import { sheetHistory } from '../src/lib/sheet-history';
import { cellFromInput } from '../src/lib/formula-input';
import { addColumns, addEmptyRow, appendRows, connectWorkspace, createSheet, db, deleteColumn, deleteSheet, deleteRows, loadSheet, moveColumn, newColumn, recalculateSheet, setCell, sourceCell, setCells, undoSheet, redoSheet, updateColumn, updateSheet } from '../src/lib/db';
import { MemoryRemote } from './support/memory-remote';

const require = createRequire(`${process.cwd()}/package.json`);
initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) });
// Browser-worker transport shim; runs the real WASM calculation asynchronously.
let failNextCalculation = false;
class TestWorker {
	onmessage?: (event: { data: unknown }) => void;
	terminate() {}
	postMessage(request: FormulaRequest & { id: number }) {
		setTimeout(() => {
			if (failNextCalculation) { failNextCalculation = false; this.onmessage?.({ data: { id: request.id, error: 'Test calculation failure' } }); return; }
			try { this.onmessage?.({ data: { id: request.id, results: calculateFormulas(request) } }); }
			catch (error) { this.onmessage?.({ data: { id: request.id, error: String(error) } }); }
		}, 0);
	}
}
Object.assign(globalThis, { Worker: TestWorker });

// Each test starts in an empty workspace.
let remote = new MemoryRemote();
beforeEach(() => connectWorkspace(remote = new MemoryRemote()));

test('recalculating a formula loaded with server key order does not write unchanged rows', async () => {
	const column = newColumn({ name: 'Result', type: 'source' });
	const sheet = await createSheet('Server formula roundtrip', [column]);
	let writes = 0;
	const onUpdate = () => { writes++; };
	try {
		const row = await addEmptyRow(sheet.id);
		await setCell(row.id, column.id, cellFromInput('=1+1', column));
		// JSONB/schema parsing can reorder keys and omit undefined fields.
		remote.edit(sheet.id, (grid) => { const { f, v, s, t } = grid.rows[0].cells[column.id]; grid.rows[0].cells[column.id] = { v, s, t, f }; });
		await loadSheet(sheet.id);
		const saves = remote.calls.length;
		db.rows.hook('updating', onUpdate);
		await recalculateSheet(sheet.id);
		await recalculateSheet(sheet.id);
		assert.equal(writes, 0, 'unchanged formulas must not trigger another revision/live update');
		assert.equal(remote.calls.length, saves);
	} finally {
		db.rows.hook('updating').unsubscribe(onUpdate);
	}
});

test('category edits, conversions and formula results enforce the configured options without losing existing values', async () => {
	const column = newColumn({ name: 'Status', type: 'source', format: 'category', categoryOptions: ['New', 'Done'] });
	const sheet = await createSheet('Category DB test', [column]);
	try {
		const row = await addEmptyRow(sheet.id);
		assert.equal((await db.rows.get(row.id))!.cells[column.id].v, 'New');
		await setCell(row.id, column.id, cellFromInput('Done', column));
		await setCell(row.id, column.id, cellFromInput('', column));
		assert.equal((await db.rows.get(row.id))!.cells[column.id].v, 'New');
		await assert.rejects(setCell(row.id, column.id, sourceCell('Unknown')), /configured categories/);
		assert.equal((await db.rows.get(row.id))!.cells[column.id].v, 'New');
		await assert.rejects(updateColumn(sheet.id, column.id, { categoryOptions: ['Done'] }), /Existing values were kept/);
		assert.deepEqual((await db.sheets.get(sheet.id))!.columns[0].categoryOptions, ['New', 'Done']);
		await setCell(row.id, column.id, cellFromInput('="Unknown"', column));
		assert.equal((await db.rows.get(row.id))!.cells[column.id].s, 'error');
		await setCell(row.id, column.id, cellFromInput('="Done"', column));
		assert.equal((await db.rows.get(row.id))!.cells[column.id].v, 'Done');
		await undoSheet(sheet.id);
		assert.equal((await db.rows.get(row.id))!.cells[column.id].s, 'error');
	} finally { await deleteSheet(sheet.id); }
});

test('persists formulas and results, updates on enrichment, and keeps references through structure edits', async () => {
	const a = newColumn({ name: 'Value', type: 'source' });
	const b = newColumn({ name: 'Total', type: 'source' });
	const sheet = await createSheet('Formula DB test', [a, b]);
	try {
		await appendRows(sheet.id, [{ Value: 10 }, { Value: 20 }]);
		const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		await setCell(rows[0].id, b.id, cellFromInput('=SUM(A1:A2)', b));
		assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].v, 30);
		await setCell(rows[1].id, a.id, sourceCell(25));
		assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].v, 35);
		const inserted = newColumn({ name: 'New', type: 'source' });
		await addColumns(sheet.id, [inserted], 0);
		assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].f, '=SUM(B1:B2)');
		await moveColumn(sheet.id, a.id, 0);
		assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].f, '=SUM(A1:A2)');
		await deleteColumn(sheet.id, inserted.id);
		await deleteRows(sheet.id, [rows[1].id]);
		assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].v, 10);
		const again = await db.rows.get(rows[0].id);
		await recalculateSheet(sheet.id);
		assert.deepEqual(await db.rows.get(rows[0].id), again);
		await setCell(rows[0].id, b.id, cellFromInput('7', b));
		assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].f, undefined);
	} finally { await deleteSheet(sheet.id); }
});

test('concurrent edits cannot commit a stale calculation over newer values', async () => {
	const a = newColumn({ name: 'Input', type: 'source' });
	const b = newColumn({ name: 'Result', type: 'source' });
	const sheet = await createSheet('Concurrent formula test', [a, b]);
	try {
		const row = await addEmptyRow(sheet.id);
		await setCell(row.id, b.id, cellFromInput('=A1*2', b));
		await Promise.all([setCell(row.id, a.id, sourceCell(3)), setCell(row.id, a.id, sourceCell(7))]);
		const fresh = await db.rows.get(row.id);
		assert.equal(fresh!.cells[b.id].v, Number(fresh!.cells[a.id].v) * 2);
		assert.equal(fresh!.cells[b.id].f, '=A1*2');
	} finally { await deleteSheet(sheet.id); }
});


test('history is capped at 50 actions per sheet, ignores no-ops and background changes, and resets redo on a new edit', async () => {
	const column = newColumn({ name: 'Value', type: 'source' });
	const first = await createSheet('History A', [column]);
	const second = await createSheet('History B', [column]);
	const row = await addEmptyRow(first.id);
	const other = await addEmptyRow(second.id);
	sheetHistory.clear(first.id);
	sheetHistory.clear(second.id);
	for (let i = 1; i <= 55; i++) await setCell(row.id, column.id, sourceCell(i));
	assert.deepEqual(sheetHistory.getSnapshot(first.id), { undo: 50, redo: 0 });
	assert.deepEqual(sheetHistory.getSnapshot(second.id), { undo: 0, redo: 0 });
	await setCell(row.id, column.id, sourceCell(55));
	assert.equal(sheetHistory.getSnapshot(first.id).undo, 50);
	for (let i = 0; i < 51; i++) await undoSheet(first.id);
	assert.equal((await db.rows.get(row.id))!.cells[column.id].v, 5);
	assert.deepEqual(sheetHistory.getSnapshot(first.id), { undo: 0, redo: 50 });
	await setCell(other.id, column.id, sourceCell(99), { history: false });
	await redoSheet(first.id);
	assert.equal((await db.rows.get(row.id))!.cells[column.id].v, 6);
	assert.equal((await db.rows.get(other.id))!.cells[column.id].v, 99);
	await setCell(row.id, column.id, sourceCell(80));
	assert.equal(sheetHistory.getSnapshot(first.id).redo, 0);
});

test('bulk edits undo as one action and recalculate against the latest unrelated enrichment', async () => {
	const columns = ['Input', 'Enrichment', 'Total'].map((name) => newColumn({ name, type: 'source' }));
	const sheet = await createSheet('History formulas', columns);
	await appendRows(sheet.id, [{ Input: 10 }, { Input: 20 }]);
	const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	await setCell(rows[0].id, columns[2].id, cellFromInput('=SUM(A1:A2)+B1', columns[2]));
	sheetHistory.clear(sheet.id);
	await setCells(rows.map((row) => ({ rowId: row.id, columnId: columns[0].id, cell: sourceCell(null) })));
	await setCell(rows[0].id, columns[1].id, sourceCell(7), { history: false });
	assert.equal(sheetHistory.getSnapshot(sheet.id).undo, 1);
	await undoSheet(sheet.id);
	let fresh = (await db.rows.get(rows[0].id))!;
	assert.equal(fresh.cells[columns[0].id].v, 10);
	assert.equal(fresh.cells[columns[1].id].v, 7);
	assert.equal(fresh.cells[columns[2].id].v, 37);
	await redoSheet(sheet.id);
	fresh = (await db.rows.get(rows[0].id))!;
	assert.equal(fresh.cells[columns[0].id].v, null);
	assert.equal(fresh.cells[columns[2].id].v, 7);
});

test('row and column deletion undo restores values, formulas, filters and sort; redo reapplies deletion', async () => {
	const a = newColumn({ name: 'Input', type: 'source' }), b = newColumn({ name: 'Formula', type: 'source' });
	const sheet = await createSheet('Structural history', [a, b]);
	await appendRows(sheet.id, [{ Input: 10 }, { Input: 20 }]);
	const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	await setCell(rows[0].id, b.id, cellFromInput('=SUM(A1:A2)', b));
	await updateSheet(sheet.id, { filters: [{ id: 'filter', columnId: a.id, op: 'gt', value: '1' }], sort: { columnId: a.id, dir: 'asc' } });
	sheetHistory.clear(sheet.id);
	await deleteRows(sheet.id, [rows[1].id]);
	assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].v, 10);
	await undoSheet(sheet.id);
	assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].f, '=SUM(A1:A2)');
	assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].v, 30);
	await redoSheet(sheet.id);
	assert.equal(await db.rows.get(rows[1].id), undefined);
	await undoSheet(sheet.id);
	await deleteColumn(sheet.id, a.id);
	assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].s, 'error');
	await undoSheet(sheet.id);
	assert.equal((await db.rows.get(rows[0].id))!.cells[b.id].v, 30);
	assert.equal((await db.sheets.get(sheet.id))!.filters.length, 1);
	assert.equal((await db.sheets.get(sheet.id))!.sort?.columnId, a.id);
	await redoSheet(sheet.id);
	assert.equal((await db.sheets.get(sheet.id))!.columns.length, 1);
});

test('column insertion, movement and edits restore formula references without rewriting them twice', async () => {
	const a = newColumn({ name: 'Input', type: 'source' }), b = newColumn({ name: 'Formula', type: 'source' });
	const sheet = await createSheet('Column history', [a, b]);
	await appendRows(sheet.id, [{ Input: 10 }]);
	const row = (await db.rows.where('sheetId').equals(sheet.id).toArray())[0];
	await setCell(row.id, b.id, cellFromInput('=A1*2', b));
	sheetHistory.clear(sheet.id);
	const c = newColumn({ name: 'Inserted', type: 'source' });
	await addColumns(sheet.id, [c], 0);
	assert.equal((await db.rows.get(row.id))!.cells[b.id].f, '=B1*2');
	await undoSheet(sheet.id);
	assert.equal((await db.rows.get(row.id))!.cells[b.id].f, '=A1*2');
	await redoSheet(sheet.id);
	assert.equal((await db.rows.get(row.id))!.cells[b.id].v, 20);
	await moveColumn(sheet.id, a.id, 0);
	await undoSheet(sheet.id);
	assert.equal((await db.rows.get(row.id))!.cells[b.id].f, '=B1*2');
	await updateColumn(sheet.id, a.id, { name: 'Renamed', width: 300 });
	await appendRows(sheet.id, [{ Background: 42 }], { history: false });
	await undoSheet(sheet.id);
	const fresh = (await db.sheets.get(sheet.id))!;
	assert.equal(fresh.columns.find((column) => column.id === a.id)!.name, 'Input');
	assert.equal(fresh.columns.find((column) => column.id === a.id)!.width, a.width);
	assert.ok(fresh.columns.some((column) => column.name === 'Background'));
});

test('imports are one action and concurrent edits and undo preserve action order', async () => {
	const a = newColumn({ name: 'Value', type: 'source' });
	const sheet = await createSheet('Import history', [a]);
	await appendRows(sheet.id, [{ Value: 1, Extra: 'a' }, { Value: 2, Extra: 'b' }]);
	assert.equal(sheetHistory.getSnapshot(sheet.id).undo, 1);
	await undoSheet(sheet.id);
	assert.equal(await db.rows.where('sheetId').equals(sheet.id).count(), 0);
	assert.equal((await db.sheets.get(sheet.id))!.columns.length, 1);
	await redoSheet(sheet.id);
	const row = (await db.rows.where('sheetId').equals(sheet.id).sortBy('order'))[0];
	await Promise.all([setCell(row.id, a.id, sourceCell(3)), setCell(row.id, a.id, sourceCell(7))]);
	await undoSheet(sheet.id);
	assert.equal((await db.rows.get(row.id))!.cells[a.id].v, 3);
	await undoSheet(sheet.id);
	assert.equal((await db.rows.get(row.id))!.cells[a.id].v, 1);
});


test('failed edits and failed undo leave data and history intact so they can be retried', async () => {
	const a = newColumn({ name: 'Input', type: 'source' }), b = newColumn({ name: 'Formula', type: 'source' });
	const sheet = await createSheet('Failure history', [a, b]);
	await appendRows(sheet.id, [{ Input: 10 }]);
	const row = (await db.rows.where('sheetId').equals(sheet.id).toArray())[0];
	await setCell(row.id, b.id, cellFromInput('=A1*2', b));
	sheetHistory.clear(sheet.id);
	failNextCalculation = true;
	await assert.rejects(setCell(row.id, a.id, sourceCell(15)), /Test calculation failure/);
	assert.equal((await db.rows.get(row.id))!.cells[a.id].v, 10);
	assert.equal(sheetHistory.getSnapshot(sheet.id).undo, 0);
	await setCell(row.id, a.id, sourceCell(15));
	failNextCalculation = true;
	await assert.rejects(undoSheet(sheet.id), /Test calculation failure/);
	assert.equal((await db.rows.get(row.id))!.cells[a.id].v, 15);
	assert.deepEqual(sheetHistory.getSnapshot(sheet.id), { undo: 1, redo: 0 });
	await undoSheet(sheet.id);
	assert.equal((await db.rows.get(row.id))!.cells[b.id].v, 20);
});


test('inserts rows below an anchor, preserves formula references, and supports undo and redo', async () => {
	const input = newColumn({ name: 'Input', type: 'source' });
	const total = newColumn({ name: 'Total', type: 'source' });
	const sheet = await createSheet('Insert rows', [input, total]);
	await appendRows(sheet.id, [{ Input: 2 }, { Input: 7 }]);
	const original = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	await setCell(original[1].id, total.id, cellFromInput('=A2*2', total));
	const added = await addEmptyRow(sheet.id, original[0].id);
	const ordered = () => db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	assert.deepEqual((await ordered()).map((row) => row.id), [original[0].id, added.id, original[1].id]);
	assert.equal((await db.rows.get(original[1].id))!.cells[total.id].f, '=A3*2');
	assert.equal((await db.rows.get(original[1].id))!.cells[total.id].v, 14);
	await undoSheet(sheet.id);
	assert.deepEqual((await ordered()).map((row) => row.id), original.map((row) => row.id));
	await redoSheet(sheet.id);
	assert.deepEqual((await ordered()).map((row) => row.id), [original[0].id, added.id, original[1].id]);
	await appendRows(sheet.id, [{ Input: 3 }, { Input: 4 }], { afterRowId: original[0].id });
	assert.deepEqual((await ordered()).map((row) => row.cells[input.id].v), [2, 3, 4, null, 7]);
	await undoSheet(sheet.id);
	assert.deepEqual((await ordered()).map((row) => row.id), [original[0].id, added.id, original[1].id]);
});

test('inserts five blank columns together and restores formulas with one undo', async () => {
	const input = newColumn({ name: 'Input', type: 'source' });
	const total = newColumn({ name: 'Total', type: 'source' });
	const sheet = await createSheet('Bulk blank columns', [input, total]);
	await appendRows(sheet.id, [{ Input: 10 }]);
	const row = (await db.rows.where('sheetId').equals(sheet.id).toArray())[0];
	await setCell(row.id, total.id, cellFromInput('=A1*2', total));
	sheetHistory.clear(sheet.id);
	const added = Array.from({ length: 5 }, (_, index) => newColumn({ name: `Blank ${index + 1}`, type: 'source' }));
	await addColumns(sheet.id, added, 0);
	assert.deepEqual((await db.sheets.get(sheet.id))!.columns.map((column) => column.id), [...added, input, total].map((column) => column.id));
	const updated = (await db.rows.get(row.id))!;
	for (const column of added) assert.equal(updated.cells[column.id].v, null);
	assert.equal(updated.cells[total.id].f, '=F1*2');
	assert.equal(updated.cells[total.id].v, 20);
	assert.equal(sheetHistory.getSnapshot(sheet.id).undo, 1);
	await undoSheet(sheet.id);
	assert.equal((await db.sheets.get(sheet.id))!.columns.length, 2);
	assert.equal((await db.rows.get(row.id))!.cells[total.id].f, '=A1*2');
	await redoSheet(sheet.id);
	assert.equal((await db.sheets.get(sheet.id))!.columns.length, 7);
});

test('column formats convert existing and new values, preserve formulas, and undo atomically', async () => {
	const cost = newColumn({ name: 'Cost', type: 'source' });
	const total = newColumn({ name: 'Total', type: 'source' });
	const checked = newColumn({ name: 'Selected', type: 'source' });
	const sheet = await createSheet('Field formats', [cost, total, checked]);
	try {
		await appendRows(sheet.id, [{ Cost: '$1,234.50', Selected: 'false' }]);
		const row = (await db.rows.where('sheetId').equals(sheet.id).toArray())[0];
		await updateColumn(sheet.id, cost.id, { format: 'currency', currency: 'USD' });
		assert.equal((await db.rows.get(row.id))!.cells[cost.id].v, 1234.5);
		await undoSheet(sheet.id);
		assert.equal((await db.rows.get(row.id))!.cells[cost.id].v, '$1,234.50');
		assert.equal((await db.sheets.get(sheet.id))!.columns[0].format, undefined);
		await redoSheet(sheet.id);
		await updateColumn(sheet.id, checked.id, { format: 'checkbox' });
		assert.equal((await db.rows.get(row.id))!.cells[checked.id].v, false);
		await setCell(row.id, total.id, cellFromInput('=A1*2', total));
		assert.equal((await db.rows.get(row.id))!.cells[total.id].v, 2469);
		await setCell(row.id, cost.id, cellFromInput('$10.25', { format: 'currency' }));
		assert.equal((await db.rows.get(row.id))!.cells[total.id].v, 20.5);
		await appendRows(sheet.id, [{ Cost: '$3.50', Selected: 'true' }]);
		const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		assert.equal(rows[1].cells[cost.id].v, 3.5);
		assert.equal(rows[1].cells[checked.id].v, true);
		// An import keeps the row and flags the values its columns cannot hold.
		await appendRows(sheet.id, [{ Cost: 'not money', Selected: 'yes' }]);
		const imported = (await db.rows.where('sheetId').equals(sheet.id).sortBy('order'))[2];
		assert.deepEqual([imported.cells[cost.id].v, imported.cells[cost.id].s, imported.cells[checked.id].s], ['not money', 'error', 'error']);
		await assert.rejects(updateColumn(sheet.id, cost.id, { format: 'checkbox' }), /Checkbox fields/);
		assert.equal((await db.sheets.get(sheet.id))!.columns[0].format, 'currency');
	} finally { await deleteSheet(sheet.id); }
});

test('adds a formula column atomically, fills relative references, and undoes in one step', async () => {
	const { addFormulaColumn } = await import('../src/lib/db');
	const value = newColumn({ name: 'Value', type: 'source' });
	const column = newColumn({ name: 'Double', type: 'source' });
	const sheet = await createSheet('Formula builder', [value]);
	await appendRows(sheet.id, [{ Value: 10 }, { Value: 20 }]);
	await addFormulaColumn(sheet.id, column, '=A1*2');
	const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	assert.equal(rows[0].cells[column.id].v, 20);
	assert.equal(rows[1].cells[column.id].v, 40);
	assert.equal(rows[1].cells[column.id].f, '=A2*2');
	await undoSheet(sheet.id);
	assert.equal((await db.sheets.get(sheet.id))!.columns.length, 1);
	await redoSheet(sheet.id);
	assert.equal((await db.rows.get(rows[1].id))!.cells[column.id].v, 40);
	const failed = newColumn({ name: 'Failed', type: 'source' });
	failNextCalculation = true;
	await assert.rejects(addFormulaColumn(sheet.id, failed, '=A1+1'), /Test calculation failure/);
	assert.equal((await db.sheets.get(sheet.id))!.columns.length, 2);
});

test('creates a trailing column and its first cell atomically with undo and rollback', async () => {
	const input = newColumn({ name: 'Input', type: 'source' });
	const sheet = await createSheet('Trailing column', [input]);
	try {
		await appendRows(sheet.id, [{ Input: 10 }, { Input: 20 }]);
		const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		const column = newColumn({ name: 'New column', type: 'source' });
		sheetHistory.clear(sheet.id);
		await addColumns(sheet.id, [column], undefined, { rowId: rows[1].id, columnId: column.id, cell: cellFromInput('=A2*2', column) });
		assert.equal((await db.rows.get(rows[1].id))!.cells[column.id].v, 40);
		assert.equal((await db.rows.get(rows[0].id))!.cells[column.id].v, null);
		assert.equal((await db.rows.get(rows[0].id))!.cells[column.id].s, 'idle');
		assert.equal(sheetHistory.getSnapshot(sheet.id).undo, 1);
		await undoSheet(sheet.id);
		assert.equal((await db.sheets.get(sheet.id))!.columns.length, 1);
		await redoSheet(sheet.id);
		assert.equal((await db.rows.get(rows[1].id))!.cells[column.id].v, 40);
		const failed = newColumn({ name: 'Failed', type: 'source' });
		await assert.rejects(addColumns(sheet.id, [failed], undefined, { rowId: 'missing', columnId: failed.id, cell: sourceCell('value') }), /no longer available/);
		failNextCalculation = true;
		await assert.rejects(addColumns(sheet.id, [failed], undefined, { rowId: rows[0].id, columnId: failed.id, cell: cellFromInput('=A1', failed) }), /Test calculation failure/);
		assert.equal((await db.sheets.get(sheet.id))!.columns.length, 2);
		assert.equal((await db.rows.get(rows[0].id))!.cells[failed.id], undefined);
	} finally { await deleteSheet(sheet.id); }
});


test('distinguishes untouched and cleared cells from explicit null results', async () => {
	const column = newColumn({ name: 'Value', type: 'source' });
	const sheet = await createSheet('Empty versus null', [column]);
	try {
		const blank = await addEmptyRow(sheet.id);
		assert.equal((await db.rows.get(blank.id))!.cells[column.id].s, 'idle');
		await appendRows(sheet.id, [{}, { Value: null }]);
		const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		assert.equal(rows[1].cells[column.id].s, 'idle');
		assert.equal(rows[2].cells[column.id].s, 'done');
		assert.equal(rows[2].cells[column.id].v, null);
		await setCell(blank.id, column.id, cellFromInput('null', column));
		assert.equal((await db.rows.get(blank.id))!.cells[column.id].s, 'done');
		await setCell(blank.id, column.id, cellFromInput('', column));
		assert.equal((await db.rows.get(blank.id))!.cells[column.id].s, 'idle');
	} finally { await deleteSheet(sheet.id); }
});
