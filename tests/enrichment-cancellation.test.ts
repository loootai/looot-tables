import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { appendRows, connectWorkspace, createSheet, db, deleteSheet, loadSheet, newColumn, setCell, sourceCell, undoSheet } from '../src/lib/db';
import { runner } from '../src/lib/runner';
import { MemoryRemote } from './support/memory-remote';

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('cloud cancellation survives reload, preserves concurrent edits, and abandoned cells can be explicitly rerun', async (t) => {
	const input = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Result', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 1 } });
	const sheet = await createSheet('Cancellation', [input, output]);
	await appendRows(sheet.id, Array.from({ length: 6 }, (_, index) => ({ Domain: `${index}.example` })));
	const rows = () => db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	const records = await rows();
	/** The workspace's copy of a row's result. */
	const saved = (index: number) => remote.snapshot(sheet.id)!.rows[index].cells[output.id];
	let started = 0;
	let release!: () => void;
	let response = new Promise<void>((resolve) => { release = resolve; });
	let conflict = false;
	let patches = 0;
	let holdPatch: Promise<void> | undefined;
	let heldPatch = false;
	t.mock.method(globalThis, 'fetch', async () => { started++; await response; return Response.json({ value: 'result' }); });
	remote.before = async (call) => {
		if (call.method !== 'patch') return;
		if (holdPatch) { const pending = holdPatch; holdPatch = undefined; heldPatch = true; await pending; }
		patches++;
		if (conflict) { conflict = false; remote.edit(sheet.id, (grid) => { grid.rows[0].cells[output.id] = sourceCell('Another member’s edit'); }); }
	};
	const waitFor = async (condition: () => boolean) => {
		for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(condition(), 'Runner did not reach the expected state');
	};
	try {
		await runner.enqueue(sheet, records, [output], { limitToRows: true });
		await waitFor(() => started === 4);
		assert.equal(runner.getSnapshot().queued, 2);
		const beforeCancel = patches;
		await runner.cancel({ sheetId: sheet.id });
		release();
		await waitFor(() => !runner.getSnapshot().active);
		assert.ok(patches > beforeCancel);
		assert.ok(remote.snapshot(sheet.id)!.rows.every((row) => row.cells[output.id].s === 'idle'));
		await loadSheet(sheet.id);
		assert.ok((await rows()).every((row) => row.cells[output.id].s === 'idle'));

		started = 0;
		response = new Promise<void>((resolve) => { release = resolve; });
		await runner.enqueue(sheet, [(await rows())[0]], [output], { limitToRows: true });
		await waitFor(() => started === 1);
		conflict = true;
		await runner.cancel({ sheetId: sheet.id });
		release();
		await waitFor(() => !runner.getSnapshot().active);
		assert.equal(saved(0).v, 'Another member’s edit');
		assert.equal((await db.rows.get(records[0].id))!.cells[output.id].v, 'Another member’s edit');

		// This tab left the cell running before a reload: it knows its own marker and runs the cell again.
		remote.edit(sheet.id, (grid) => { grid.rows[1].cells[output.id] = { v: null, s: 'running', owner: runner.owner, t: Date.now() }; });
		await loadSheet(sheet.id);
		assert.equal((await db.rows.get(records[1].id))!.cells[output.id].s, 'running');
		assert.equal(await runner.enqueue(sheet, [(await rows())[1]], [output], { limitToRows: true }), 1);
		await waitFor(() => !runner.getSnapshot().active);
		assert.equal(saved(1).v, 'result');

		await setCell(records[2].id, output.id, sourceCell('Before undo'));
		started = 0;
		response = new Promise<void>((resolve) => { release = resolve; });
		await runner.enqueue(sheet, [(await rows())[2]], [output], { limitToRows: true });
		await waitFor(() => started === 1);
		let undone = false;
		const undo = undoSheet(sheet.id).then(() => { undone = true; });
		await waitFor(() => undone);
		await undo;
		release();
		await waitFor(() => !runner.getSnapshot().active);
		assert.equal(saved(2).v, null);
		assert.equal(saved(2).s, 'idle');

		let releasePatch!: () => void;
		holdPatch = new Promise<void>((resolve) => { releasePatch = resolve; });
		started = 0;
		const enqueue = runner.enqueue(sheet, [(await rows())[3]], [output], { limitToRows: true });
		await waitFor(() => heldPatch);
		await runner.cancel({ sheetId: sheet.id });
		releasePatch();
		await enqueue;
		// The stopped run undoes its own in-flight start once that save lands.
		await waitFor(() => !runner.getSnapshot().active);
		assert.equal(started, 0);
		assert.equal(saved(3).s, 'idle');
		await loadSheet(sheet.id);
		assert.equal((await db.rows.get(records[3].id))!.cells[output.id].s, 'idle');
	} finally {
		release();
		remote.before = undefined;
		await runner.cancel({ sheetId: sheet.id });
		await waitFor(() => !runner.getSnapshot().active);
		await deleteSheet(sheet.id);
	}
});
