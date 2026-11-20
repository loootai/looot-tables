import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { appendRows, connectWorkspace, createSheet, db, deleteSheet, newColumn } from '../src/lib/db';
import { expiredCell, STALLED_ENRICHMENT_MS } from '../src/lib/enrichment-plan';
import { runner } from '../src/lib/runner';
import { CloudError } from '../src/lib/sheet-remote';
import { observeServerDate, serverNow } from '../src/lib/server-clock';
import type { Cell, Sheet } from '../src/lib/types';
import { MemoryRemote } from './support/memory-remote';

/* Races between this tab and other writers, through the real IndexedDB cache and its conflict replay. The remote's
   `before` hook lands another tab's or an agent's write just ahead of one of this tab's commits. */

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

const rows = (sheet: Sheet) => db.rows.where('sheetId').equals(sheet.id).sortBy('order');
async function waitFor(condition: () => boolean, message: string) {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(condition(), message);
}

test('a run that loses the race to start its cell never asks the provider, and waits on the winner', async (t) => {
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ value: 'this tab’s answer' }); });
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 1 } });
	const sheet = await createSheet('Start race', [domain, output]);
	try {
		await appendRows(sheet.id, [{ Domain: 'acme.com' }]);
		const theirs: Cell = { v: null, s: 'running', owner: 'tab-other', t: Date.now() };
		// Another tab starts the same cell just before this tab's start reaches the workspace: the start is replayed on
		// their version, where the cell is no longer the one this run planned from.
		remote.before = (call) => {
			if (call.method !== 'patch' || call.patch.rows[0]?.cells[output.id]?.owner !== runner.owner) return;
			remote.before = undefined;
			remote.edit(sheet.id, (grid) => { grid.rows[0].cells[output.id] = theirs; });
		};
		await runner.enqueue(sheet, await rows(sheet), [output]);
		await waitFor(() => !remote.before && runner.getSnapshot().running === 0, 'the start was refused');
		assert.equal(requests, 0, 'the provider is never asked for a cell another tab started');
		assert.deepEqual(remote.snapshot(sheet.id)!.rows[0].cells[output.id], theirs, 'their run is left alone');
		assert.equal(runner.cellStatus(sheet.id, (await rows(sheet))[0].id, output.id), 'queued', 'the cell is waited on');
	} finally { remote.before = undefined; await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('this tab stamps its running marker on the server’s clock, so other machines judge its age correctly', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ value: 'answer' }));
	t.after(() => observeServerDate(new Date().toUTCString(), Date.now()));
	observeServerDate(new Date(Date.now() - 15 * 60_000).toUTCString(), Date.now());
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 1 } });
	const sheet = await createSheet('Marker clock', [domain, output]);
	let marker: Cell | undefined;
	try {
		await appendRows(sheet.id, [{ Domain: 'acme.com' }]);
		remote.before = (call) => {
			const cell = call.method === 'patch' ? call.patch.rows[0]?.cells[output.id] : undefined;
			if (cell?.s === 'running') marker = cell;
		};
		await runner.enqueue(sheet, await rows(sheet), [output]);
		await waitFor(() => !runner.getSnapshot().active, 'the run finished');
		assert.ok(marker && Math.abs(marker.t - serverNow()) < 5_000, 'stamped with the server’s time, 15 minutes behind this machine');
	} finally { remote.before = undefined; await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('a paused run’s paid result is saved on resume when its marker expired on the server but not yet in this tab’s cache', async (t) => {
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ value: 'answer' }); });
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 1 } });
	const sheet = await createSheet('Stale resume', [domain, output]);
	let marker: Cell | undefined, failed = false;
	try {
		await appendRows(sheet.id, [{ Domain: 'acme.com' }]);
		remote.before = (call) => {
			const cell = call.method === 'patch' ? call.patch.rows[0]?.cells[output.id] : undefined;
			if (cell?.s === 'running') marker = cell;
			if (cell?.s === 'done' && !failed) { failed = true; throw new CloudError('Workspace temporarily unavailable.', 503); }
		};
		await runner.enqueue(sheet, await rows(sheet), [output]);
		await waitFor(() => Boolean(runner.getSnapshot().halted[sheet.id]), 'the failed save paused the sheet');
		// The pause outlasts the expiry rule: another viewer fails the marker on the server, unseen by this tab's cache.
		remote.edit(sheet.id, (grid) => { grid.rows[0].cells[output.id] = expiredCell(marker, marker!.t + STALLED_ENRICHMENT_MS)!; });
		assert.equal((await rows(sheet))[0].cells[output.id].s, 'running');
		runner.resume(sheet.id);
		await waitFor(() => !runner.getSnapshot().active, 'the resumed save settled');
		const saved = remote.snapshot(sheet.id)!.rows[0].cells[output.id];
		assert.deepEqual([saved.s, saved.v, requests], ['done', 'answer', 1], 'kept, not requested again');
	} finally { remote.before = undefined; await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});
