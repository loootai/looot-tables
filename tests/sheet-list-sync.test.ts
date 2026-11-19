import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { applyLiveIndex, connectWorkspace, createSheetFromRecords, db, deleteSheet, loadSheet, onSheetRemoved, sheetSync, updateSheet } from '../src/lib/db';
import { CloudError } from '../src/lib/sheet-remote';
import type { Row, Sheet } from '../src/lib/types';
import { MemoryRemote } from './support/memory-remote';

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

const sheet = (id: string, name = id): Sheet => ({ id, name, columns: [{ id: 'value', name: 'Value', type: 'source', width: 180, createdAt: 0 }], filters: [], sort: null, createdAt: 0, updatedAt: 0 });
const row = (sheetId: string, value: string): Row => ({ id: `${sheetId}-${value}`, sheetId, order: 0, createdAt: 0, cells: { value: { v: value, s: 'done', t: 1 } } });
/** This tab hears about teammates' changes only through the live index. */
const announce = () => applyLiveIndex(remote.liveIndex());
const cached = async (sheetId: string) => (await db.sheets.get(sheetId))!;

test('list actions work on sheets a teammate created or edited after this tab loaded', async () => {
	await remote.create(sheet('created', 'Teammate sheet'), [row('created', 'Saved')]);
	await announce();
	assert.equal(sheetSync(await cached('created')), 'index-only');
	assert.equal(await db.rows.where('sheetId').equals('created').count(), 0);

	// Rename loads the sheet first, so the change is made against a real revision and keeps the rows.
	await updateSheet('created', { name: 'Renamed' });
	assert.equal(remote.snapshot('created')!.sheet.name, 'Renamed');
	assert.equal(sheetSync(await cached('created')), 'synced');
	assert.equal(await db.rows.where('sheetId').equals('created').count(), 1);

	// A teammate edits it again: this tab is stale, but the list shows (and deletes) the revision it saw.
	remote.edit('created', (grid) => { grid.sheet.name = 'Edited remotely'; grid.rows = [row('created', 'Newer')]; });
	await announce();
	assert.equal(sheetSync(await cached('created')), 'stale');
	await deleteSheet('created');
	assert.equal(remote.snapshot('created'), undefined);
	assert.equal(await db.sheets.get('created'), undefined);

	// The edit lands between the index event and the click: one fresh retry, no conflict for the user.
	await remote.create(sheet('busy'), []);
	await announce();
	remote.edit('busy', () => {});
	const removals = remote.calls.length;
	await deleteSheet('busy');
	assert.equal(remote.snapshot('busy'), undefined);
	assert.deepEqual(remote.calls.slice(removals), [{ method: 'remove', sheetId: 'busy', revision: 1 }, { method: 'remove', sheetId: 'busy', revision: 2 }]);

	// A sheet that keeps changing is not deleted out from under the people editing it.
	await remote.create(sheet('editing'), []);
	await announce();
	remote.before = (call) => { if (call.method === 'remove') remote.edit('editing', () => {}); };
	await assert.rejects(deleteSheet('editing'), /“editing” is being edited right now/);
	remote.before = undefined;
	assert.ok(remote.snapshot('editing') && await db.sheets.get('editing'));
	await deleteSheet('editing');
});

test('opening an index-only sheet loads its rows, and a sheet deleted on the server leaves the cache', async () => {
	const removed: string[] = [];
	const stop = onSheetRemoved((sheetId) => removed.push(sheetId));
	try {
		await remote.create(sheet('opened'), [row('opened', 'Visible')]);
		await remote.create(sheet('listed'), []);
		await announce();
		assert.equal(await loadSheet('opened'), true);
		assert.equal((await db.rows.where('sheetId').equals('opened').first())?.cells.value.v, 'Visible');
		remote.drop('opened');
		assert.equal(await loadSheet('opened'), false);
		assert.equal(await db.sheets.get('opened'), undefined);
		// Missing from the index is not proof; the workspace saying it has no such sheet is.
		remote.drop('listed');
		await announce();
		assert.equal(await db.sheets.get('listed'), undefined);
		assert.deepEqual(removed, ['opened', 'listed']);
	} finally { stop(); }
});

test('CSV import creates the sheet and its rows in one request; a stray value keeps a website column as text', async () => {
	const seen = remote.calls.length;
	const imported = await createSheetFromRecords('Leads', [{ Company: 'Acme', Domain: 'https://www.acme.example/' }, { Company: 'Orbit', Domain: 'orbit.example' }]);
	assert.deepEqual(remote.calls.slice(seen).map((call) => call.method), ['create']);
	assert.equal(remote.snapshot(imported.id)!.rows.length, 2);
	const domain = imported.columns.find((column) => column.name === 'Domain')!;
	assert.equal(domain.format, 'website');
	assert.deepEqual((await db.rows.where('sheetId').equals(imported.id).sortBy('order')).map((entry) => entry.cells[domain.id].v), ['acme.example', 'orbit.example']);

	const loose = await createSheetFromRecords('Loose', [{ Domain: 'n/a' }, { Domain: 'orbit.example' }]);
	assert.equal(loose.columns[0].format, 'text');
	assert.deepEqual((await db.rows.where('sheetId').equals(loose.id).toArray()).map((entry) => entry.cells[loose.columns[0].id].v).sort(), ['n/a', 'orbit.example']);

	remote.before = () => { throw new CloudError('Workspace temporarily unavailable.', 503); };
	const count = await db.sheets.count();
	await assert.rejects(createSheetFromRecords('Failed', [{ Company: 'Acme' }]), /temporarily unavailable/);
	remote.before = undefined;
	assert.equal(await db.sheets.count(), count, 'a failed import leaves no empty sheet behind');
});
