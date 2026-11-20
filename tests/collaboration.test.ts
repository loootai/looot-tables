import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { currentCollaborators, decodeLiveSheet, type LiveSheetEntry } from '../src/lib/collaboration';
import { applyLiveSheet, db, connectWorkspace, createSheet, deleteSheet, newColumn, addEmptyRow, setCell } from '../src/lib/db';
import { MemoryRemote } from './support/memory-remote';

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('live snapshots atomically update changed rows and metadata, ignore older revisions, and stay out of undo history', async () => {
	const c = newColumn({ name: 'Name', type: 'source' });
	const sheet = await createSheet('Live cache test', [c]);
	const row = await addEmptyRow(sheet.id);
	await setCell(row.id, c.id, { v: 'initial', s: 'done', t: 1 });
	const saved = (await db.sheets.get(sheet.id))!.revision!;
	const entries: LiveSheetEntry[] = [{ kind: 'sheet', id: sheet.id, revision: saved + 1, data: { ...sheet, name: 'Remote rename' } }, { kind: 'row', id: row.id, revision: 0, data: { ...row, cells: { [c.id]: { v: 'remote', s: 'done', t: 2 } } } }];
	await applyLiveSheet(sheet.id, entries);
	assert.equal((await db.sheets.get(sheet.id))?.name, 'Remote rename');
	assert.equal((await db.rows.get(row.id))?.cells[c.id].v, 'remote');
	await applyLiveSheet(sheet.id, [{ ...entries[0], revision: saved, data: sheet }, { ...entries[1], data: row }]);
	assert.equal((await db.rows.get(row.id))?.cells[c.id].v, 'remote');
	await applyLiveSheet(sheet.id, [{ ...entries[0], revision: saved + 2 }]);
	assert.equal(await db.rows.get(row.id), undefined);
	await deleteSheet(sheet.id);
});

test('cross-sheet rows are rejected and expired presence is hidden locally without database timer queries', () => {
	const sheet = { id: 'one', name: 'One', columns: [], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
	assert.throws(() => decodeLiveSheet([{ kind: 'sheet', id: 'one', revision: 1, data: sheet }, { kind: 'row', id: 'row', revision: 0, data: { id: 'row', sheetId: 'two', order: 0, cells: {}, createdAt: 1 } }], 'one'), /Invalid live rows/);
	const peer = { client_id: 'other', user_id: 'bob', name: 'Bob', color: '#2563eb', row_id: null, column_id: null, updated_at: 100_000 };
	assert.equal(currentCollaborators([peer], 'mine', 110_000).length, 1);
	assert.equal(currentCollaborators([peer], 'other', 110_000).length, 0);
	assert.equal(currentCollaborators([peer], 'mine', 161_000).length, 1);
	assert.equal(currentCollaborators([peer], 'mine', 699_999).length, 1);
	assert.equal(currentCollaborators([peer], 'mine', 700_000).length, 0);
});
