import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { appendRows, connectWorkspace, createSheet, db, deleteSheet, newColumn, setCell } from '../src/lib/db';
import { recoverStalledEnrichments } from '../src/lib/enrichment-recovery';
import { STALLED_ENRICHMENT_MS } from '../src/lib/enrichment-plan';
import { observeServerDate, serverNow } from '../src/lib/server-clock';
import { MemoryRemote } from './support/memory-remote';

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('recovery expires abandoned runs, restores orphaned queued cells, and preserves recent, active, and newly completed cells', async () => {
	const output = newColumn({ name: 'Result', type: 'enriched', op: { kind: 'search', query: 'example', pick: 'url', numResults: 1 } });
	const sheet = await createSheet('Recovery', [output]);
	await appendRows(sheet.id, Array.from({ length: 9 }, () => ({})));
	const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	const now = Date.now(), old = now - STALLED_ENRICHMENT_MS - 1;
	try {
		for (const row of rows) await setCell(row.id, output.id, { v: 'previous value', s: 'running', t: old });
		await setCell(rows[1].id, output.id, { v: null, s: 'running', t: now });
		// Older versions saved `queued` and could leave it behind when a tab closed.
		await setCell(rows[2].id, output.id, { v: null, s: 'queued', t: old });
		await setCell(rows[6].id, output.id, { v: 'kept', s: 'queued', m: { sources: ['https://example.com'] }, t: old });
		await setCell(rows[7].id, output.id, { v: null, s: 'queued', m: { reasoning: 'No answer found' }, t: old });
		await setCell(rows[8].id, output.id, { v: null, s: 'queued', t: now });
		const snapshot = await db.rows.where('sheetId').equals(sheet.id).toArray();
		await setCell(rows[4].id, output.id, { v: 'finished in another tab', s: 'done', t: now });
		await setCell(rows[5].id, output.id, { v: null, s: 'running', t: now + 1 });
		await recoverStalledEnrichments(sheet.id, snapshot, rowId => rowId === rows[3].id, now);
		const read = async (index: number) => (await db.rows.get(rows[index].id))!.cells[output.id];
		assert.equal((await read(0)).s, 'error');
		assert.match((await read(0)).e!, /interrupted/);
		assert.equal((await read(0)).v, 'previous value');
		assert.equal((await read(1)).s, 'running');
		assert.deepEqual(await read(2), { v: null, s: 'idle', t: now });
		assert.deepEqual(await read(6), { v: 'kept', s: 'done', m: { sources: ['https://example.com'] }, t: now });
		assert.equal((await read(7)).s, 'done', 'A completed lookup with no answer stays completed');
		assert.equal((await read(8)).s, 'queued', 'Recent queued cells may belong to an older tab that is still running');
		assert.equal((await read(3)).s, 'running');
		assert.equal((await read(4)).v, 'finished in another tab');
		assert.equal((await read(4)).s, 'done');
		assert.equal((await read(5)).t, now + 1);
	} finally { await deleteSheet(sheet.id); }
});

test('recovery judges markers on the server’s clock, so a browser whose clock runs ahead never expires a live run', async (t) => {
	const output = newColumn({ name: 'Result', type: 'enriched', op: { kind: 'search', query: 'example', pick: 'url', numResults: 1 } });
	const sheet = await createSheet('Skewed clock', [output]);
	t.after(() => observeServerDate(new Date().toUTCString(), Date.now()));
	observeServerDate(new Date(Date.now() - STALLED_ENRICHMENT_MS - 5 * 60_000).toUTCString(), Date.now());
	try {
		await appendRows(sheet.id, [{}]);
		const [row] = await db.rows.where('sheetId').equals(sheet.id).toArray();
		// An agent started it just now, by the server's clock.
		const live = { v: null, s: 'running' as const, owner: 'mcp-x', t: serverNow() };
		await setCell(row.id, output.id, live);
		await recoverStalledEnrichments(sheet.id, await db.rows.where('sheetId').equals(sheet.id).toArray(), () => false);
		assert.deepEqual((await db.rows.get(row.id))!.cells[output.id], live);
	} finally { await deleteSheet(sheet.id); }
});
