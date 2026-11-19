import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { appendRows, connectWorkspace, createSheet, db, deleteSheet, newColumn, setCell, sourceCell, updateColumn } from '../src/lib/db';
import { cellTransition } from '../src/lib/cell-lifecycle';
import { runner } from '../src/lib/runner';
import type { Cell, ColumnOp, Row } from '../src/lib/types';
import { MemoryRemote } from './support/memory-remote';

const rows = (sheetId: string) => db.rows.where('sheetId').equals(sheetId).sortBy('order');
const cellOf = async (rowId: string, columnId: string) => (await db.rows.get(rowId))!.cells[columnId];
async function waitFor(condition: () => boolean | Promise<boolean>, message = 'Runner did not reach the expected state') {
	for (let i = 0; i < 400 && !await condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(await condition(), message);
}
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => { open = resolve; });
	return { opened, open };
}
const search = (query = '{{Domain}}'): ColumnOp => ({ kind: 'search', query, pick: 'url', numResults: 1 });

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('cell transitions keep the settled value and metadata while pending', () => {
	const done: Cell = { v: 'Acme', s: 'done', m: { sources: ['https://acme.example'], reasoning: 'Matched', inputFingerprint: 'v1:x' }, t: 1 };
	const running = cellTransition({ ...done, f: '=A1' }, { type: 'start' }, 2);
	assert.deepEqual(running, { v: 'Acme', m: done.m, s: 'running', t: 2 });
	assert.deepEqual(cellTransition(running, { type: 'start' }, 3), { ...running, t: 3 });
	assert.deepEqual(cellTransition(running, { type: 'cancel' }, 4), { ...done, t: 4 });
	assert.deepEqual(cellTransition({ v: null, s: 'done', m: { reasoning: 'Nothing found' }, t: 1 }, { type: 'start' }, 2), { v: null, s: 'running', m: { reasoning: 'Nothing found' }, t: 2 });
	assert.equal(cellTransition({ v: null, s: 'running', m: { reasoning: 'Nothing found' }, t: 1 }, { type: 'cancel' }).s, 'done');
	assert.deepEqual(cellTransition({ v: null, s: 'error', e: 'Failed', m: { credits: 1 }, t: 1 }, { type: 'start' }, 2), { v: null, s: 'running', t: 2 });
	assert.deepEqual(cellTransition({ v: null, s: 'running', t: 1 }, { type: 'cancel' }, 2), { v: null, s: 'idle', t: 2 });
	assert.deepEqual(cellTransition(running, { type: 'expire' }, 5), { ...running, s: 'error', e: 'This run timed out or was interrupted. Run this cell again.', t: 5 });
	assert.equal(cellTransition(done, { type: 'cancel' }), done);
});

async function sheetWithResult(name: string) {
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Result', type: 'enriched', op: search() });
	const sheet = await createSheet(name, [domain, output]);
	await appendRows(sheet.id, [{ Domain: 'acme.example' }]);
	const previous: Cell = { v: 'https://acme.example', s: 'done', m: { sources: ['https://acme.example'], reasoning: 'Official site' }, t: 1 };
	await setCell((await rows(sheet.id))[0].id, output.id, previous, { history: false });
	// The row as saved: a run is queued against the cell it was shown.
	const [row] = await rows(sheet.id);
	return { sheet, row, output, previous };
}

test('stopping mid-run restores the previous value, sources and reasoning', async (t) => {
	const response = gate();
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; await response.opened; return Response.json({ value: 'https://new.example' }); });
	const { sheet, row, output, previous } = await sheetWithResult('Stop keeps value');
	try {
		await runner.enqueue(sheet, [row], [output]);
		await waitFor(() => requests === 1);
		const pending = await cellOf(row.id, output.id);
		assert.equal(pending.s, 'running');
		assert.equal(pending.v, previous.v);
		assert.deepEqual(pending.m, previous.m);
		await runner.cancel({ sheetId: sheet.id });
		response.open();
		await waitFor(() => !runner.getSnapshot().active);
		assert.deepEqual({ ...await cellOf(row.id, output.id), t: 1 }, previous);
	} finally { response.open(); await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('stopping during a retry wait restores the previous value instead of erasing it', async (t) => {
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ value: null, error: 'Provider is busy', failure: { reason: 'rate_limited', retryable: true, provider: 'context' } }); });
	const { sheet, row, output, previous } = await sheetWithResult('Stop during backoff');
	try {
		await runner.enqueue(sheet, [row], [output]);
		await waitFor(() => requests === 1 && runner.cellStatus(sheet.id, row.id, output.id) === 'queued');
		const waiting = await cellOf(row.id, output.id);
		assert.equal(waiting.s, 'running', 'The saved cell stays running while it waits to retry');
		assert.equal(waiting.v, previous.v);
		await runner.cancel({ sheetId: sheet.id });
		await waitFor(() => !runner.getSnapshot().active);
		assert.equal(requests, 1);
		assert.deepEqual({ ...await cellOf(row.id, output.id), t: 1 }, previous);
	} finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('retries follow failure.retryable, and message patterns only when no failure is given', async (t) => {
	const cases = [
		{ name: 'retryable failure without a familiar message', body: { error: 'Provider hiccup', failure: { reason: 'provider_error', retryable: true } }, retries: true },
		{ name: 'non-retryable failure that mentions 429', body: { error: 'Rejected (429): quota policy', failure: { reason: 'input_invalid', retryable: false } }, retries: false },
		{ name: 'legacy rate-limit message', body: { error: 'Rate limited (429). The runner will retry.' }, retries: true },
	];
	for (const entry of cases) await t.test(entry.name, async (t) => {
		let requests = 0;
		t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ value: null, ...entry.body }); });
		const { sheet, row, output } = await sheetWithResult(entry.name);
		try {
			await runner.enqueue(sheet, [row], [output]);
			if (entry.retries) {
				await waitFor(() => requests === 1 && runner.cellStatus(sheet.id, row.id, output.id) === 'queued');
				assert.equal((await cellOf(row.id, output.id)).s, 'running');
			} else {
				await waitFor(() => !runner.getSnapshot().active);
				const cell = await cellOf(row.id, output.id);
				assert.equal(cell.s, 'error');
				assert.equal(cell.e, entry.body.error);
				assert.equal(requests, 1);
			}
		} finally { await runner.cancel({ sheetId: sheet.id }); await waitFor(() => !runner.getSnapshot().active); await deleteSheet(sheet.id); }
	});
});

test('re-running after a rule edit supersedes the in-flight run instead of ending in an error', async (t) => {
	const first = gate();
	const queries: string[] = [];
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
		const { op } = JSON.parse(String(init?.body)) as { op: { query: string } };
		queries.push(op.query);
		if (queries.length === 1) await first.opened;
		return Response.json({ value: `result for ${op.query}` });
	});
	const { sheet, row, output, previous } = await sheetWithResult('Supersede');
	try {
		await runner.enqueue(sheet, [row], [output]);
		await waitFor(() => queries.length === 1);
		await updateColumn(sheet.id, output.id, { op: search('{{Domain}} pricing') });
		const fresh = (await db.sheets.get(sheet.id))!;
		assert.equal(await runner.enqueue(fresh, await rows(sheet.id), [fresh.columns[1]]), 1);
		assert.equal(runner.cellStatus(sheet.id, row.id, output.id), 'queued');
		first.open();
		await waitFor(() => !runner.getSnapshot().active);
		assert.deepEqual(queries, ['{{Domain}}', '{{Domain}} pricing']);
		const cell = await cellOf(row.id, output.id);
		assert.equal(cell.s, 'done');
		assert.equal(cell.v, 'result for {{Domain}} pricing');
		assert.equal(cell.e, undefined);

		const second = gate();
		queries.length = 0;
		t.mock.method(globalThis, 'fetch', async () => { queries.push('held'); await second.opened; return Response.json({ value: 'too late' }); });
		const settled = await cellOf(row.id, output.id);
		await runner.enqueue(fresh, await rows(sheet.id), [fresh.columns[1]]);
		await waitFor(() => queries.length === 1);
		assert.deepEqual(await runner.supersede(sheet.id, output.id), [row.id]);
		second.open();
		await waitFor(() => !runner.getSnapshot().active);
		assert.deepEqual({ ...await cellOf(row.id, output.id), t: settled.t }, settled);
		assert.notDeepEqual(settled, previous);
	} finally { first.open(); await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('cells are identified structurally, so IDs containing colons never collide', async (t) => {
	const response = gate();
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
		await response.opened;
		return Response.json({ value: (JSON.parse(String(init?.body)) as { row: Record<string, string> }).row.Domain });
	});
	const now = Date.now();
	const domain = { ...newColumn({ name: 'Domain', type: 'source' }), id: 'col:domain' };
	const output = { ...newColumn({ name: 'Result', type: 'enriched', op: search() }), id: 'col:result' };
	// The old `${sheetId}:${rowId}:${columnId}` key was "a:b:c:col:result" for both of these cells.
	const records: Row[] = [
		{ id: 'c', sheetId: 'mcp:a:b', order: 0, cells: { [domain.id]: sourceCell('first.example') }, createdAt: now },
		{ id: 'b:c', sheetId: 'mcp:a', order: 0, cells: { [domain.id]: sourceCell('second.example') }, createdAt: now },
	];
	const sheets = [await createSheet('mcp:a:b', [domain, output], { id: 'mcp:a:b', rows: [records[0]] }), await createSheet('mcp:a', [domain, output], { id: 'mcp:a', rows: [records[1]] })];
	try {
		assert.equal(await runner.enqueue(sheets[0], [records[0]], [output]), 1);
		assert.equal(await runner.enqueue(sheets[1], [records[1]], [output]), 1);
		assert.ok(runner.cellStatus('mcp:a:b', 'c', output.id));
		assert.ok(runner.cellStatus('mcp:a', 'b:c', output.id));
		assert.equal(runner.cellStatus('mcp:a', 'c', output.id), undefined);
		assert.equal(runner.isPending('b:c', output.id, 'mcp:a'), true);
		assert.equal(runner.isPending('b:c', output.id, 'mcp:a:b'), false);
		assert.deepEqual(Object.keys(runner.getSnapshot().bySheet).sort(), ['mcp:a', 'mcp:a:b']);
		assert.deepEqual([...runner.getSnapshot().bySheet['mcp:a:b'].cells.get('c')!.keys()], [output.id]);
		await runner.cancel({ sheetId: 'mcp:a' });
		assert.equal(runner.cellStatus('mcp:a', 'b:c', output.id), undefined);
		assert.ok(runner.cellStatus('mcp:a:b', 'c', output.id));
		response.open();
		await waitFor(() => !runner.getSnapshot().active);
		assert.equal((await cellOf('c', output.id)).v, 'first.example');
		assert.equal(await cellOf('b:c', output.id), undefined, 'The stopped cell was never written');
	} finally { response.open(); await runner.cancel(); await deleteSheet('mcp:a:b'); await deleteSheet('mcp:a'); }
});

test('a fatal provider failure pauses the sheet once instead of failing every queued cell', async (t) => {
	const others = gate();
	let requests = 0;
	const fatal = { error: 'Out of credits (402): Context.dev balance is empty', failure: { reason: 'credits_exhausted', retryable: false, provider: 'context' } };
	const fetch = t.mock.method(globalThis, 'fetch', async () => {
		if (++requests === 1) return Response.json({ value: null, ...fatal });
		await others.opened;
		return Response.json({ value: 'ok' });
	});
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Result', type: 'enriched', op: search() });
	const sheet = await createSheet('Fatal failure', [domain, output]);
	try {
		await appendRows(sheet.id, Array.from({ length: 6 }, (_, i) => ({ Domain: `${i}.example` })));
		const records = await rows(sheet.id);
		await runner.enqueue(sheet, records, [output]);
		await waitFor(() => Boolean(runner.getSnapshot().halted[sheet.id]));
		assert.deepEqual(runner.getSnapshot().halted[sheet.id], { sheetId: sheet.id, reason: 'credits_exhausted', provider: 'context', message: fatal.error, failedCells: 1 });
		others.open();
		await waitFor(async () => (await rows(sheet.id)).filter((row) => row.cells[output.id].v === 'ok').length === 3);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(requests, 4, 'No new request starts while the sheet is paused');
		assert.equal(runner.getSnapshot().bySheet[sheet.id].queued, 2);
		assert.equal(runner.getSnapshot().active, true);
		const failed = (await rows(sheet.id)).filter((row) => row.cells[output.id].s === 'error');
		assert.equal(failed.length, 1);
		assert.equal(failed[0].cells[output.id].e, fatal.error);

		fetch.mock.mockImplementation(async () => { requests++; return Response.json({ value: 'ok' }); });
		assert.equal(await runner.retryFailed(sheet.id), 1);
		await waitFor(() => !runner.getSnapshot().active);
		assert.equal(runner.getSnapshot().halted[sheet.id], undefined);
		assert.ok((await rows(sheet.id)).every((row) => row.cells[output.id].v === 'ok'));
		assert.equal(requests, 7);
	} finally { others.open(); await runner.cancel({ sheetId: sheet.id }); runner.resume(sheet.id); await deleteSheet(sheet.id); }
});
