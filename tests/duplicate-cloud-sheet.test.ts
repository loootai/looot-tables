import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { applyLiveIndex, connectWorkspace, db, duplicateSheet } from '../src/lib/db';
import { CloudError } from '../src/lib/sheet-remote';
import type { Row, Sheet } from '../src/lib/types';
import { MemoryRemote, type RemoteCall } from './support/memory-remote';

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('duplication copies every row of the workspace’s current version, even of a shared sheet this tab never opened', async () => {
	const source: Sheet = { id: 'shared', name: 'Shared', columns: [{ id: 'value', name: 'Value', type: 'source', width: 180, createdAt: 0 }], filters: [], sort: null, createdAt: 0, updatedAt: 0 };
	const rows: Row[] = Array.from({ length: 101 }, (_, order) => ({ id: `r${order}`, sheetId: source.id, order, createdAt: 0, cells: { value: { v: `Value ${order}`, s: 'done', t: 1 } } }));
	await remote.create(source, rows);
	await applyLiveIndex(remote.liveIndex());
	assert.equal(await db.rows.count(), 0);
	let edited = false, created: Extract<RemoteCall, { method: 'create' }> | undefined;
	remote.before = (call) => {
		// A teammate edits the sheet just before this tab reads it.
		if (call.method === 'read' && !edited) { edited = true; remote.edit(source.id, (grid) => { grid.sheet.name = 'Renamed'; grid.rows[0].cells.value.v = 'Updated remotely'; }); }
		if (call.method === 'create') created = call;
	};
	const copy = (await duplicateSheet(source.id))!;
	assert.equal(copy.name, 'Renamed copy');
	assert.equal(created!.sheet.cloudSummary, undefined, 'the live index summary is not copied');
	const stored = remote.snapshot(copy.id)!;
	assert.equal(stored.rows.length, 101);
	assert.equal(stored.rows[0].cells.value.v, 'Updated remotely');
	assert.ok(stored.rows.every((row) => row.sheetId === copy.id && !rows.some((original) => original.id === row.id)));
	assert.equal(await db.rows.where('sheetId').equals(copy.id).count(), 101);

	const creates = () => remote.calls.filter((call) => call.method === 'create').length;
	const copies = creates();
	remote.before = (call) => { if (call.method === 'read') throw new CloudError('Unavailable', 503); };
	await assert.rejects(duplicateSheet(source.id), /Unavailable/);
	assert.equal(creates(), copies, 'A failed source read must never create a stale copy');
	remote.before = undefined;
});
