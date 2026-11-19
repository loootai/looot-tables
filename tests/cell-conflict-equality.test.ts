import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { appendRows, connectWorkspace, createSheet, db, newColumn, setCell, sourceCell, updateCellsIf } from '../src/lib/db';
import type { Cell, Row } from '../src/lib/types';
import { MemoryRemote } from './support/memory-remote';

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('conditional cloud writes survive reordered JSONB keys but retain real conflicting edits', async () => {
	const column = newColumn({ name: 'Result', type: 'source' });
	const sheet = await createSheet('Conflicts', [column]);
	await appendRows(sheet.id, [{ Result: 'before' }]);
	const [row] = await db.rows.where('sheetId').equals(sheet.id).toArray();
	const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, reorder(child)])) : value;
	/** Just before the next save lands, a teammate renames the sheet (its rows come back with keys in another order), and may replace the cell. */
	const teammate = (replacement?: Cell) => {
		remote.before = (call) => {
			if (call.method !== 'patch') return;
			remote.before = undefined;
			remote.edit(sheet.id, (grid) => {
				grid.sheet.name = 'Renamed remotely';
				grid.rows = reorder(grid.rows) as Row[];
				if (replacement) grid.rows[0].cells[column.id] = replacement;
			});
		};
	};
	const saved = () => remote.snapshot(sheet.id)!.rows[0].cells[column.id].v;
	const updateIf = async (expected: Cell, update: () => Cell) => (await updateCellsIf(sheet.id, [{ rowId: row.id, columnId: column.id, expected, update }]))[0];
	const expected = { v: null, s: 'running' as const, t: 1, m: { confidence: 0.9, sources: ['https://example.com'] } };
	await setCell(row.id, column.id, expected, { history: false });
	teammate();
	assert.equal(await updateIf(expected, () => sourceCell('provider result')), true);
	assert.equal(saved(), 'provider result');
	teammate();
	await setCell(row.id, column.id, sourceCell('manual edit'));
	assert.equal(saved(), 'manual edit');
	const beforeConflict = structuredClone((await db.rows.get(row.id))!.cells[column.id]);
	teammate(sourceCell('Teammate edit'));
	assert.equal(await updateIf(beforeConflict, () => sourceCell('stale result')), false);
	assert.equal(saved(), 'Teammate edit');
	teammate(sourceCell('Another edit'));
	await assert.rejects(setCell(row.id, column.id, sourceCell('stale manual edit')), /Someone changed this cell/);
	assert.equal(saved(), 'Another edit');
	assert.equal((await db.sheets.get(sheet.id))!.name, 'Renamed remotely');
});
