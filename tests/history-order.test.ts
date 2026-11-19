import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { appendRows, connectWorkspace, createSheet, db, redoSheet, setCell, sourceCell, undoSheet } from '../src/lib/db';
import { MemoryRemote } from './support/memory-remote';

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('repeated middle-row insertion undo and redo restores unique ordering without reverting background cells', async () => {
	const sheet = await createSheet('Row ordering');
	await appendRows(sheet.id, [{ Value: 'A' }, { Value: 'B' }]);
	const column = (await db.sheets.get(sheet.id))!.columns.find((entry) => entry.name === 'Value')!;
	const rows = () => db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	const [a, b] = await rows();
	await appendRows(sheet.id, [{ Value: 'X' }], { afterRowId: a.id });
	await appendRows(sheet.id, [{ Value: 'Y' }], { afterRowId: a.id });
	await setCell(b.id, column.id, sourceCell('B updated'), { history: false });
	await appendRows(sheet.id, [{ Value: 'Background' }], { history: false });
	await undoSheet(sheet.id);
	await undoSheet(sheet.id);
	assert.deepEqual((await rows()).map((row) => row.cells[column.id].v), ['A', 'B updated', 'Background']);
	await redoSheet(sheet.id);
	await redoSheet(sheet.id);
	const restored = await rows();
	assert.deepEqual(restored.map((row) => row.cells[column.id].v), ['A', 'Y', 'X', 'B updated', 'Background']);
	assert.equal(new Set(restored.map((row) => row.order)).size, restored.length);
});

test('undo and redo retain a background insertion at its anchor with unique row positions', async () => {
	const sheet = await createSheet('Background insertion');
	await appendRows(sheet.id, [{ Value: 'A' }, { Value: 'B' }]);
	const column = (await db.sheets.get(sheet.id))!.columns.find((entry) => entry.name === 'Value')!;
	const rows = () => db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	const [a] = await rows();
	await appendRows(sheet.id, [{ Value: 'X' }], { afterRowId: a.id });
	await appendRows(sheet.id, [{ Value: 'Y' }], { afterRowId: a.id, history: false });
	await undoSheet(sheet.id);
	let restored = await rows();
	assert.deepEqual(restored.map((row) => row.cells[column.id].v), ['A', 'Y', 'B']);
	assert.equal(new Set(restored.map((row) => row.order)).size, restored.length);
	await redoSheet(sheet.id);
	restored = await rows();
	assert.deepEqual(restored.map((row) => row.cells[column.id].v), ['A', 'Y', 'X', 'B']);
	assert.equal(new Set(restored.map((row) => row.order)).size, restored.length);
});
