import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/lib/cell-content';
import { Runner, type RunnerPorts, type RunnerStore } from '../src/lib/runner';
import { cellState, columnStats, fillPercent } from '../src/lib/cell-state';
import { unpackableFields, unpackColumns } from '../src/lib/unpack';
import { ghostColumnOp, ghostColumns } from '../src/lib/next-steps';
import { createSheetCommands, type RunnerPort } from '../src/lib/sheet-commands';
import { quoteAsksFirst, quoteLabel, TRY_ROWS } from '../src/lib/run-cost';
import { runScopeChoice } from '../src/lib/run-scope';
import type { BatchResponse } from '../src/lib/batch-types';
import type { Cell, CellValue, Column, ColumnOp, EnrichResponse, Row, Sheet } from '../src/lib/types';

const source = (id: string, name: string): Column => ({ id, name, type: 'source', width: 180, createdAt: 0 });
const enriched = (id: string, name: string, op: ColumnOp): Column => ({ id, name, type: 'enriched', op, width: 180, createdAt: 0 });
const emailOp: ColumnOp = { kind: 'email-enrichment', name: '{{Name}}', company: '', domain: '{{Website}}', profileUrl: '', prefer: 'balanced' };

function memory(columns: Column[], cells: Array<Record<string, Cell>>) {
	const sheet: Sheet = { id: 's', name: 'S', columns, filters: [], sort: null, createdAt: 0, updatedAt: 0 };
	let rows: Row[] = cells.map((entry, order) => ({ id: `r${order}`, sheetId: 's', order, createdAt: 0, cells: entry }));
	const copy = () => structuredClone(rows);
	const store: RunnerStore = {
		sheet: async (id) => id === sheet.id ? structuredClone(sheet) : undefined,
		rows: async (id, rowIds) => id !== sheet.id ? [] : copy().filter((row) => !rowIds || rowIds.includes(row.id)),
		async updateCells(_id, changes) {
			const fresh = copy();
			const applied = changes.map(({ rowId, columnId, expected, update }) => {
				const row = fresh.find((entry) => entry.id === rowId);
				if (!row || canonicalJson(row.cells[columnId]) !== canonicalJson(expected)) return false;
				const next = update(structuredClone(sheet), fresh);
				if (next) row.cells[columnId] = next;
				return Boolean(next);
			});
			rows = fresh;
			return applied;
		},
	};
	return { sheet, store, rows: () => copy(), cell: (row: number, column: string) => rows[row].cells[column] };
}

async function settled(runner: Runner) {
	for (let i = 0; i < 500 && runner.getSnapshot().active; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	assert.equal(runner.getSnapshot().active, false, 'the queue settles');
}

const people = (count: number) => Array.from({ length: count }, (_, i) => ({ name: { v: `Person${i} Example`, s: 'done' as const, t: 1 }, site: { v: 'example.com', s: 'done' as const, t: 1 } }));

test('a retry of the same cell sends the same attempt and the cell address, so the server reuses its stored key', async () => {
	const grid = memory([source('name', 'Name'), source('site', 'Website'), enriched('email', 'Work email', emailOp)], people(1));
	const sent: Array<{ attempt?: string; cell?: unknown }> = [];
	let calls = 0;
	const ports: RunnerPorts = {
		store: grid.store, concurrency: () => 2, waitMs: 5,
		enrich: async (_op, _record, _signal, attempt, cell) => {
			sent.push({ attempt, cell });
			// The first answer is a rate limit refused before any work: retryable.
			return calls++ === 0 ? { value: null, error: 'rate limited', failure: { reason: 'rate_limited', retryable: true, provider: 'looot' } } : { value: 'person0@example.com' };
		},
	};
	const runner = new Runner(ports);
	(runner as unknown as { backoff: (task: { key: string }) => Promise<void> }).backoff = async function (this: Runner, task) {
		const self = this as unknown as { tasks: Map<string, unknown>; requeue: (task: unknown, attempts: number) => void };
		if (self.tasks.get(task.key) === task) self.requeue(task, 1);
	};
	await runner.enqueue(grid.sheet, grid.rows(), [grid.sheet.columns[2]]);
	await settled(runner);
	assert.equal(sent.length, 2);
	assert.equal(sent[0].attempt, sent[1].attempt, 'both attempts of one cell run carry the same attempt');
	assert.deepEqual(sent[0].cell, { sheetId: 's', rowId: 'r0', columnId: 'email' });
	assert.equal(grid.cell(0, 'email').v, 'person0@example.com');
});

test('a batch column continues an incomplete looot batch with the same key, filling cells as rows settle', async () => {
	const grid = memory([source('name', 'Name'), source('site', 'Website'), enriched('email', 'Work email', emailOp)], people(12));
	const keys: string[] = [];
	const ports: RunnerPorts = {
		store: grid.store, concurrency: () => 2, waitMs: 5, batchPollMs: 1,
		enrich: async () => { throw new Error('a batch column never runs cell by cell'); },
		batch: async (_op, rows, key): Promise<BatchResponse> => {
			keys.push(key);
			const first = keys.filter((entry) => entry === key).length === 1;
			const answered = rows.map((row, index) => first && index >= 8 ? { rowId: row.rowId, pending: true as const } : { rowId: row.rowId, response: { value: index % 4 === 3 ? null : `${String(row.record.Name).split(' ')[0].toLowerCase()}@example.com`, meta: { costUsd: 0.01 } } as EnrichResponse });
			return { complete: !first, rows: answered, tally: { hits: 0, weak: 0, misses: 0, errors: 0, pending: 0, chargedUsd: 0, byProvider: {} } };
		},
	};
	const runner = new Runner(ports);
	assert.equal(await runner.enqueueBatch('s', grid.rows(), grid.sheet.columns[2]), 12);
	await settled(runner);
	assert.equal(keys.length, 2, 'one call, then one continuation');
	assert.equal(keys[0], keys[1], 'the continuation resends the same key');
	assert.equal(grid.cell(0, 'email').v, 'person0@example.com');
	assert.equal(grid.cell(11, 'email').s, 'done');
	const tally = runner.getSnapshot().batches.s.email;
	assert.deepEqual({ total: tally.total, settled: tally.settled, hits: tally.hits, misses: tally.misses }, { total: 12, settled: 12, hits: 9, misses: 3 });
	assert.equal(tally.chargedUsd, 0.12);

	// Running the same rows again (after a reload) derives the same key, so looot replays instead of charging again.
	const again = memory([source('name', 'Name'), source('site', 'Website'), enriched('email', 'Work email', emailOp)], people(12));
	const replayKeys: string[] = [];
	const replay = new Runner({ ...ports, store: again.store, batch: async (op, rows, key, cell, signal) => { replayKeys.push(key); return ports.batch!(op, rows, key, cell, signal); } });
	await replay.enqueueBatch('s', again.rows(), again.sheet.columns[2]);
	await settled(replay);
	assert.equal(replayKeys[0], keys[0]);
});

test('a refused batch (sheet cap) gives the cells back untouched and pauses the sheet', async () => {
	const grid = memory([source('name', 'Name'), source('site', 'Website'), enriched('email', 'Work email', emailOp)], people(3));
	const runner = new Runner({ store: grid.store, concurrency: () => 2, waitMs: 5, enrich: async () => ({ value: null }), batch: async () => ({ complete: true, rows: [], tally: { hits: 0, weak: 0, misses: 0, errors: 0, pending: 0, chargedUsd: 0, byProvider: {} }, refused: { value: null, error: 'This sheet’s spend cap is $1.00', failure: { reason: 'spend_capped', retryable: false, provider: 'looot' } } }) });
	await runner.enqueueBatch('s', grid.rows(), grid.sheet.columns[2]);
	await settled(runner);
	assert.equal(runner.getSnapshot().halted.s?.reason, 'spend_capped');
	assert.equal(grid.cell(0, 'email')?.s ?? 'idle', 'idle', 'the cell is as it was');
});

test('unpacking a company column fills sibling columns from stored answers at $0: nothing is queued or run', async () => {
	const company: ColumnOp = { kind: 'company', domain: '{{Website}}', field: 'description' };
	const data = { name: 'Example Co', industry: 'Payments', employees: 120, city: 'New York', country: 'US', funding_total: 32_000_000, funding_stage: 'Series B' };
	const columns = [source('site', 'Website'), enriched('co', 'Company info', company)];
	const rows: Row[] = [0, 1].map((order) => ({ id: `r${order}`, sheetId: 's', order, createdAt: 0, cells: { site: { v: 'example.com', s: 'done', t: 1 }, co: { v: 'Builds payments software', s: 'done', t: 1, m: { costUsd: 0.0019, companyIntel: { domain: 'example.com', source: 'brand', data: { data } } } } } }));
	const fields = unpackableFields(columns[1], rows);
	assert.deepEqual(fields.map((field) => field.name), ['Industry', 'Headcount', 'HQ', 'Funding', 'Stage']);
	let next = 0;
	const { columns: added, cells } = unpackColumns(columns[1], rows, fields, (field) => ({ id: `u${next++}`, name: field.name, type: 'source', width: 140, createdAt: 0 }));
	assert.ok(added.every((column) => column.type === 'source' && !column.op), 'unpacked columns are plain values');
	assert.equal(cells.find((cell) => cell.columnId === 'u1' && cell.rowId === 'r0')?.cell.v, 120);
	assert.equal(cells.find((cell) => cell.columnId === 'u2')?.cell.v, 'New York');
	assert.ok(cells.every((cell) => cell.cell.m?.costUsd === undefined), 'no unpacked cell carries a cost');

	const enqueued: unknown[] = [];
	const port = { owner: 'tab', subscribe: () => () => {}, getSnapshot: () => ({ bySheet: {}, halted: {} }), isPending: () => false, enqueue: async (...args: unknown[]) => { enqueued.push(args); return 0; }, enqueueBatch: async (...args: unknown[]) => { enqueued.push(args); return 0; }, cancel: async () => {}, supersede: async () => [], resume: () => {}, retryFailed: async () => 0 } satisfies RunnerPort;
	const commands = createSheetCommands('s', { runner: port, track: () => {} });
	const filled = rows.map((row) => ({ ...row, cells: { ...row.cells, ...Object.fromEntries(cells.filter((cell) => cell.rowId === row.id).map((cell) => [cell.columnId, cell.cell])) } }));
	const plan = commands.plan(filled, added, 'all', { ready: () => true, grid: { sheet: { id: 's', name: 'S', columns: [...columns, ...added], filters: [], sort: null, createdAt: 0, updatedAt: 0 }, rows: filled } });
	assert.equal(plan.kind, 'nothing', 'there is nothing to run in an unpacked column');
	assert.equal(enqueued.length, 0);
});

test('next-step ghost columns gather looot suggestions per job and become columns that wait for a click to run', () => {
	const columns = [source('name', 'Name'), source('site', 'Website'), enriched('email', 'Work email', emailOp)];
	const step = (email: string) => ({ suggestionId: 'ns_0123456789abcdef', job: 'people.email.verify', title: 'Verify email', priceUsd: 0.0019, input: { email } });
	const rows: Row[] = [0, 1, 2].map((order) => ({ id: `r${order}`, sheetId: 's', order, createdAt: 0, cells: { site: { v: 'example.com', s: 'done', t: 1 }, email: { v: `p${order}@example.com`, s: 'done', t: 1, m: { looot: [{ runId: `run${order}`, outcome: 'hit', costUsd: 0.004, nextSteps: [step(`p${order}@example.com`), { job: 'company.technographics', title: 'Tech stack', priceUsd: 0.012, input: { domain: 'example.com' } }] }] } } } }));
	const ghosts = ghostColumns(columns, rows);
	assert.deepEqual(ghosts.map((ghost) => [ghost.job, ghost.priceUsd, ghost.rows]), [['people.email.verify', 0.0019, 3], ['company.technographics', 0.012, 3]]);
	const verify = ghostColumnOp(ghosts[0], columns);
	assert.deepEqual(verify.op, { kind: 'email-verify', email: '{{Work email}}', prefer: 'balanced' });
	const tech = ghostColumnOp(ghosts[1], columns);
	assert.equal(tech.op.kind, 'looot');
	assert.deepEqual(tech.op.kind === 'looot' && tech.op.inputs, { domain: '{{Website}}' }, 'the suggested input maps back to the column holding it');
	// A job the sheet already runs is not suggested again.
	assert.equal(ghostColumns([...columns, enriched('v', 'Email status', verify.op)], rows).some((ghost) => ghost.job === 'people.email.verify'), false);
});

test('cell states, fill and the quote rules the Run button uses', () => {
	const column = enriched('email', 'Work email', emailOp);
	assert.equal(cellState({ v: 'a@example.com', s: 'done', t: 1, m: { verification: 'valid' } }, column), 'hit');
	assert.equal(cellState({ v: 'a@example.com', s: 'done', t: 1, m: { verification: 'catch_all' } }, column), 'weak');
	assert.equal(cellState({ v: null, s: 'done', t: 1 }, column), 'miss');
	assert.equal(cellState({ v: null, s: 'error', e: 'x', t: 1 }, column), 'error');
	assert.equal(cellState({ v: null, s: 'running', t: 1 }, column), 'running');
	assert.equal(cellState({ v: 'old', s: 'done', t: 1 }, column, true), 'stale');
	assert.equal(cellState({ v: 'typed', s: 'done', t: 1 }, source('n', 'Name')), undefined);
	const stats = columnStats(column, [{ cells: { email: { v: 'a@example.com', s: 'done', t: 1, m: { costUsd: 0.01 } } } }, { cells: { email: { v: null, s: 'done', t: 1, m: { costUsd: 0.002 } } } }, { cells: {} }]);
	assert.deepEqual(stats, { rows: 3, settled: 2, filled: 1, running: 0, costUsd: 0.012 });
	assert.equal(fillPercent(stats), '50%');
	assert.equal(quoteLabel({ cells: 25, maxUsd: 0.11 }), 'Run 25 rows · up to $0.11');
	assert.equal(quoteAsksFirst({ cells: 25, maxUsd: 0.11 }), false);
	assert.equal(quoteAsksFirst({ cells: 51, maxUsd: 0.11 }), true);
	assert.equal(quoteAsksFirst({ cells: 5, maxUsd: 0.51 }), true);
	assert.equal(runScopeChoice(TRY_ROWS, 40, 40, 1).label, 'Try 5 rows');
});
