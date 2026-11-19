import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/lib/cell-content';
import { expiredCell, planCell, resultCell, STALLED_ENRICHMENT_MS } from '../src/lib/enrichment-plan';
import { ApiError } from '../src/lib/api';
import { Runner, type RunnerPorts, type RunnerStore } from '../src/lib/runner';
import type { Cell, CellValue, Column, ColumnOp, EnrichResponse, Row, Sheet } from '../src/lib/types';

/* The runner's core on an in-memory grid: its store port stands in for IndexedDB, so no fake database or formula
   engine is needed. */

const source = (id: string, name: string): Column => ({ id, name, type: 'source', width: 180, createdAt: 0 });
const ai = (id: string, name: string, op: ColumnOp): Column => ({ id, name, type: 'enriched', op, width: 180, createdAt: 0 });
const search = (query: string): ColumnOp => ({ kind: 'search', query, pick: 'url', numResults: 1 });

function memory(columns: Column[], cells: Array<Record<string, Cell>>) {
	const sheet: Sheet = { id: 's', name: 'S', columns, filters: [], sort: null, createdAt: 0, updatedAt: 0 };
	let rows: Row[] = cells.map((entry, order) => ({ id: `r${order}`, sheetId: 's', order, createdAt: 0, cells: entry }));
	const copy = () => structuredClone(rows);
	let gate: Promise<void> | undefined, failures = 0, onRead: (() => void) | undefined;
	const writes: Array<{ rowId: string; columnId: string; cell: Cell }> = [];
	const store: RunnerStore = {
		sheet: async (id) => id === sheet.id ? structuredClone(sheet) : undefined,
		rows: async (id, rowIds) => { onRead?.(); return id !== sheet.id ? [] : copy().filter((row) => !rowIds || rowIds.includes(row.id)); },
		async updateCells(_id, changes) {
			await gate;
			if (failures && failures--) throw new Error('Could not reach the workspace.');
			const fresh = copy();
			const applied = changes.map(({ rowId, columnId, expected, update }) => {
				const row = fresh.find((entry) => entry.id === rowId);
				if (!row || canonicalJson(row.cells[columnId]) !== canonicalJson(expected)) return false;
				const next = update(structuredClone(sheet), fresh);
				if (next) { row.cells[columnId] = next; writes.push({ rowId, columnId, cell: next }); }
				return Boolean(next);
			});
			rows = fresh;
			return applied;
		},
	};
	const requests: Array<{ op: ColumnOp; record: Record<string, CellValue> }> = [];
	let answer = async (_op: ColumnOp, record: Record<string, CellValue>): Promise<EnrichResponse> => ({ value: `found ${record.Domain ?? record.Name}` });
	const ports: RunnerPorts = { store, enrich: (op, record) => { requests.push({ op, record }); return answer(op, record); }, concurrency: () => 4, waitMs: 5 };
	return {
		runner: new Runner(ports), sheet, requests, writes,
		cell: (row: number, column: string) => rows[row].cells[column],
		set(row: number, column: string, cell: Cell) { rows[row].cells[column] = cell; },
		answer(next: typeof answer) { answer = next; },
		hold() { let open!: () => void; gate = new Promise((resolve) => { open = resolve; }); return () => { gate = undefined; open(); }; },
		/** Runs before each read of rows, as another writer could change them between two reads. */
		onRead(hook: () => void) { onRead = hook; },
		/** The next `count` saves fail, as a lost connection would. */
		failSaves(count: number) { failures = count; },
		rows: () => copy(),
	};
}

async function settled(runner: Runner) {
	for (let i = 0; i < 400 && runner.getSnapshot().active; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.equal(runner.getSnapshot().active, false, 'the queue settles');
}

test('a dependency that never ran fails its dependent instead of running it on a blank input; a queued one is waited on', async () => {
	const grid = memory([source('name', 'Name'), ai('domain', 'Domain', search('{{Name}}')), ai('out', 'Out', search('{{Domain}}'))], [{ name: { v: 'Acme', s: 'done', t: 1 } }]);
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[2]]);
	await settled(grid.runner);
	assert.deepEqual([grid.cell(0, 'out').s, grid.cell(0, 'out').e], ['error', 'Waiting on "Domain", which hasn’t run yet. Run it first.']);
	assert.equal(grid.requests.length, 0);
	await grid.runner.enqueue(grid.sheet, grid.rows(), grid.sheet.columns.slice(1).reverse());
	await settled(grid.runner);
	assert.deepEqual(grid.requests.map(({ op }) => op), [search('{{Name}}'), search('{{Domain}}')]);
	assert.equal(grid.requests[1].record.Domain, 'found Acme', 'the dependent ran on its dependency’s answer');
	assert.equal(grid.cell(0, 'out').v, 'found found Acme');
});

test('a dependency running in another tab or an agent is waited on until its result lands', async () => {
	const grid = memory([source('name', 'Name'), ai('domain', 'Domain', search('{{Name}}')), ai('out', 'Out', search('{{Domain}}'))], [{ name: { v: 'Acme', s: 'done', t: 1 }, domain: { v: null, s: 'running', t: Date.now() } }]);
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[2]]);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(grid.runner.cellStatus('s', 'r0', 'out'), 'queued');
	assert.equal(grid.requests.length, 0);
	grid.set(0, 'domain', { v: 'acme.com', s: 'done', t: Date.now() });
	await settled(grid.runner);
	assert.deepEqual(grid.requests[0].record, { Name: 'Acme', Domain: 'acme.com', Out: null }, 'the cell’s own previous value is never sent');
	assert.equal(grid.cell(0, 'out').v, 'found acme.com');
});

test('the queue stays active until a failed cell’s error is written', async () => {
	const grid = memory([ai('out', 'Out', search('{{Missing}}'))], [{}]);
	const release = grid.hold();
	await grid.runner.enqueue(grid.sheet, grid.rows(), grid.sheet.columns);
	for (let i = 0; i < 100 && grid.runner.cellStatus('s', 'r0', 'out'); i++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.equal(grid.runner.cellStatus('s', 'r0', 'out'), undefined, 'the task left the queue');
	await grid.runner.cancel({ sheetId: 'unrelated' });
	assert.deepEqual([grid.runner.getSnapshot().queued, grid.runner.getSnapshot().active], [0, true], 'the failure is still being written');
	release();
	await settled(grid.runner);
	assert.equal(grid.cell(0, 'out').e, '{{Missing}} doesn’t match any column. Edit this column to fix it.');
});

test('results whose inputs changed mid-run are kept out, through the same plan', async () => {
	const grid = memory([source('name', 'Name'), ai('out', 'Out', search('{{Name}}'))], [{ name: { v: 'Acme', s: 'done', t: 1 } }]);
	let release!: () => void;
	grid.answer(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { value: 'late' }; });
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.equal(grid.cell(0, 'out').s, 'running');
	grid.set(0, 'name', { v: 'Other', s: 'done', t: 2 });
	release();
	await settled(grid.runner);
	assert.deepEqual([grid.cell(0, 'out').s, grid.cell(0, 'out').v], ['error', null]);
	assert.match(grid.cell(0, 'out').e!, /changed during enrichment/);
});

test('finished cells that cannot run keep their values: no request and no write', async () => {
	const columns = [source('company', 'Company'), source('notes', 'Notes'), ai('ceo', 'CEO', { kind: 'ai', prompt: 'Who runs {{Company}}? {{Notes}}', output: 'text', research: 'web' })];
	const sheet: Sheet = { id: 's', name: 'S', columns, filters: [], sort: null, createdAt: 0, updatedAt: 0 };
	const rows: Row[] = [0, 1, 2].map((order) => ({ id: `r${order}`, sheetId: 's', order, createdAt: 0, cells: { company: { v: `Co ${order}`, s: 'done', t: 1 }, notes: { v: `note ${order}`, s: 'done', t: 1 } } }));
	for (const row of rows) row.cells.ceo = resultCell(planCell({ sheet, rows }, { rowId: row.id, columnId: 'ceo' })!, `CEO ${row.id}`, undefined, 2);
	// Notes is deleted, as the browser deletes a column: its cells go too.
	const grid = memory([columns[0], columns[2]], rows.map(({ cells: { company, ceo } }) => ({ company, ceo })));
	const before = grid.rows();
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	await settled(grid.runner);
	assert.equal(grid.requests.length, 0);
	assert.deepEqual(grid.writes, []);
	assert.deepEqual(grid.rows(), before, 'every value is intact');
});

test('a failed re-run keeps the previous value with its error', async () => {
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 } }]);
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	await settled(grid.runner);
	const previous = grid.cell(0, 'out');
	assert.equal(previous.v, 'found acme.com');
	grid.set(0, 'domain', { v: 'other.com', s: 'done', t: 2 });
	grid.answer(async () => ({ value: null, error: 'The provider refused this request.', failure: { reason: 'provider_error', retryable: false } }));
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	await settled(grid.runner);
	assert.deepEqual(grid.cell(0, 'out'), { ...previous, s: 'error', e: 'The provider refused this request.', t: grid.cell(0, 'out').t });
	assert.equal(grid.requests.length, 2);
});

test('a cell an agent is running is waited on, never run twice, and stopping leaves its marker', async () => {
	const marker: Cell = { v: null, s: 'running', owner: 'mcp-x', t: Date.now() };
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 }, out: marker }]);
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(grid.requests.length, 0);
	assert.equal(grid.runner.cellStatus('s', 'r0', 'out'), 'queued', 'it waits for the agent’s result');
	await grid.runner.cancel({ sheetId: 's' });
	await settled(grid.runner);
	assert.deepEqual([grid.cell(0, 'out'), grid.writes], [marker, []], 'the agent’s marker is not this tab’s to restore');
	const own = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 } }]);
	own.set(0, 'out', { v: null, s: 'running', owner: own.runner.owner, t: Date.now() });
	await own.runner.enqueue(own.sheet, own.rows(), [own.sheet.columns[1]]);
	await settled(own.runner);
	assert.equal(own.cell(0, 'out').v, 'found acme.com', 'its own marker, left before a reload, runs again');
});

test('a result whose save failed is saved on resume without asking the provider again', async () => {
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 } }]);
	let release!: () => void;
	grid.answer(async (_op, record) => { await new Promise<void>((resolve) => { release = resolve; }); return { value: `found ${record.Domain}` }; });
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	grid.failSaves(1);
	release();
	for (let i = 0; i < 100 && !grid.runner.getSnapshot().halted.s; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.equal(grid.runner.getSnapshot().halted.s?.reason, 'save_failed');
	assert.equal(grid.cell(0, 'out').s, 'running');
	grid.runner.resume('s');
	await settled(grid.runner);
	assert.equal(grid.cell(0, 'out').v, 'found acme.com');
	assert.equal(grid.requests.length, 1, 'the paid result was kept, not requested again');
});

test('queuing the same operation with its keys in another order keeps the request in flight', async () => {
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 } }]);
	let release!: () => void;
	grid.answer(async (_op, record) => { await new Promise<void>((resolve) => { release = resolve; }); return { value: `found ${record.Domain}` }; });
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	const reordered = Object.fromEntries(Object.entries(grid.sheet.columns[1].op!).reverse()) as ColumnOp;
	assert.equal(await grid.runner.enqueue(grid.sheet, grid.rows(), [{ ...grid.sheet.columns[1], op: reordered }]), 0);
	release();
	await settled(grid.runner);
	assert.deepEqual([grid.requests.length, grid.cell(0, 'out').v], [1, 'found acme.com']);
});

test('a queued cell that finishes elsewhere while it waits is never run again here', async () => {
	const marker: Cell = { v: null, s: 'running', owner: 'mcp-x', t: Date.now() };
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 }, out: marker }]);
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(grid.runner.cellStatus('s', 'r0', 'out'), 'queued', 'it waits for the agent');
	grid.set(0, 'out', { v: 'the agent’s answer', s: 'done', t: Date.now() });
	await settled(grid.runner);
	assert.deepEqual([grid.requests.length, grid.cell(0, 'out').v, grid.writes], [0, 'the agent’s answer', []]);
	// Waiting on a dependency instead: another tab finishes both cells meanwhile.
	const chain = memory([source('name', 'Name'), ai('domain', 'Domain', search('{{Name}}')), ai('out', 'Out', search('{{Domain}}'))], [{ name: { v: 'Acme', s: 'done', t: 1 }, domain: { v: null, s: 'running', owner: 'tab-other', t: Date.now() } }]);
	await chain.runner.enqueue(chain.sheet, chain.rows(), [chain.sheet.columns[2]]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	chain.set(0, 'domain', { v: 'acme.com', s: 'done', t: Date.now() });
	chain.set(0, 'out', { v: 'their answer', s: 'done', t: Date.now() });
	await settled(chain.runner);
	assert.deepEqual([chain.requests.length, chain.cell(0, 'out').v], [0, 'their answer']);
});

test('a dependent waiting on an input that finishes elsewhere during the same scan still runs', async () => {
	const grid = memory([source('name', 'Name'), ai('site', 'Site', search('{{Name}}')), ai('summary', 'Summary', search('{{Site}}'))], [{ name: { v: 'Acme', s: 'done', t: 1 } }]);
	// "Run unfinished" queues Summary, then its unrun input Site (see `withUnrunInputs`). Another tab finishes Site after
	// Summary was planned on it, before Site is: Site's task is dropped, and nothing outside the scan wakes the queue.
	let reads = 0;
	grid.onRead(() => { if (++reads === 2) grid.set(0, 'site', { v: 'acme.com', s: 'done', t: Date.now() }); });
	await Promise.all([grid.sheet.columns[2], grid.sheet.columns[1]].map((column) => grid.runner.enqueue(grid.sheet, grid.rows(), [column], { unfinished: true })));
	await settled(grid.runner);
	assert.deepEqual(grid.requests.map(({ record }) => record.Site), ['acme.com'], 'Summary ran on the other tab’s Site');
	assert.equal(grid.cell(0, 'summary').s, 'done');
});

test('without a structured failure, only a rate limit is retried: a server error or a dropped connection may have been billed', async () => {
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 } }]);
	const failures = [async () => { throw new ApiError('Service Unavailable', 503); }, async () => { throw new TypeError('Failed to fetch'); }, async () => ({ value: null, error: 'The provider is overloaded (502).' })];
	for (const fail of failures) {
		grid.answer(fail);
		await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
		await settled(grid.runner);
	}
	assert.equal(grid.requests.length, failures.length, 'each was sent once');
	grid.answer(async () => ({ value: null, error: 'Rate limited (429). Wait a moment and try again.' }));
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	for (let i = 0; i < 100 && grid.requests.length === failures.length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(grid.runner.cellStatus('s', 'r0', 'out'), 'queued', 'a rate-limited request waits to be sent again');
	await grid.runner.cancel({ sheetId: 's' });
	await settled(grid.runner);
});

test('“Run unfinished” never runs a finished cell, even one it was handed; an explicit re-run does', async () => {
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 }, out: { v: 'kept', s: 'done', t: 2 } }]);
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]], { unfinished: true });
	await settled(grid.runner);
	assert.deepEqual([grid.requests.length, grid.cell(0, 'out').v], [0, 'kept']);
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	await settled(grid.runner);
	assert.deepEqual([grid.requests.length, grid.cell(0, 'out').v], [1, 'found acme.com']);
});

test('a paused run’s paid result is saved on resume even after another viewer expired its marker, unless its inputs changed', async () => {
	const pause = async (grid: ReturnType<typeof memory>) => {
		let release!: () => void;
		grid.answer(async (_op, record) => { await new Promise<void>((resolve) => { release = resolve; }); return { value: `found ${record.Domain}` }; });
		await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
		for (let i = 0; i < 100 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 2));
		grid.failSaves(1);
		release();
		for (let i = 0; i < 100 && !grid.runner.getSnapshot().halted.s; i++) await new Promise((resolve) => setTimeout(resolve, 2));
		// The pause outlasts the expiry rule: another viewer's recovery fails the marker as interrupted.
		grid.set(0, 'out', expiredCell(grid.cell(0, 'out'), Date.now() + STALLED_ENRICHMENT_MS)!);
	};
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 } }]);
	await pause(grid);
	grid.runner.resume('s');
	await settled(grid.runner);
	assert.deepEqual([grid.cell(0, 'out').s, grid.cell(0, 'out').v, grid.requests.length], ['done', 'found acme.com', 1], 'kept, not requested again');
	const edited = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 } }]);
	await pause(edited);
	edited.set(0, 'domain', { v: 'other.com', s: 'done', t: 2 });
	edited.runner.resume('s');
	await settled(edited.runner);
	assert.equal(edited.cell(0, 'out').s, 'error', 'a result for inputs that changed is never saved');
	assert.notEqual(edited.cell(0, 'out').v, 'found acme.com');
});

test('a timed-out request is never retried, even from a server that does not say why it failed', async () => {
	const grid = memory([source('domain', 'Domain'), ai('out', 'Out', search('{{Domain}}'))], [{ domain: { v: 'acme.com', s: 'done', t: 1 } }]);
	grid.answer(async () => { throw new ApiError('Gateway Timeout', 504); });
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	await settled(grid.runner);
	grid.answer(async () => ({ value: null, error: 'The provider timed out.' }));
	await grid.runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[1]]);
	await settled(grid.runner);
	assert.deepEqual([grid.requests.length, grid.cell(0, 'out').s, grid.cell(0, 'out').e], [2, 'error', 'The provider timed out.']);
});
