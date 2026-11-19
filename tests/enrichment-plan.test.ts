import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/lib/cell-content';
import { enrichmentIsOutdated, inputFingerprint, inputRecord } from '../src/lib/enrichment-freshness';
import { CYCLE_MESSAGE, expiredCell, failureCell, planCell, readsWholeSheet, renameColumn, resultCell, settleCell, startCell, STALLED_ENRICHMENT_MS, type PlanContext } from '../src/lib/enrichment-plan';
import { opDependencies, readsRowContext, renameOpReferences, sameName, shiftColumnReferences } from '../src/lib/references';
import { describeRow } from '../src/lib/template';
import type { Cell, Column, ColumnOp, Row, Sheet } from '../src/lib/types';

const NOW = 1_000_000_000;
const OLD = NOW - STALLED_ENRICHMENT_MS;
const source = (id: string, name: string, extra: Partial<Column> = {}): Column => ({ id, name, type: 'source', width: 180, createdAt: 0, ...extra });
const ai = (id: string, name: string, op: ColumnOp, extra: Partial<Column> = {}): Column => ({ id, name, type: 'enriched', op, width: 180, createdAt: 0, ...extra });
const template = (text: string): ColumnOp => ({ kind: 'template', template: text });
const sheetOf = (columns: Column[]): Sheet => ({ id: 's', name: 'S', columns, filters: [], sort: null, createdAt: 0, updatedAt: 0 });
const rowOf = (id: string, order: number, cells: Record<string, Cell>): Row => ({ id, sheetId: 's', order, createdAt: 0, cells });
const done = (v: Cell['v'], t = 1): Cell => ({ v, s: 'done', t });
type MutableGrid = { sheet: Sheet; rows: Row[] };
const aiCells = (grid: MutableGrid) => grid.rows.flatMap((row) => grid.sheet.columns.filter((column) => column.type === 'enriched').map((column) => ({ rowId: row.id, columnId: column.id })));
const withCell = (grid: MutableGrid, rowId: string, columnId: string, cell: Cell): MutableGrid => ({ ...grid, rows: grid.rows.map((row) => row.id === rowId ? { ...row, cells: { ...row.cells, [columnId]: cell } } : row) });
const withColumns = (grid: MutableGrid, columns: Column[]): MutableGrid => ({ ...grid, sheet: { ...grid.sheet, columns } });

/** "Run unfinished" in memory: every AI cell not holding a current result runs once, in sheet order, and answers with
    what the model was shown. Returns the grid and how many cells ran. */
function runUnfinished(grid: MutableGrid, at = 10) {
	let ran = 0;
	for (const target of aiCells(grid)) {
		const plan = planCell(grid, target)!;
		if (plan.complete || plan.readiness.kind !== 'ready') continue;
		grid = withCell(grid, target.rowId, target.columnId, resultCell(plan, describeRow(plan.record) || 'nothing', undefined, at));
		ran++;
	}
	return { grid, ran };
}

/** How results were fingerprinted before inputs were keyed by column ID: the operation as written, and the record by
    name (all of it when the operation reads its row). */
function v1Fingerprint(grid: MutableGrid, rowId: string, columnId: string): string {
	const { op } = grid.sheet.columns.find((column) => column.id === columnId)!;
	const record = inputRecord(grid.sheet.columns, grid.rows, grid.rows.findIndex((row) => row.id === rowId), op!, columnId);
	const entries = Object.entries(record).filter(([name]) => readsRowContext(op!) || opDependencies(op!).some((ref) => sameName(ref, name)));
	return inputFingerprint(canonicalJson({ op, record: Object.fromEntries(entries) })!).replace(/^v2:/, 'v1:');
}

test('one readiness verdict for every dependency state', () => {
	const name = source('name', 'Name'), domain = ai('domain', 'Domain', template('{{Name}}.com')), out = ai('out', 'Out', template('{{Domain}}'));
	const sheet = sheetOf([name, domain, out]);
	const cases: Array<{ label: string; dependency?: Cell; context?: PlanContext; verdict: string; message?: string }> = [
		{ label: 'done', dependency: done('acme.com'), verdict: 'ready' },
		{ label: 'done with no answer', dependency: done(null), verdict: 'ready' },
		{ label: 'never ran', verdict: 'waiting:unrun', message: 'Waiting on "Domain", which hasn’t run yet. Run it first.' },
		{ label: 'cleared', dependency: { v: null, s: 'idle', t: 5 }, verdict: 'waiting:unrun' },
		{ label: 'running elsewhere', dependency: { v: null, s: 'running', t: NOW - 1 }, verdict: 'waiting:started', message: 'Waiting on "Domain", which is still running' },
		{ label: 'queued in this tab', dependency: done('acme.com'), context: { pending: (_row, column) => column === 'domain' }, verdict: 'waiting:started' },
		{ label: 'abandoned run', dependency: { v: 'acme.com', s: 'running', t: OLD }, verdict: 'failed', message: 'Waiting on "Domain", which failed' },
		{ label: 'abandoned queue with a previous value', dependency: { v: 'acme.com', s: 'queued', t: OLD }, verdict: 'ready' },
		{ label: 'failed', dependency: { v: null, s: 'error', e: 'Nope', t: 1 }, verdict: 'failed' },
	];
	for (const { label, dependency, context, verdict, message } of cases) {
		const row = rowOf('r', 0, { name: done('Acme'), ...(dependency ? { domain: dependency } : {}) });
		const { readiness, dependencies } = planCell({ sheet, rows: [row] }, { rowId: 'r', columnId: 'out' }, { now: NOW, ...context })!;
		const actual = readiness.kind === 'waiting' ? `waiting:${readiness.started ? 'started' : 'unrun'}` : readiness.kind;
		assert.equal(actual, verdict, label);
		if (message) assert.equal('message' in readiness && readiness.message, message, label);
		assert.deepEqual(dependencies.map((dep) => dep.column.id), ['domain'], label);
	}
});

test('dangling references and cycles are verdicts too', () => {
	const cases: Array<{ label: string; columns: Column[]; cells?: Record<string, Cell>; target: string; verdict: string; message?: string }> = [
		{ label: 'deleted name', columns: [ai('out', 'Out', template('{{Domain}} {{#REF!}}'))], target: 'out', verdict: 'dangling', message: '{{Domain}}, {{#REF!}} don’t match any column. Edit this column to fix it.' },
		{ label: 'mutual cycle', columns: [ai('a', 'A', template('{{B}}')), ai('b', 'B', template('{{A}}'))], target: 'a', verdict: 'cycle', message: CYCLE_MESSAGE },
		{ label: 'self reference', columns: [ai('a', 'A', template('{{A1}}'))], target: 'a', verdict: 'cycle' },
		{ label: 'a cycle broken by a done cell still runs', columns: [ai('a', 'A', template('{{B}}')), ai('b', 'B', template('{{A}}'))], cells: { b: done('x') }, target: 'a', verdict: 'ready' },
		{ label: 'downstream of a cycle waits', columns: [ai('a', 'A', template('{{B}}')), ai('b', 'B', template('{{A}}')), ai('c', 'C', template('{{A}}'))], target: 'c', verdict: 'waiting' },
		{ label: 'a later row of the same column is no cycle', columns: [ai('a', 'A', template('{{A2}}'))], target: 'a', verdict: 'waiting' },
	];
	for (const { label, columns, cells = {}, target, verdict, message } of cases) {
		const rows = [rowOf('r1', 0, cells), rowOf('r2', 1, {})];
		const { readiness } = planCell({ sheet: sheetOf(columns), rows }, { rowId: 'r1', columnId: target }, { now: NOW })!;
		assert.equal(readiness.kind, verdict, label);
		if (message) assert.equal('message' in readiness && readiness.message, message, label);
	}
});

test('plans read the catalog, send a record without the cell’s own value, and say which rows they need', () => {
	const name = source('name', 'Name'), notes = source('notes', 'Notes');
	const research = ai('research', 'Research', { kind: 'answer', task: 'About {{Name}}', output: 'text', mode: 'fast' });
	const draft = ai('draft', 'Draft', { kind: 'email-draft', mode: 'template', prompt: '', to: '', cc: '', bcc: '', subject: 'Hi {{Name}}', body: '{{A$1}}' });
	const sheet = sheetOf([name, notes, research, draft]);
	const rows = [rowOf('r1', 0, { name: done('Ada'), research: done('Old answer') }), rowOf('r2', 1, { name: done('Grace') })];
	const plan = planCell({ sheet, rows }, { rowId: 'r1', columnId: 'research' })!;
	assert.deepEqual([plan.local, plan.providers, plan.worstCaseMs, plan.complete, plan.inPlace], [false, [['context']], 130_000, true, false]);
	assert.equal(plan.record.Research, null, 'a rerun never reads its previous answer');
	assert.equal(plan.record.Name, 'Ada');
	assert.doesNotMatch(plan.version, /Old answer/, 'nor is it an input');
	const local = planCell({ sheet, rows }, { rowId: 'r2', columnId: 'draft' })!;
	assert.deepEqual([local.local, local.providers, local.index, local.record.A$1], [true, [], 1, 'Ada']);
	assert.equal(readsWholeSheet(sheet, 'research'), false);
	assert.equal(readsWholeSheet(sheet, 'draft'), true);
	assert.equal(readsWholeSheet(sheetOf([ai('a', 'A', template('{{B}}')), ai('b', 'B', template('{{A}}'))]), 'a'), true, 'cycles can pass through other rows');
	assert.equal(planCell({ sheet, rows }, { rowId: 'r1', columnId: 'notes' }), undefined, 'source columns compute nothing');
	assert.equal(planCell({ sheet, rows }, { rowId: 'gone', columnId: 'research' }), undefined);
});

test('the expiry rule is shared: abandoned runs fail as interrupted, abandoned queues get their value back', () => {
	const cases: Array<[Cell, Cell | undefined]> = [
		[{ v: 'kept', s: 'running', t: OLD }, { v: 'kept', s: 'error', e: 'This run timed out or was interrupted. Run this cell again.', t: NOW }],
		[{ v: 'kept', s: 'queued', t: OLD }, { v: 'kept', s: 'done', t: NOW }],
		[{ v: null, s: 'queued', t: OLD }, { v: null, s: 'idle', t: NOW }],
		[{ v: 'kept', s: 'running', t: OLD + 1 }, undefined],
		[{ v: 'kept', s: 'done', t: 0 }, undefined],
	];
	for (const [cell, expired] of cases) assert.deepEqual(expiredCell(cell, NOW), expired, JSON.stringify(cell));
	const sheet = sheetOf([ai('out', 'Out', template('x'))]);
	const plan = (cell: Cell) => planCell({ sheet, rows: [rowOf('r', 0, { out: cell })] }, { rowId: 'r', columnId: 'out' }, { now: NOW })!;
	assert.equal(plan({ v: 'kept', s: 'running', t: NOW - 1 }).busy, true);
	assert.equal(plan({ v: 'kept', s: 'running', t: OLD }).busy, false);
	assert.deepEqual(startCell(plan({ v: 'kept', s: 'running', t: OLD }), 'tab', NOW), { v: 'kept', s: 'running', owner: 'tab', t: NOW });
});

test('results are stamped, admitted to the current format, and kept only while the rule and inputs are unchanged', () => {
	const name = source('name', 'Name'), out = ai('out', 'Out', template('{{Name}}'), { format: 'percent' });
	const previous: Cell = { v: 0.5, s: 'done', m: { reasoning: 'Earlier' }, t: 1 };
	const grid = (columns: Column[], value: string) => ({ sheet: sheetOf(columns), rows: [rowOf('r', 0, { name: done(value), out: previous })] });
	const plan = planCell(grid([name, out], 'Ada'), { rowId: 'r', columnId: 'out' })!;
	const marker = startCell(plan, undefined, 2);
	assert.deepEqual(marker, { v: 0.5, m: { reasoning: 'Earlier' }, s: 'running', t: 2 });
	const result = resultCell(plan, '42%', { sources: ['https://example.com'] }, 3);
	assert.deepEqual(result, { v: '42%', s: 'done', m: { sources: ['https://example.com'], inputFingerprint: inputFingerprint(plan.version) }, t: 3 });
	assert.deepEqual(settleCell(plan, grid([name, out], 'Ada'), result, marker), { outcome: 'applied', cell: { ...result, v: 0.42 } });
	const stale = settleCell(plan, grid([name, out], 'Grace'), result, marker);
	assert.deepEqual({ ...stale, cell: { ...stale.cell, t: 0 } }, { outcome: 'stale', cell: { v: 0.5, m: { reasoning: 'Earlier' }, s: 'error', e: 'Inputs or instructions changed during enrichment. Run this cell again.', t: 0 } }, 'a stale re-run keeps the previous value');
	const superseded = settleCell(plan, grid([name, { ...out, op: template('{{Name}}!') }], 'Ada'), result, marker);
	assert.deepEqual({ ...superseded, cell: { ...superseded.cell, t: 1 } }, { outcome: 'superseded', cell: previous }, 'a new rule restores the previous value');
	assert.deepEqual(failureCell(plan, 'Rate limited', { credits: 1 }, 4, marker), { v: 0.5, m: { reasoning: 'Earlier' }, s: 'error', e: 'Rate limited', t: 4 }, 'a failed re-run keeps the previous value');
	assert.deepEqual(failureCell(plan, 'Rate limited', { credits: 1 }, 4, startCell(planCell({ sheet: sheetOf([name, out]), rows: [rowOf('r', 0, { name: done('Ada') })] }, { rowId: 'r', columnId: 'out' })!)), { v: null, s: 'error', e: 'Rate limited', m: { credits: 1 }, t: 4 });
	const refused = settleCell(plan, grid([name, out], 'Ada'), resultCell(plan, 'not a percentage', undefined, 3), marker);
	assert.deepEqual([refused.cell.v, refused.cell.s, refused.cell.m], [0.5, 'error', { reasoning: 'Earlier' }], 'an answer the format refuses keeps the previous value');
});

test('a source person-name column is enriched in place: the name stays, the match adds its photo', () => {
	const name = source('name', 'Name'), company = source('company', 'Company'), linkedIn = source('linkedin', 'LinkedIn', { format: 'url' });
	const sheet = sheetOf([name, company, linkedIn]);
	const grid = (cell: Cell, companyName = 'Notra') => ({ sheet, rows: [rowOf('r', 0, { name: cell, company: done(companyName), linkedin: done('https://linkedin.com/in/dk') })] });
	const plan = planCell(grid(done('Dominik Koch')), { rowId: 'r', columnId: 'name' })!;
	assert.equal(plan.inPlace, true);
	assert.deepEqual(plan.op, { kind: 'person', field: 'full_name', name: '{{Name}}', company: '{{Company}}', email: undefined, profileUrl: '{{LinkedIn}}' });
	assert.equal(plan.record.Name, 'Dominik Koch', 'the name is the input');
	assert.equal(plan.complete, false, 'a name without a match is not complete');
	assert.equal(plan.readiness.kind, 'ready');
	const marker = startCell(plan, undefined, 2);
	const matched = resultCell(plan, 'Dominik K.', { person: { name: 'Dominik K.', avatarUrl: 'https://cdn.example/dk.png' } }, 3);
	assert.equal(matched.v, 'Dominik Koch');
	assert.deepEqual(matched.m?.person, { name: 'Dominik Koch', avatarUrl: 'https://cdn.example/dk.png' });
	assert.equal(planCell(grid(matched), { rowId: 'r', columnId: 'name' })!.complete, true);
	assert.deepEqual(failureCell(plan, 'Rate limited', undefined, 4), { v: 'Dominik Koch', s: 'error', e: 'Rate limited', t: 4 });
	const stale = settleCell(plan, grid(marker, 'Other'), matched, marker);
	assert.deepEqual([stale.outcome, stale.cell.v, stale.cell.s], ['stale', 'Dominik Koch', 'done'], 'a stale match never erases the name');
});

test('fingerprints saved before inputs were keyed by column ID still read as current', () => {
	// Saved by the previous implementation; their keys sort by code unit, not locale.
	const columns: Column[] = [
		source('a', 'apple'), source('b', 'Banana'), source('z', 'Zeta'), source('u', '_x'),
		ai('ai', 'Ask', { kind: 'ai', prompt: 'About {{apple}}', output: 'text', research: 'none' }),
		ai('se', 'Search', { kind: 'search', query: '{{Banana}} {{Zeta}}', pick: 'url', numResults: 3 }),
		ai('tp', 'Range', template('{{A$1}} / {{$B$1:$C$2}} / {{_x}}')),
		ai('an', 'Research', { kind: 'answer', task: 'Latest news', output: 'text', mode: 'fast' }),
	];
	const rows = [0, 1].map((order) => rowOf(`r${order}`, order, {
		a: done(`apple ${order}`), b: done(['x', 'y']), z: done(order), u: done(true), ai: done('old'), se: { v: null, s: 'error', e: 'x', t: 1 },
	}));
	const saved: Record<string, string> = {
		'r0:ai': 'v1:194a60635903ce31', 'r0:se': 'v1:24022f41bb59932a', 'r0:tp': 'v1:1b47c7df1505853a', 'r0:an': 'v1:3a5062ada2a32f2f',
		'r1:ai': 'v1:cf4c93072cef89b2', 'r1:se': 'v1:897b1c7c02b1ae3b', 'r1:tp': 'v1:1b47c7df1505853a', 'r1:an': 'v1:7d2579e51291ebe5',
	};
	const later = [source('n', 'Notes', { createdAt: 5 }), ai('k', 'Check', { kind: 'check', question: 'B2B?', decider: 'openai', threshold: 0.5 }, { createdAt: 5 })];
	for (const [key, inputFingerprint] of Object.entries(saved)) {
		const [rowId, columnId] = key.split(':');
		const grid = withCell({ sheet: sheetOf(columns), rows }, rowId, columnId, { v: 'old', s: 'done', m: { inputFingerprint }, t: 1 });
		assert.equal(planCell(grid, { rowId, columnId })!.complete, true, key);
		const added = withCell(withColumns(grid, [...columns, ...later]), rowId, 'k', done('yes', 6));
		assert.equal(planCell(added, { rowId, columnId })!.complete, true, `${key}: columns added since, one of them answered`);
		assert.equal(planCell(withCell(added, rowId, 'n', done('filled', 6)), { rowId, columnId })!.complete, !readsRowContext(columns.find((column) => column.id === columnId)!.op!), `${key}: a value in an added source column is a new input to a whole-row run`);
	}
});

test('no saved result becomes outdated by the upgrade, and a rename upgrades its fingerprint', () => {
	const company = source('company', 'Company'), notes = source('notes', 'Notes');
	const columns = [company, notes,
		ai('ask', 'Ask', { kind: 'ai', prompt: 'Who runs {{Company}}?', output: 'text', research: 'none' }),
		ai('check', 'Check', { kind: 'check', question: 'Is it B2B?', decider: 'openai', threshold: 0.5 }),
		ai('search', 'Search', { kind: 'search', query: '{{Company}}', pick: 'url', numResults: 1 }),
		ai('range', 'Range', template('{{A$1}}-{{B1}}')),
	];
	const answered = (row: Row) => ({ ...row, cells: { ...row.cells, ...Object.fromEntries(columns.filter((column) => column.op).map((column) => [column.id, done('answer', 2)])) } });
	let saved: MutableGrid = { sheet: sheetOf(columns), rows: [rowOf('r1', 0, { company: done('Acme'), notes: done('') }), rowOf('r2', 1, { company: done('Globex'), notes: done('Big') })].map(answered) };
	// Every result current, as the previous implementation saw it.
	for (const [{ rowId, columnId }, inputFingerprint] of aiCells(saved).map((target) => [target, v1Fingerprint(saved, target.rowId, target.columnId)] as const)) saved = withCell(saved, rowId, columnId, { v: 'answer', s: 'done', m: { inputFingerprint }, t: 2 });
	const scenarios: Array<[string, (grid: MutableGrid) => MutableGrid]> = [
		['unchanged', (grid) => grid],
		['a blank column added', (grid) => withColumns(grid, [...grid.sheet.columns, source('blank', 'Blank', { createdAt: 3 })])],
		['an AI column added and run', (grid) => withCell(withColumns(grid, [...grid.sheet.columns, ai('new', 'New', template('{{Notes}}'), { createdAt: 3 })]), 'r1', 'new', done('x', 4))],
		['a source column added and filled', (grid) => withCell(withColumns(grid, [...grid.sheet.columns, source('filled', 'Filled', { createdAt: 3 })]), 'r1', 'filled', done('x', 4))],
		['an unreferenced value edited', (grid) => withCell(grid, 'r1', 'notes', done('Small', 4))],
		['a referenced value edited', (grid) => withCell(grid, 'r2', 'company', done('Initech', 4))],
		['a column moved to the end', (grid) => withColumns(grid, [...grid.sheet.columns.slice(1), grid.sheet.columns[0]])],
	];
	for (const [label, change] of scenarios) {
		const after = change(saved);
		for (const target of aiCells(saved)) {
			const cell = after.rows.find((row) => row.id === target.rowId)!.cells[target.columnId];
			const wasCurrent = cell.m?.inputFingerprint === v1Fingerprint(after, target.rowId, target.columnId);
			if (wasCurrent) assert.equal(planCell(after, target)!.complete, true, `${label}: ${target.rowId}:${target.columnId}`);
		}
	}
	assert.deepEqual(aiCells(saved).filter((target) => !planCell(scenarios[1][1](saved), target)!.complete), [], 'a blank column outdates nothing');
	const renamed = renameColumn(saved, 'company', 'Organization');
	for (const target of aiCells(saved)) {
		assert.equal(planCell(renamed, target)!.complete, true, `renamed: ${target.rowId}:${target.columnId}`);
		assert.match(renamed.rows.find((row) => row.id === target.rowId)!.cells[target.columnId].m!.inputFingerprint!, /^v2:/);
	}
});

test('a v1 result stays current when an AI column it does not reference is answered after it', () => {
	const ask = ai('ask', 'Ask', { kind: 'ai', prompt: 'Who runs it?', output: 'text', research: 'none' });
	const check = ai('check', 'Check', { kind: 'check', question: 'Is it B2B?', decider: 'openai', threshold: 0.5 });
	// Saved by the previous implementation at t=2 over { Company: 'Acme', Ask: null, Check: null }.
	const saved: Cell = { v: 'Ada', s: 'done', m: { inputFingerprint: 'v1:52c2c6d45a39a5dc' }, t: 2 };
	const grid = (cells: Record<string, Cell>) => ({ sheet: sheetOf([source('company', 'Company'), ask, check]), rows: [rowOf('r', 0, { company: done('Acme'), ask: saved, ...cells })] });
	const complete = (cells: Record<string, Cell> = {}) => planCell(grid(cells), { rowId: 'r', columnId: 'ask' })!.complete;
	assert.equal(complete(), true);
	assert.equal(complete({ check: done(true, 3) }), true, 'Check was blank when Ask ran');
	assert.equal(complete({ check: done(true, 1) }), false, 'Check answered before Ask ran was part of what it read');
	assert.equal(complete({ check: done(true, 3), company: done('Globex') }), false, 'source values are still compared exactly');
	assert.equal(planCell(grid({ check: done(true, 3) }), { rowId: 'r', columnId: 'ask' })!.outdated, false);
});

test('fingerprints are keyed by what a run reads, and their shape never changes', () => {
	const columns = [
		source('a', 'apple'), source('b', 'Banana'), source('e', 'Empty'),
		ai('ai', 'Ask', { kind: 'ai', prompt: 'About {{apple}}', output: 'text', research: 'none' }),
		ai('se', 'Search', { kind: 'search', query: '{{Banana}} {{Ask}}', pick: 'url', numResults: 3 }),
		ai('tp', 'Range', template('{{A$1}} / {{$B$1:$C$2}}')),
	];
	const rows = [0, 1].map((order) => rowOf(`r${order}`, order, { a: done(`apple ${order}`), b: done(['x', 'y']), e: done(''), ai: done('old') }));
	const grid = { sheet: sheetOf(columns), rows };
	assert.equal(planCell(grid, { rowId: 'r0', columnId: 'ai' })!.version, '{"inputs":{"a":"apple 0","b":["x","y"]},"op":{"kind":"ai","output":"text","prompt":"About {{a}}","research":"none"}}');
	assert.equal(planCell(grid, { rowId: 'r1', columnId: 'tp' })!.version, '{"inputs":{"$[b]$1:$[e]$2":"x, y\\t\\nx, y\\t","[a]$1:[a]$1":"apple 0"},"op":{"kind":"template","template":"{{[a]$1:[a]$1}} / {{$[b]$1:$[e]$2}}"}}');
	const expected: Record<string, string> = { 'r0:ai': 'v2:a2306b41579d9c71', 'r0:se': 'v2:e2fd00bf367224ed', 'r1:tp': 'v2:c9e02851a92b0022' };
	for (const [key, fingerprint] of Object.entries(expected)) {
		const [rowId, columnId] = key.split(':');
		assert.equal(inputFingerprint(planCell(grid, { rowId, columnId })!.version), fingerprint, key);
	}
});

test('staleness finds a row’s position in constant time', () => {
	const name = source('name', 'Name'), out = ai('out', 'Out', { kind: 'search', query: '{{Name}}', pick: 'url', numResults: 1 });
	const sheet = sheetOf([name, out]);
	const plain = Array.from({ length: 2000 }, (_, i) => rowOf(`r${i}`, i, { name: done(`n${i}`) }));
	for (const row of plain) row.cells.out = resultCell(planCell({ sheet, rows: plain }, { rowId: row.id, columnId: 'out' })!, 'x', undefined, 2);
	let reads = 0;
	const rows = new Proxy(plain, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
	assert.equal(enrichmentIsOutdated(sheet, rows, plain[0], 'out'), false);
	reads = 0;
	for (const row of plain.slice(1000, 1100)) assert.equal(enrichmentIsOutdated(sheet, rows, row, 'out'), false);
	assert.ok(reads <= 100 * 4, `${reads} row reads for 100 cells`);
});

test('AI columns that read their row converge: running unfinished cells twice runs nothing the second time', () => {
	const cases: Array<[string, Column[]]> = [
		['ask AI and a check', [ai('ask', 'Ask', { kind: 'ai', prompt: 'Who runs it?', output: 'text', research: 'none' }), ai('check', 'Check', { kind: 'check', question: 'Is it B2B?', decider: 'openai', threshold: 0.5 })]],
		['classify, score and research', [
			ai('kind', 'Kind', { kind: 'classify', question: 'Which industry?', options: [{ label: 'SaaS' }, { label: 'Retail' }], decider: 'openai' }),
			ai('fit', 'Fit', { kind: 'score', question: 'How good a fit?', levels: ['Low', 'High'], decider: 'openai' }),
			ai('news', 'News', { kind: 'answer', task: 'Latest funding', output: 'text', mode: 'fast' }),
		]],
		['an AI email draft and the AI answer it references', [ai('ask', 'Ask', { kind: 'ai', prompt: 'Who runs it?', output: 'text', research: 'none' }), ai('mail', 'Mail', { kind: 'email-draft', mode: 'ai', prompt: 'Write to {{Ask}}', to: '', cc: '', bcc: '', subject: '', body: '' })]],
	];
	for (const [label, columns] of cases) {
		const first = runUnfinished({ sheet: sheetOf([source('company', 'Company'), source('notes', 'Notes'), ...columns]), rows: [rowOf('r1', 0, { company: done('Acme') }), rowOf('r2', 1, { company: done('Globex'), notes: done('Big') })] });
		assert.equal(first.ran, columns.length * 2, label);
		assert.equal(runUnfinished(first.grid).ran, 0, `${label}: the second run plans nothing`);
	}
});

test('a whole-row run’s inputs are its row’s source values and the AI answers it references', () => {
	const company = source('company', 'Company'), notes = source('notes', 'Notes');
	const columns = [company, notes,
		ai('ask', 'Ask', { kind: 'ai', prompt: 'Who runs {{Company}}?', output: 'text', research: 'none' }),
		ai('check', 'Check', { kind: 'check', question: 'Is it B2B?', decider: 'openai', threshold: 0.5 }),
		ai('summary', 'Summary', { kind: 'ai', prompt: 'Summarize {{Ask}}', output: 'text', research: 'none' }),
		ai('search', 'Search', { kind: 'search', query: '{{Company}}', pick: 'url', numResults: 1 }),
	];
	const { grid } = runUnfinished({ sheet: sheetOf(columns), rows: [rowOf('r', 0, { company: done('Acme'), notes: done('') })] });
	const answer = (columnId: string, v: Cell['v']) => (current: MutableGrid) => withCell(current, 'r', columnId, { ...current.rows[0].cells[columnId], v });
	const added = (column: Column, v?: Cell['v']) => (current: MutableGrid) => {
		const next = withColumns(current, [...current.sheet.columns, column]);
		return v === undefined ? next : withCell(next, 'r', column.id, done(v, 20));
	};
	const cases: Array<{ label: string; change: (current: MutableGrid) => MutableGrid; outdated: string[] }> = [
		{ label: 'nothing changed', change: (current) => current, outdated: [] },
		{ label: 'a blank column added', change: added(source('blank', 'Blank', { createdAt: 20 })), outdated: [] },
		{ label: 'an AI column added and answered', change: added(ai('extra', 'Extra', template('{{Company}}'), { createdAt: 20 }), 'Acme'), outdated: [] },
		{ label: 'a source column added and filled', change: added(source('size', 'Size', { createdAt: 20 }), '50'), outdated: ['ask', 'check', 'summary'] },
		{ label: 'an empty source value filled', change: answer('notes', 'Enterprise'), outdated: ['ask', 'check', 'summary'] },
		{ label: 'a referenced source value edited', change: answer('company', 'Globex'), outdated: ['ask', 'check', 'summary', 'search'] },
		{ label: 'an unreferenced AI answer changed', change: answer('check', 'No'), outdated: [] },
		{ label: 'a referenced AI answer changed', change: answer('ask', 'Someone else'), outdated: ['summary'] },
		{ label: 'a column renamed', change: (current) => renameColumn(current, 'company', 'Organization'), outdated: [] },
		{ label: 'a column renamed without restamping, as older clients did', change: (current) => withColumns(current, current.sheet.columns.map((column) => ({ ...column, name: column.id === 'company' ? 'Organization' : column.name, op: column.op && renameOpReferences(column.op, 'Company', 'Organization') }))), outdated: [] },
		{ label: 'a column moved', change: (current) => withColumns(current, [...current.sheet.columns.slice(1), current.sheet.columns[0]]), outdated: [] },
	];
	for (const { label, change, outdated } of cases) {
		const after = change(grid);
		assert.deepEqual(columns.filter((column) => column.op && !planCell(after, { rowId: 'r', columnId: column.id })!.complete).map((column) => column.id), outdated, label);
	}
});

test('a run in flight across a rename or a move is applied, not superseded', () => {
	const company = source('company', 'Company'), notes = source('notes', 'Notes');
	const columns = [company, notes, ai('ask', 'Ask', { kind: 'ai', prompt: 'Who runs {{Company}}? See {{A1}}.', output: 'text', research: 'none' })];
	const before: MutableGrid = { sheet: sheetOf(columns), rows: [rowOf('r', 0, { company: done('Acme'), notes: done('Big') })] };
	const plan = planCell(before, { rowId: 'r', columnId: 'ask' })!;
	const marker = startCell(plan, undefined, 2);
	const running = withCell(before, 'r', 'ask', marker);
	const result = resultCell(plan, 'Ada', undefined, 3);
	const moved = [...columns.slice(1), columns[0]];
	const changes: Array<[string, MutableGrid, string]> = [
		['renamed', renameColumn(running, 'company', 'Organization'), 'applied'],
		['moved', withColumns(running, shiftColumnReferences(columns, moved)), 'applied'],
		['an unreferenced source value edited', withCell(running, 'r', 'notes', done('Small')), 'stale'],
		['its rule edited', withColumns(running, columns.map((column) => column.op ? { ...column, op: { ...column.op, prompt: 'Who founded {{Company}}?' } as ColumnOp } : column)), 'superseded'],
	];
	for (const [label, grid, outcome] of changes) {
		const settled = settleCell(plan, grid, result, marker);
		assert.equal(settled.outcome, outcome, label);
		if (outcome === 'applied') assert.equal(planCell(withCell(grid, 'r', 'ask', settled.cell), { rowId: 'r', columnId: 'ask' })!.complete, true, `${label}: the result is current`);
	}
});
