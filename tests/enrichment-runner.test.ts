import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initSync } from '@ironcalc/wasm';
import { calculateFormulas, type FormulaRequest } from '../src/lib/formulas';
import { before, test } from 'node:test';
import { appendRows, connectWorkspace, createSheet, db, deleteSheet, newColumn, setCell, sourceCell, updateColumn } from '../src/lib/db';
import { runner } from '../src/lib/runner';
import { createSheetCommands } from '../src/lib/sheet-commands';
import { renameOpReferences } from '../src/lib/references';
import { cycleMembers } from '../src/lib/enrichment-dependencies';
import type { ColumnOp, Sheet } from '../src/lib/types';
import { CloudError } from '../src/lib/sheet-remote';
import { MemoryRemote } from './support/memory-remote';

initSync({ module: readFileSync(createRequire(`${process.cwd()}/package.json`).resolve('@ironcalc/wasm/wasm_bg.wasm')) });
class TestWorker {
	onmessage?: (event: { data: unknown }) => void;
	terminate() {}
	postMessage(request: FormulaRequest & { id: number }) {
		setTimeout(() => this.onmessage?.({ data: { id: request.id, results: calculateFormulas(request) } }), 0);
	}
}
Object.assign(globalThis, { Worker: TestWorker });

async function rows(sheet: Sheet) { return db.rows.where('sheetId').equals(sheet.id).sortBy('order'); }
async function settled() {
	for (let i = 0; i < 200; i++) {
		if (!runner.getSnapshot().active) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail('Enrichment queue did not settle');
}

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('unfinished runs skip completed null results, store missing responses as null, and allow explicit reruns', async (t) => {
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ value: requests === 1 ? ' — ' : 'Found' }); });
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'snippet', numResults: 1 } });
	const sheet = await createSheet('Missing answers', [domain, output]);
	try {
		await appendRows(sheet.id, [{ Domain: 'one.example' }, { Domain: 'two.example' }]);
		const records = await rows(sheet);
		// Answered after its input was written, so the result is current rather than outdated.
		const answeredAt = Date.now();
		await setCell(records[0].id, output.id, { v: null, s: 'done', t: answeredAt });
		const commands = createSheetCommands(sheet.id);
		const unfinished = async () => {
			const current = await rows(sheet);
			const plan = commands.plan(current, [output], 'unfinished', { ready: () => true, grid: { sheet: (await db.sheets.get(sheet.id))!, rows: current } });
			return plan.kind === 'run' ? plan.execute() : 0;
		};
		assert.equal(await unfinished(), 1);
		await settled();
		assert.equal(requests, 1);
		assert.equal((await rows(sheet))[0].cells[output.id].t, answeredAt);
		assert.equal((await rows(sheet))[1].cells[output.id].v, null);
		assert.equal((await rows(sheet))[1].cells[output.id].s, 'done');
		assert.equal(await unfinished(), 0);
		assert.equal(await runner.enqueue(sheet, [(await rows(sheet))[1]], [output]), 1);
		await settled();
		assert.equal(requests, 2);
		assert.equal((await rows(sheet))[1].cells[output.id].v, 'Found');
	} finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('cycle detection includes overlapping cycles and excludes downstream dependencies', () => {
	const graph = new Map([['A', ['B', 'C']], ['B', ['A']], ['C', ['B']], ['D', ['A']], ['Self', ['Self']], ['Ready', []]]);
	assert.deepEqual([...cycleMembers(graph)].sort(), ['A', 'B', 'C', 'Self']);
});

test('renaming keeps named prompts and page references working, including undo/redo', async () => {
	const { undoSheet, redoSheet } = await import('../src/lib/db');
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const copy = newColumn({ name: 'Copy', type: 'enriched', op: { kind: 'template', template: '{{ domain }}' } });
	const page = newColumn({ name: 'Page', type: 'enriched', op: { kind: 'scrape', page: { type: 'find', column: 'Domain', page: 'pricing' }, mode: 'url', maxChars: 2000 } });
	const sheet = await createSheet('Rename', [domain, copy, page]);
	try {
		await appendRows(sheet.id, [{ Domain: 'example.com' }]);
		await updateColumn(sheet.id, domain.id, { name: 'Website' });
		let fresh = (await db.sheets.get(sheet.id))!;
		assert.deepEqual(fresh.columns[1].op, { kind: 'template', template: '{{Website}}' });
		assert.equal((fresh.columns[2].op as Extract<ColumnOp, { kind: 'scrape' }>).page.type, 'find');
		assert.deepEqual((fresh.columns[2].op as Extract<ColumnOp, { kind: 'scrape' }>).page, { type: 'find', column: 'Website', page: 'pricing' });
		await undoSheet(sheet.id);
		assert.deepEqual((await db.sheets.get(sheet.id))!.columns[1].op, copy.op);
		await redoSheet(sheet.id);
		fresh = (await db.sheets.get(sheet.id))!;
		await runner.enqueue(fresh, await rows(sheet), [fresh.columns[1]]);
		await settled();
		assert.equal((await rows(sheet))[0].cells[copy.id].v, 'example.com');
	} finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('rename rewrites operation inputs without changing literals, labels or other references', () => {
	assert.deepEqual(renameOpReferences({ kind: 'check', question: 'Domain: {{Domain}} {{Domain suffix}} {{A1}}', literal: 'Domain', page: { type: 'template', template: 'https://{{DOMAIN}}/pricing' }, threshold: 0.5, decider: 'openai' }, 'Domain', 'Website'), {
		kind: 'check', question: 'Domain: {{Website}} {{Domain suffix}} {{A1}}', literal: 'Domain', page: { type: 'template', template: 'https://{{Website}}/pricing' }, threshold: 0.5, decider: 'openai',
	});
	assert.deepEqual(renameOpReferences({ kind: 'person', name: '{{Domain}}', company: '{{Domain}}', email: '{{Domain}}', profileUrl: '{{Domain}}', field: 'email' }, 'Domain', 'Website'), {
		kind: 'person', name: '{{Website}}', company: '{{Website}}', email: '{{Website}}', profileUrl: '{{Website}}', field: 'email',
	});
});

test('saving rejects named cycles, self references and coordinate cycles atomically', async () => {
	const a = newColumn({ name: 'First', type: 'enriched', op: { kind: 'template', template: 'constant' } });
	const b = newColumn({ name: 'Second', type: 'enriched', op: { kind: 'template', template: '{{First}}' } });
	const sheet = await createSheet('Cycles', [a, b]);
	try {
		await appendRows(sheet.id, [{}]);
		for (const template of ['{{Second}}', '{{First}}', '{{B1}}']) {
			await assert.rejects(updateColumn(sheet.id, a.id, { op: { kind: 'template', template } }), /Circular enrichment/);
			assert.deepEqual((await db.sheets.get(sheet.id))!.columns[0].op, a.op);
		}
		// A reference to a later row in the same column is acyclic and remains valid.
		await updateColumn(sheet.id, b.id, { op: { kind: 'template', template: '{{B2}}' } });
	} finally { await deleteSheet(sheet.id); }
});


test('legacy cycles fail visibly and independent work still finishes', async () => {
	const a = newColumn({ name: 'First', type: 'enriched', op: { kind: 'template', template: '{{Second}}' } });
	const b = newColumn({ name: 'Second', type: 'enriched', op: { kind: 'template', template: '{{First}}' } });
	const dependent = newColumn({ name: 'Dependent', type: 'enriched', op: { kind: 'template', template: '{{First}}' } });
	const independent = newColumn({ name: 'Independent', type: 'enriched', op: { kind: 'template', template: 'ok' } });
	const sheet = await createSheet('Legacy cycles', [a, b, dependent, independent]);
	try {
		await appendRows(sheet.id, [{}]);
		await runner.enqueue(sheet, await rows(sheet), sheet.columns);
		await settled();
		const [row] = await rows(sheet);
		for (const column of [a, b]) assert.match(row.cells[column.id].e!, /Circular enrichment/);
		assert.equal(row.cells[dependent.id].s, 'error');
		assert.equal(row.cells[independent.id].v, 'ok');
	} finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('in-flight results check inputs and rules, preserve manual edits, and accept unchanged results', async (t) => {
	for (const change of ['input', 'rule', 'manual', 'unrelated', 'none', 'range'] as const) await t.test(change, async (t) => {
		let release!: () => void, started!: () => void;
		const start = new Promise<void>((resolve) => { started = resolve; });
		const response = new Promise<void>((resolve) => { release = resolve; });
		t.mock.method(globalThis, 'fetch', async () => { started(); await response; return Response.json({ value: 'result' }); });
		const input = newColumn({ name: 'Domain', type: 'source' });
		const other = newColumn({ name: 'Other', type: 'source' });
		const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: change === 'range' ? '{{A$2}}' : '{{Domain}}', pick: 'url', numResults: 3 } });
		const sheet = await createSheet('In flight', [input, other, output]);
		try {
			await appendRows(sheet.id, [{ Domain: 'old.example' }, { Domain: 'second.example' }]);
			const records = await rows(sheet);
			await runner.enqueue(sheet, [records[0]], [output]);
			await start;
			if (change === 'input' || change === 'range') await setCell(records[change === 'range' ? 1 : 0].id, input.id, sourceCell('new.example'));
			if (change === 'manual') await setCell(records[0].id, output.id, sourceCell('manual'));
			if (change === 'unrelated') await setCell(records[0].id, other.id, sourceCell('irrelevant'));
			if (change === 'rule') await updateColumn(sheet.id, output.id, { op: { ...output.op as Extract<ColumnOp, { kind: 'search' }>, query: 'new query' } });
			release(); await settled();
			const cell = (await rows(sheet))[0].cells[output.id];
			if (change === 'input' || change === 'range') {
				assert.equal(cell.s, 'error'); assert.equal(cell.v, null); assert.match(cell.e!, /changed during enrichment/);
			} else if (change === 'rule') {
				// A new rule supersedes the run: the cell gets its previous (empty) state back instead of an error.
				assert.equal(cell.s, 'idle'); assert.equal(cell.v, null); assert.equal(cell.e, undefined);
			} else assert.equal(cell.v, change === 'manual' ? 'manual' : 'result');
		} finally { release(); await settled(); await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
	});
});

test('one run fills matching empty rows, compares every dependency, and preserves existing values and formulas', async (t) => {
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ value: 'matched', meta: { provider: 'test' } }); });
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const country = newColumn({ name: 'Country', type: 'source' });
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: '{{Domain}} {{Country}}', pick: 'url', numResults: 3 } });
	const sheet = await createSheet('Duplicates', [domain, country, output]);
	try {
		await appendRows(sheet.id, Array.from({ length: 7 }, (_, i) => ({ Domain: 'example.com', Country: i === 2 ? 'UK' : 'US' })));
		const records = await rows(sheet);
		await setCell(records[3].id, output.id, sourceCell('keep'));
		await setCell(records[6].id, output.id, { v: null, s: 'done', t: 1 });
		await setCell(records[4].id, output.id, { ...sourceCell(null), f: '=A5' });
		await runner.enqueue(sheet, [records[0]], [output]);
		await settled();
		const fresh = await rows(sheet);
		assert.equal(requests, 1);
		for (const i of [0, 1, 5]) assert.equal(fresh[i].cells[output.id].v, 'matched');
		assert.equal(fresh[2].cells[output.id]?.v ?? null, null);
		assert.equal(fresh[3].cells[output.id].v, 'keep');
		assert.equal(fresh[6].cells[output.id].v, null);
		assert.equal(fresh[6].cells[output.id].t, 1);
		assert.equal(fresh[4].cells[output.id].f, '=A5');
	} finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('queued duplicate cells share a request, and in-flight duplicate edits are preserved', async (t) => {
	for (const change of ['none', 'input', 'manual'] as const) await t.test(change, async (t) => {
		let requests = 0, release!: () => void, started!: () => void;
		const start = new Promise<void>((resolve) => { started = resolve; });
		const response = new Promise<void>((resolve) => { release = resolve; });
		t.mock.method(globalThis, 'fetch', async () => { requests++; started(); await response; return Response.json({ value: 'shared' }); });
		const input = newColumn({ name: 'Domain', type: 'source' });
		const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 3 } });
		const sheet = await createSheet('Queued duplicates', [input, output]);
		try {
			await appendRows(sheet.id, [{ Domain: 'same.example' }, { Domain: 'same.example' }]);
			const records = await rows(sheet);
			await runner.enqueue(sheet, change === 'none' ? records : [records[0]], [output]);
			await start;
			if (change === 'input') await setCell(records[1].id, input.id, sourceCell('changed.example'));
			if (change === 'manual') await setCell(records[1].id, output.id, sourceCell('manual'));
			release(); await settled();
			assert.equal(requests, 1);
			assert.equal((await rows(sheet))[1].cells[output.id]?.v ?? null, change === 'none' ? 'shared' : change === 'manual' ? 'manual' : null);
		} finally { release(); await settled(); await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
	});
});

test('queueing saves nothing; a failed save pauses the sheet with the cell still queued, and resume retries it', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({ value: 'Retried successfully' }));
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: 'example', pick: 'url', numResults: 1 } });
	const sheet = await createSheet('Queue save failure', [output]);
	try {
		await appendRows(sheet.id, [{}]);
		const [row] = await rows(sheet);
		remote.before = (call) => { if (call.method === 'patch') throw new CloudError('Could not save or load the organization workspace. Please try again.', 503); };
		assert.equal(await runner.enqueue(sheet, [row], [output], { optimisticStart: true }), 1);
		for (let i = 0; i < 200 && !runner.getSnapshot().halted[sheet.id]; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		const halt = runner.getSnapshot().halted[sheet.id];
		assert.equal(halt?.reason, 'save_failed');
		assert.match(halt.message, /Could not save or load/);
		assert.equal(runner.cellStatus(sheet.id, row.id, output.id), 'queued');
		assert.equal((await rows(sheet))[0].cells[output.id]?.s, 'idle');
		remote.before = undefined;
		runner.resume(sheet.id);
		await settled();
		assert.equal(runner.getSnapshot().halted[sheet.id], undefined);
		assert.equal((await rows(sheet))[0].cells[output.id].v, 'Retried successfully');
	} finally { remote.before = undefined; await runner.cancel({ sheetId: sheet.id }); runner.resume(sheet.id); await deleteSheet(sheet.id); }
});

test('cell play publishes progress before saving and clears it on request failure', async (t) => {
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: 'example', pick: 'url', numResults: 3 } });
	const sheet = await createSheet('Immediate progress', [output]);
	let release!: () => void;
	const saving = new Promise<void>((resolve) => { release = resolve; });
	t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Research failed' }, { status: 400 }));
	try {
		await appendRows(sheet.id, [{}]);
		const [row] = await rows(sheet);
		remote.before = async (call) => { if (call.method === 'patch') await saving; };
		const queued = runner.enqueue(sheet, [row], [output], { optimisticStart: true });
		assert.equal(runner.cellStatus(sheet.id, row.id, output.id), 'running');
		assert.deepEqual([...runner.getSnapshot().bySheet[sheet.id].cells.get(row.id)!], [[output.id, 'running']]);
		assert.equal(row.cells[output.id]?.s, 'idle');
		assert.equal(runner.getSnapshot().queued, 0);
		assert.equal(runner.getSnapshot().running, 1);
		release();
		await queued;
		await settled();
		assert.equal(runner.cellStatus(sheet.id, row.id, output.id), undefined);
		assert.equal((await rows(sheet))[0].cells[output.id].s, 'error');
		assert.match((await rows(sheet))[0].cells[output.id].e!, /Research failed/);
	} finally { remote.before = undefined; release(); await settled(); await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('drag-fill starts available cells optimistically and keeps overflow queued', async () => {
	const name = newColumn({ name: 'Name', type: 'source' });
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'template', template: '{{Name}}' } });
	const sheet = await createSheet('Drag progress', [name, output]);
	let release!: () => void;
	const saving = new Promise<void>((resolve) => { release = resolve; });
	try {
		await appendRows(sheet.id, Array.from({ length: 6 }, (_, index) => ({ Name: `Row ${index}` })));
		const records = await rows(sheet);
		remote.before = async (call) => { if (call.method === 'patch') await saving; };
		const queued = runner.enqueue(sheet, records, [output], { optimisticStart: true });
		assert.deepEqual(records.map((row) => runner.cellStatus(sheet.id, row.id, output.id)), ['running', 'running', 'running', 'running', 'queued', 'queued']);
		assert.equal(runner.getSnapshot().running, 4);
		assert.equal(runner.getSnapshot().queued, 2);
		assert.deepEqual({ ...runner.getSnapshot().bySheet[sheet.id], cells: undefined }, { queued: 2, running: 4, cells: undefined });
		assert.ok(records.every((row) => row.cells[output.id]?.s === 'idle'));
		release();
		await queued;
		await settled();
		assert.ok(records.every((row) => runner.cellStatus(sheet.id, row.id, output.id) === undefined));
		assert.deepEqual((await rows(sheet)).map((row) => row.cells[output.id].v), records.map((row) => row.cells[name.id].v));
	} finally { remote.before = undefined; release(); await settled(); await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('explicit run scopes do not autofill matching rows outside the requested rows', async (t) => {
 t.mock.method(globalThis, 'fetch', async () => Response.json({ value: 'scoped' }));
 const input = newColumn({ name: 'Domain', type: 'source' });
 const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 3 } });
 const sheet = await createSheet('Scoped duplicates', [input, output]);
 try {
  await appendRows(sheet.id, Array.from({ length: 5 }, () => ({ Domain: 'example.com' })));
  const records = await rows(sheet);
  await runner.enqueue(sheet, records.slice(1, 3), [output], { limitToRows: true });
  await settled();
  const fresh = await rows(sheet);
  assert.deepEqual(fresh.map((row) => row.cells[output.id]?.v ?? null), [null, 'scoped', 'scoped', null, null]);
 } finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('a cloud conflict rechecks inputs before committing an in-flight result', async (t) => {
	const input = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Output', type: 'enriched', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 3 } });
	const sheet = await createSheet('Cloud conflict', [input, output]);
	await appendRows(sheet.id, [{ Domain: 'old.example' }]);
	let answered = false, conflicted = false;
	t.mock.method(globalThis, 'fetch', async () => { answered = true; return Response.json({ value: 'outdated' }); });
	// Another member edits the input while the result is in flight, so saving the result conflicts.
	remote.before = (call) => {
		if (call.method !== 'patch' || !answered || conflicted) return;
		conflicted = true;
		remote.edit(sheet.id, (grid) => { grid.rows[0].cells[input.id] = sourceCell('changed-by-another-member.example'); });
	};
	try {
		await runner.enqueue(sheet, await rows(sheet), [output]);
		await settled();
		assert.equal(conflicted, true);
		const [saved] = remote.snapshot(sheet.id)!.rows;
		assert.equal(saved.cells[input.id].v, 'changed-by-another-member.example');
		assert.equal(saved.cells[output.id].v, null);
		assert.match(saved.cells[output.id].e!, /changed during enrichment/);
	} finally { remote.before = undefined; await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});
