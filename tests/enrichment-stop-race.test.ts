import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { appendRows, connectWorkspace, createSheet, db, deleteSheet, newColumn } from '../src/lib/db';
import { runner } from '../src/lib/runner';
import { MemoryRemote } from './support/memory-remote';

async function waitFor(condition: () => boolean) {
	for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.ok(condition(), 'Runner did not reach expected state');
}

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('stop invalidates tasks awaiting readiness reads, even if the same cell is requeued', async (t) => {
	const input = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Result', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 1 } });
	const sheet = await createSheet('Stop race', [input, output]);
	await appendRows(sheet.id, [{ Domain: 'example.com' }]);
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ value: 'Result' }); });
	const read = db.sheets.get.bind(db.sheets);
	let waiting = false;
	let release!: () => void;
	let pending = new Promise<void>(resolve => { release = resolve; });
	const mocked = t.mock.method(db.sheets, 'get', async (...args: Parameters<typeof read>) => {
		if (!waiting && new Error().stack?.includes('Runner.sheet')) { waiting = true; await pending; }
		return read(...args);
	});
	const rows = () => db.rows.where('sheetId').equals(sheet.id).toArray();
	try {
		await runner.enqueue(sheet, await rows(), [output]);
		await waitFor(() => waiting);
		await runner.cancel({ sheetId: sheet.id });
		release();
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.equal(calls, 0);
		assert.equal((await rows())[0].cells[output.id].s, 'idle');
		waiting = false;
		pending = new Promise<void>(resolve => { release = resolve; });
		await runner.enqueue(sheet, await rows(), [output]);
		await waitFor(() => waiting);
		await runner.cancel({ sheetId: sheet.id });
		await runner.enqueue(sheet, await rows(), [output]);
		release();
		await waitFor(() => !runner.getSnapshot().active);
		assert.equal(calls, 1, 'Only the newly queued task may start');
		assert.equal((await rows())[0].cells[output.id].v, 'Result');
	} finally { release(); mocked.mock.restore(); await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});
