import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FormulaRequest, FormulaResult } from '../src/lib/formulas';
import type { CancelFilter, RunnerSnapshot } from '../src/lib/runner';
import { createSheetCommands, withProgress, type RunnerPort, type StorePort } from '../src/lib/sheet-commands';
import { planCell, resultCell } from '../src/lib/enrichment-plan';
import { cellEditToken } from '../src/lib/cell-content';
import { exportFile, exportSummary } from '../src/lib/sheet-export';
import type { Provider } from '../src/lib/organization-settings';
import type { Cell, Column, ColumnOp, Row, Sheet } from '../src/lib/types';

const ask: ColumnOp = { kind: 'ai', prompt: 'CEO of {{Domain}}?', output: 'text', research: 'web' };
const ultra: ColumnOp = { kind: 'answer', task: 'Latest funding', output: 'text', mode: 'ultra' };
const template: ColumnOp = { kind: 'template', template: 'Hi {{Company}}' };
const column = (id: string, extra: Partial<Column> = {}): Column => ({ id, name: id, type: 'source', width: 160, createdAt: 0, ...extra });
const done = (v: Cell['v']): Cell => ({ v, s: 'done', t: 1 });
const row = (id: string, cells: Record<string, Cell> = {}, order = 0): Row => ({ id, sheetId: 's1', order, cells, createdAt: 0 });

/** In-memory adapters: they record what reached the runner and the store, in order. */
function harness({ columns = [column('Domain'), column('CEO', { type: 'enriched', op: ask })], rows = [row('r1'), row('r2')], pending = [] as string[] } = {}) {
	const log: string[] = [];
	const enqueued: Array<{ rows: string[]; columns: string[]; options: object }> = [];
	const cancelled: CancelFilter[][] = [];
	const writes: Array<{ rowId: string; columnId: string; cell: Cell }> = [];
	const pendingCells = new Set(pending);
	let snapshot: Pick<RunnerSnapshot, 'bySheet' | 'halted'> = { bySheet: {}, halted: {} };
	const tracked: unknown[] = [];
	const sheet: Sheet = { id: 's1', name: 'Sheet', columns, filters: [], sort: null, createdAt: 0, updatedAt: 0 };
	const runner: RunnerPort = {
		owner: 'this-tab',
		subscribe: () => () => {},
		getSnapshot: () => snapshot,
		isPending: (rowId, columnId, sheetId) => sheetId === 's1' && pendingCells.has(`${rowId}:${columnId}`),
		enqueue: async (_sheetId, targets, targetColumns, options) => {
			enqueued.push({ rows: targets.map((entry) => entry.id), columns: targetColumns.map((entry) => entry.id), options });
			return targets.length * targetColumns.length;
		},
		cancel: async (filters) => { log.push('cancel'); cancelled.push(filters); for (const cell of [...pendingCells]) if (filters.some((filter) => !filter.columnId || cell.endsWith(`:${filter.columnId}`))) pendingCells.delete(cell); },
		supersede: async (_sheetId, columnId) => { log.push(`supersede:${columnId}`); return []; },
		resume: () => { log.push('resume'); },
		retryFailed: async () => { log.push('retry'); return 1; },
	};
	const store: StorePort = {
		sheet: async () => structuredClone(sheet),
		grid: async () => ({ sheet: structuredClone(sheet), rows: structuredClone(rows) }),
		addColumns: async (_sheetId, added, position, initialCell) => { log.push(`add:${added.map((entry) => entry.name).join(',')}@${position}${initialCell ? ` with ${initialCell.rowId}` : ''}`); sheet.columns.splice(position ?? sheet.columns.length, 0, ...added); },
		addFormulaColumn: async (_sheetId, added, formula, position) => { log.push(`formula:${added.name}=${formula}@${position}`); sheet.columns.splice(position ?? sheet.columns.length, 0, added); },
		updateColumn: async (_sheetId, columnId, patch) => { log.push(`update:${columnId}`); sheet.columns = sheet.columns.map((entry) => entry.id === columnId ? { ...entry, ...patch } : entry); },
		deleteRows: async (_sheetId, rowIds) => { log.push(`delete-rows:${rowIds.join(',')}`); },
		deleteColumn: async (_sheetId, columnId) => { log.push(`delete-column:${columnId}`); },
		clearColumn: async (_sheetId, columnId) => { log.push(`clear-column:${columnId}`); },
		setCells: async (updates) => { log.push('set-cells'); writes.push(...updates); },
		calculate: async (request: FormulaRequest): Promise<FormulaResult[]> => { log.push('calculate'); return (request.copies ?? []).map(({ target }) => ({ ...target, cell: { v: 42, f: '=1', s: 'done', t: 1 } })); },
	};
	return { commands: createSheetCommands('s1', { runner, store, track: (...event) => { tracked.push(event); } }), log, tracked, enqueued, cancelled, writes, sheet, grid: (gridRows: Row[]) => ({ sheet, rows: gridRows }), setSnapshot: (next: typeof snapshot) => { snapshot = next; } };
}

test('mutations stop this tab’s work on the touched cells before writing', async () => {
	const { commands, log, cancelled } = harness({ pending: ['r1:CEO'] });
	await commands.deleteRows(['r1']);
	await commands.deleteColumn('CEO');
	await commands.clearColumn('CEO');
	assert.deepEqual(log, ['cancel', 'delete-rows:r1', 'cancel', 'delete-column:CEO', 'cancel', 'clear-column:CEO']);
	assert.deepEqual(cancelled, [[{ sheetId: 's1', rowIds: ['r1'] }], [{ sheetId: 's1', columnId: 'CEO' }], [{ sheetId: 's1', columnId: 'CEO' }]]);
});

test('clearing cells cancels only the pending ones, grouped by column, then empties every cell', async () => {
	const { commands, log, cancelled, writes } = harness({ pending: ['r1:CEO', 'r2:CEO'] });
	await commands.clearCells([{ rowId: 'r1', columnId: 'CEO' }, { rowId: 'r2', columnId: 'CEO' }, { rowId: 'r1', columnId: 'Domain' }]);
	assert.deepEqual(log, ['cancel', 'set-cells']);
	assert.deepEqual(cancelled[0], [{ sheetId: 's1', columnId: 'CEO', rowIds: ['r1', 'r2'] }]);
	assert.equal(writes.length, 3);
	assert.ok(writes.every(({ cell }) => cell.v === null && cell.s === 'idle'));
	const quiet = harness();
	await quiet.commands.clearCells([{ rowId: 'r1', columnId: 'Domain' }]);
	assert.deepEqual(quiet.log, ['set-cells'], 'nothing pending, nothing to cancel');
});

test('a plan gates on keys, explains no-ops, and runs only what is unfinished', async () => {
	const ceo = column('CEO', { type: 'enriched', op: ask });
	const rows = [row('r1', { CEO: done('Ada') }), row('r2'), row('r3', { CEO: { v: null, s: 'error', e: 'Failed', t: 1 } })];
	const { commands, enqueued, grid } = harness({ pending: ['r2:CEO'] });
	const options = { ready: () => true, grid: grid(rows) };
	assert.deepEqual(commands.plan(rows, [ceo], 'unfinished', { ...options, ready: () => false }), { kind: 'needs-keys', providers: ['openai'] });
	const plan = commands.plan(rows, [ceo], 'unfinished', options);
	assert.equal(plan.kind, 'run');
	if (plan.kind !== 'run') return;
	assert.equal(plan.estimate.cells, 1, 'done and pending cells are skipped; the failed one runs');
	assert.equal(await plan.execute(), 1);
	assert.deepEqual(enqueued, [{ rows: ['r3'], columns: ['CEO'], options: { limitToRows: undefined, optimisticStart: undefined, unfinished: true } }]);
	assert.deepEqual(commands.plan([rows[0]], [ceo], 'unfinished', options), { kind: 'nothing', reason: 'complete' });
	assert.deepEqual(commands.plan([rows[1]], [ceo], 'all', options), { kind: 'nothing', reason: 'pending' });
	assert.deepEqual(commands.plan(rows, [column('Domain')], 'all', options), { kind: 'nothing', reason: 'none' });
	const keyless = commands.plan(rows, [column('Greeting', { type: 'enriched', op: template })], 'all', { ...options, ready: () => false });
	assert.equal(keyless.kind, 'run', 'templates need no provider keys');
});

test('unfinished runs never select finished cells; outdated ones re-run only when asked, through the same cost rule', async () => {
	const ceo = column('CEO', { type: 'enriched', op: ask });
	const { commands, enqueued, sheet, grid } = harness();
	const answered = (rows: Row[], rowId: string) => resultCell(planCell({ sheet, rows }, { rowId, columnId: 'CEO' })!, 'Ada');
	const unrun = row('r3', { Domain: done('gamma.com') }, 2);
	const current = answered([row('r1', { Domain: done('acme.com') }, 0)], 'r1');
	const earlier = answered([row('r2', { Domain: done('old.com') }, 1)], 'r2');
	const rows = [row('r1', { Domain: done('acme.com'), CEO: current }, 0), row('r2', { Domain: done('beta.com'), CEO: earlier }, 1), unrun];
	const plan = commands.plan(rows, [ceo], 'unfinished', { ready: () => true, grid: grid(rows) });
	assert.ok(plan.kind === 'run');
	assert.equal(plan.estimate.cells, 1);
	await plan.execute();
	assert.deepEqual(enqueued.map((entry) => entry.rows), [['r3']], 'only the unrun cell runs; the outdated and the current one keep their values');
	const outdated = commands.plan(rows, [ceo], 'outdated', { ready: () => true, grid: grid(rows) });
	assert.ok(outdated.kind === 'run');
	assert.equal(outdated.estimate.cells, 1);
	await outdated.execute();
	assert.deepEqual(enqueued.map((entry) => entry.rows), [['r3'], ['r2']], 'the explicit re-run takes only the outdated cell');
	assert.deepEqual(commands.plan(rows.slice(0, 2), [ceo], 'unfinished', { ready: () => true, grid: grid(rows) }), { kind: 'nothing', reason: 'outdated' });
	const rule = { ...ceo, op: { ...ask, prompt: 'Founder of {{Domain}}?' } as ColumnOp };
	const ruleGrid = { sheet: { ...sheet, columns: [sheet.columns[0], rule] }, rows };
	const changed = commands.plan(rows, [rule], 'unfinished', { ready: () => true, grid: ruleGrid });
	assert.ok(changed.kind === 'run');
	assert.equal(changed.estimate.cells, 1, 'a new rule keeps saved values: they become outdated, not unfinished');
	const rerun = commands.plan(Array.from({ length: 60 }, (_, i) => row(`o${i}`, { Domain: done(`${i}.com`), CEO: earlier }, i)), [rule], 'outdated', { ready: () => true, grid: { sheet: ruleGrid.sheet, rows: Array.from({ length: 60 }, (_, i) => row(`o${i}`, { Domain: done(`${i}.com`), CEO: earlier }, i)) } });
	assert.ok(rerun.kind === 'run' && rerun.estimate.cells === 60 && rerun.estimate.confirm, 'a big re-run of outdated cells asks first, as any run does');
});

test('cells another tab or an agent is running, and finished cells that cannot run, are never selected', () => {
	const columns = [column('Company'), column('Notes'), column('CEO', { type: 'enriched', op: { kind: 'ai', prompt: 'CEO of {{Company}}? {{Notes}}', output: 'text', research: 'web' } })];
	const { commands, grid, sheet } = harness({ columns });
	const rows = [0, 1, 2].map((i) => row(`r${i}`, { Company: done(`Co ${i}`), Notes: done(`note ${i}`) }, i));
	for (const entry of rows) entry.cells.CEO = resultCell(planCell({ sheet, rows }, { rowId: entry.id, columnId: 'CEO' })!, `CEO ${entry.id}`);
	// Notes is deleted: CEO now reads a column that no longer exists.
	const deleted = { sheet: { ...sheet, columns: [columns[0], columns[2]] }, rows: rows.map((entry) => ({ ...entry, cells: { Company: entry.cells.Company, CEO: entry.cells.CEO } })) };
	for (const mode of ['unfinished', 'outdated', 'all'] as const) assert.deepEqual(commands.plan(deleted.rows, [columns[2]], mode, { ready: () => true, grid: deleted }), { kind: 'nothing', reason: 'blocked' }, mode);
	const fixed = commands.plan(deleted.rows, [{ ...columns[2], op: { kind: 'ai', prompt: 'CEO of {{Company}}?', output: 'text', research: 'web' } }], 'all', { ready: () => true, grid: deleted });
	assert.ok(fixed.kind === 'run' && fixed.estimate.cells === 3, 'the editor’s draft, which no longer reads Notes, re-runs them');
	const agent = row('a', { Company: done('Acme'), CEO: { v: null, s: 'running', owner: 'mcp-x', t: Date.now() } });
	const mine = row('m', { Company: done('Acme'), CEO: { v: null, s: 'running', owner: 'this-tab', t: Date.now() } }, 1);
	for (const mode of ['unfinished', 'all'] as const) assert.deepEqual(commands.plan([agent], [columns[2]], mode, { ready: () => true, grid: grid([agent, mine]) }), { kind: 'nothing', reason: 'pending' }, `${mode}: an agent's run`);
	const own = commands.plan([mine], [columns[2]], 'unfinished', { ready: () => true, grid: grid([agent, mine]) });
	assert.ok(own.kind === 'run' && own.estimate.cells === 1, 'this tab’s own marker, left by a reload, runs again');
});

test('runs ask only for the providers their operations need', () => {
	const { commands, grid } = harness();
	const rows = [row('r1')];
	const cases: Array<{ name: string; op: ColumnOp; connected: Provider[]; missing: Provider[] }> = [
		{ name: 'template', op: template, connected: [], missing: [] },
		{ name: 'email template', op: { kind: 'email-draft', mode: 'template', prompt: '', to: '{{Email}}', cc: '', bcc: '', subject: 'Hi', body: 'Hello {{Name}}' }, connected: [], missing: [] },
		{ name: 'AI email draft', op: { kind: 'email-draft', mode: 'ai', prompt: 'Intro', to: '', cc: '', bcc: '', subject: '', body: '' }, connected: ['looot'], missing: ['openai'] },
		{ name: 'company data with only looot', op: { kind: 'company', domain: '{{Domain}}', field: 'industry' }, connected: ['looot'], missing: [] },
		{ name: 'web search without looot', op: { kind: 'search', query: '{{Domain}}', pick: 'url', numResults: 3 }, connected: ['openai'], missing: ['looot'] },
		{ name: 'ask AI without a page needs only OpenAI', op: ask, connected: ['openai'], missing: [] },
		{ name: 'ask AI reading a page', op: { ...ask, page: { type: 'homepage', column: 'Domain' } } as ColumnOp, connected: ['openai'], missing: ['looot'] },
		{ name: 'check decided by TypeSafe', op: { kind: 'check', question: 'B2B?', decider: 'jev', threshold: 0.5 }, connected: ['typesafe'], missing: [] },
		{ name: 'check without a decider', op: { kind: 'check', question: 'B2B?', decider: 'jev', threshold: 0.5 }, connected: ['looot'], missing: ['typesafe'] },
		{ name: 'exact-text check on the row', op: { kind: 'check', question: 'Mentions Acme?', literal: 'Acme', decider: 'jev', threshold: 0.5 }, connected: [], missing: [] },
		{ name: 'email find', op: { kind: 'email-enrichment', name: '{{Name}}', company: '', domain: '{{Domain}}', profileUrl: '', prefer: 'balanced' }, connected: ['looot'], missing: [] },
		{ name: 'email verify', op: { kind: 'email-verify', email: '{{Email}}', prefer: 'balanced' }, connected: ['openai'], missing: ['looot'] },
	];
	for (const { name, op, connected, missing } of cases) {
		const plan = commands.plan(rows, [column('Out', { type: 'enriched', op })], 'all', { ready: (provider) => connected.includes(provider), grid: grid(rows) });
		assert.deepEqual(plan.kind === 'needs-keys' ? plan.providers : [], missing, name);
		assert.equal(plan.kind, missing.length ? 'needs-keys' : 'run', name);
	}
});

test('every bulk run shares the cost rule', () => {
	const { commands, grid } = harness();
	const many = Array.from({ length: 60 }, (_, i) => row(`r${i}`));
	const options = { ready: () => true, grid: grid(many) };
	const cheap = commands.plan(many.slice(0, 50), [column('Greeting', { type: 'enriched', op: template })], 'all', options);
	const big = commands.plan(many, [column('CEO', { type: 'enriched', op: ask })], 'all', options);
	const costly = commands.plan(many.slice(0, 20), [column('Funding', { type: 'enriched', op: ultra })], 'all', options);
	assert.ok(cheap.kind === 'run' && !cheap.estimate.confirm);
	assert.ok(big.kind === 'run' && big.estimate.confirm && big.estimate.message === '~60 cells × ~$0.0040 ≈ $0.24');
	assert.ok(costly.kind === 'run' && costly.estimate.confirm, 'twenty Ultra research cells cost more than the threshold');
});

test('retry plans only failed cells', async () => {
	const ceo = column('CEO', { type: 'enriched', op: ask });
	const failed: Cell = { v: null, s: 'error', e: 'Failed', t: 1 };
	const { commands, enqueued } = harness();
	const plan = commands.planRetry([row('r1', { CEO: done('Ada') }), row('r2', { CEO: failed }), row('r3', { CEO: failed })], [ceo, column('Domain')], { ready: () => true });
	assert.ok(plan.kind === 'run');
	await plan.execute();
	assert.deepEqual(enqueued.map((entry) => entry.rows), [['r2', 'r3']]);
});

test('fill recalculates formulas and runs enrichments copied down their own column', async () => {
	const ceo = column('CEO', { type: 'enriched', op: ask });
	const rows = [row('r1', { Domain: { v: 1, f: '=1', s: 'done', t: 1 }, CEO: done('Ada') }, 0), row('r2', {}, 1), row('r3', {}, 2)];
	const { commands, log, writes, enqueued } = harness({ columns: [column('Domain'), ceo], rows, pending: ['r3:CEO'] });
	const plan = await commands.fill([
		{ source: { rowId: 'r1', columnId: 'Domain' }, target: { rowId: 'r2', columnId: 'Domain' } },
		{ source: { rowId: 'r1', columnId: 'CEO' }, target: { rowId: 'r2', columnId: 'CEO' } },
		{ source: { rowId: 'r1', columnId: 'CEO' }, target: { rowId: 'r3', columnId: 'CEO' } },
	], { ready: () => true });
	assert.deepEqual(log, ['calculate', 'set-cells']);
	assert.deepEqual(writes.map(({ rowId, columnId }) => `${rowId}:${columnId}`), ['r2:Domain']);
	assert.ok(plan?.kind === 'run');
	await plan.execute();
	assert.deepEqual(enqueued, [{ rows: ['r2'], columns: ['CEO'], options: { limitToRows: undefined, optimisticStart: true, unfinished: false } }], 'the pending target is left alone');
	assert.deepEqual(await commands.fill([{ source: { rowId: 'r1', columnId: 'CEO' }, target: { rowId: 'r2', columnId: 'CEO' } }], { ready: () => false }), { kind: 'needs-keys', providers: ['openai'] });
});

test('entity columns are inserted after their source with unique names, then planned for the chosen rows', async () => {
	const website = column('Website', { format: 'website' });
	const rows = [row('r1', {}, 0), row('r2', {}, 1), row('r3', {}, 2)];
	const { commands, log, enqueued } = harness({ columns: [website, column('Industry'), column('Notes')], rows });
	const result = await commands.addEntityColumns(website, [
		{ kind: 'company', field: 'industry', label: 'Industry', run: { rowId: 'r2', count: 10, scope: 'below' } },
		{ kind: 'website', field: 'extract', label: 'Extract data…' },
	], { ready: () => true, visibleRows: rows });
	assert.deepEqual(log, ['add:Industry 2@1']);
	assert.equal(result.extract?.insertAt, 2);
	assert.equal(result.extract?.op.kind, 'scrape');
	assert.ok(result.run?.kind === 'run');
	await result.run.execute();
	assert.deepEqual(enqueued[0].rows, ['r2', 'r3']);
});

test('pauses go through the runner', async () => {
	const { commands, log } = harness();
	await commands.retryHalted();
	await commands.dismissHalt();
	assert.deepEqual(log, ['retry', 'cancel', 'resume']);
});

test('editing a column stops its work under the old operation before saving, and only when the operation changes', async () => {
	const { commands, log, sheet } = harness({ pending: ['r1:CEO'] });
	await commands.editColumn('CEO', { name: 'Chief' });
	await commands.editColumn('CEO', { name: 'Chief', op: { research: 'web', output: 'text', prompt: ask.prompt, kind: 'ai' } as ColumnOp });
	await commands.editColumn('CEO', { op: { ...ask, prompt: 'Founder of {{Domain}}?' } as ColumnOp });
	assert.deepEqual(log, ['update:CEO', 'update:CEO', 'supersede:CEO', 'update:CEO'], 'a rename or the same operation leaves running cells alone');
	assert.equal(sheet.columns[1].op?.kind === 'ai' && sheet.columns[1].op.prompt, 'Founder of {{Domain}}?');
});

test('every way of adding a column counts each column once, with its kind', async () => {
	const website = column('Website', { format: 'website' });
	const rows = [row('r1', {}, 0), row('r2', {}, 1)];
	const { commands, log, tracked } = harness({ columns: [website], rows });
	await commands.addColumns([column('Notes')], { kind: 'blank', position: 0 });
	await commands.addColumns([column('Typed')], { kind: 'blank', initialCell: { rowId: 'r1', columnId: 'Typed', cell: done('x') } });
	await commands.addColumns([column('Total')], { kind: 'formula', position: 1, formula: '=1+1' });
	await commands.addColumns([column('CEO', { type: 'enriched', op: ask })], { kind: ask.kind });
	await commands.addEntityColumns(website, [{ kind: 'company', field: 'industry', label: 'Industry' }, { kind: 'company', field: 'city', label: 'City' }], { ready: () => true, visibleRows: rows });
	assert.deepEqual(log, ['add:Notes@0', 'add:Typed@undefined with r1', 'formula:Total==1+1@1', 'add:CEO@undefined', 'add:Industry,City@3']);
	assert.deepEqual(tracked, ['blank', 'blank', 'formula', 'ai', 'company', 'company'].map((kind) => ['column_added', { kind }]));
});

test('run status is stable for useSyncExternalStore and overlays pending cells', () => {
	const { commands, setSnapshot } = harness();
	const idle = commands.status();
	assert.equal(commands.status(), idle);
	assert.equal(idle.pending, 0);
	const cells = new Map([['r1', new Map([['CEO', 'running' as const]])]]);
	const halt = { sheetId: 's1', reason: 'credits_exhausted' as const, provider: 'looot' as const, message: 'Out of credits', failedCells: 2 };
	setSnapshot({ bySheet: { s1: { queued: 3, running: 1, cells } }, halted: { s1: halt } });
	const busy = commands.status();
	assert.equal(commands.status(), busy);
	assert.deepEqual({ queued: busy.queued, running: busy.running, pending: busy.pending, halt: busy.halt }, { queued: 3, running: 1, pending: 4, halt });
	const [shown] = withProgress([row('r1', { CEO: { v: 'Old', s: 'done', t: 5 } })], busy.cells);
	assert.deepEqual(shown.cells.CEO, { v: 'Old', s: 'running', e: undefined, t: 5 });
});

test('edit-conflict tokens ignore key order, timestamps and recalculated formula results', () => {
	assert.equal(cellEditToken({ v: 'a', s: 'done', t: 1 }), cellEditToken({ t: 9, s: 'done', v: 'a' } as Cell));
	assert.equal(cellEditToken({ v: 2, f: '=B2*2', s: 'done', t: 1 }), cellEditToken({ v: 8, f: '=B2*2', s: 'done', t: 2 }));
	assert.notEqual(cellEditToken({ v: 'a', s: 'done', t: 1 }), cellEditToken({ v: 'b', s: 'done', t: 1 }));
	assert.notEqual(cellEditToken(undefined), cellEditToken({ v: null, s: 'idle', t: 1 }));
});

test('exports say their scope and can include confidence and sources in every format', async () => {
	assert.equal(exportSummary({ rows: 42, total: 300, selected: 0, hiddenColumns: 2 }), 'Exporting 42 of 300 rows · 2 hidden columns excluded');
	assert.equal(exportSummary({ rows: 300, total: 300, selected: 0, hiddenColumns: 0 }), 'Exporting all 300 rows');
	assert.equal(exportSummary({ rows: 42, total: 300, selected: 1, hiddenColumns: 1 }), 'Exporting 1 selected row · 1 hidden column excluded');
	const sheet = { name: 'Leads!', columns: [column('Company'), column('CEO', { type: 'enriched', op: ask }), column('Secret', { hidden: true })] };
	const rows = [row('r1', { Company: done('Acme'), CEO: { v: 'Ada', s: 'done', t: 1, m: { confidence: 0.9, sources: ['https://acme.example'] } }, Secret: done('x') })];
	const json = exportFile(sheet, rows, 'json', true);
	assert.equal(json.filename, 'leads.json');
	assert.deepEqual(JSON.parse(await json.blob.text()), [{ Company: 'Acme', CEO: 'Ada', 'CEO (confidence)': 0.9, 'CEO (sources)': ['https://acme.example'] }]);
	assert.deepEqual(JSON.parse(await exportFile(sheet, rows, 'json', false).blob.text()), [{ Company: 'Acme', CEO: 'Ada' }]);
	assert.match(await exportFile(sheet, rows, 'csv', true).blob.text(), /CEO \(confidence\)/);
	assert.equal(exportFile(sheet, rows, 'xlsx', true).filename, 'leads.xlsx');
});

test('running a column also queues the AI inputs it reads where they never ran', async () => {
	const linkedin: ColumnOp = { kind: 'ai', prompt: 'LinkedIn of {{CEO}}?', output: 'text', research: 'web' };
	const columns = [column('Domain'), column('CEO', { type: 'enriched', op: ask }), column('LinkedIn', { type: 'enriched', op: linkedin })];
	const rows = [row('r1', { CEO: done('Mary') }), row('r2'), row('r3', { CEO: { v: null, s: 'error', e: 'failed', t: 1 } })];
	const { commands, enqueued, grid } = harness({ columns, rows });
	const plan = commands.plan(rows, [columns[2]], 'unfinished', { ready: () => true, grid: grid(rows), sheetColumns: columns });
	assert.equal(plan?.kind, 'run');
	if (plan?.kind !== 'run') return;
	assert.equal(plan.estimate.cells, 4, 'three LinkedIn cells plus the one CEO cell that never ran');
	await plan.execute();
	assert.deepEqual(enqueued.map(({ rows, columns }) => ({ rows, columns })).sort((a, b) => a.columns[0].localeCompare(b.columns[0])), [{ rows: ['r2'], columns: ['CEO'] }, { rows: ['r1', 'r2', 'r3'], columns: ['LinkedIn'] }]);
	const alone = commands.plan(rows, [columns[2]], 'unfinished', { ready: () => true, grid: grid(rows) });
	assert.equal(alone?.kind === 'run' && alone.estimate.cells, 3, 'without sheet columns nothing extra is queued');
});

test('an unsaved column’s plan counts the never-run AI inputs it reads, so the editor previews the run it will start', () => {
	const rows = Array.from({ length: 30 }, (_, i) => row(`r${i}`, { Domain: done(`d${i}.com`) }, i));
	const { commands, grid, sheet } = harness({ rows });
	const draft = column('Greeting', { type: 'enriched', op: { kind: 'template', template: 'Hi {{CEO}}' } });
	const options = { ready: () => true, grid: grid(rows), limitToRows: true };
	const alone = commands.plan(rows, [draft], 'unfinished', options);
	assert.ok(alone.kind === 'run');
	assert.deepEqual([alone.estimate.cells, alone.estimate.confirm], [30, false], 'the column by itself looks small');
	const preview = commands.plan(rows, [draft], 'unfinished', { ...options, sheetColumns: [...sheet.columns, draft] });
	assert.ok(preview.kind === 'run');
	assert.deepEqual([preview.estimate.cells, preview.estimate.usd, preview.estimate.confirm], [60, 0.12, true], 'thirty Greeting cells and the thirty CEO cells they wait on');
});

test('drag-fill never runs a cell another tab or an agent is running, or a finished one that cannot run', async () => {
	const ceo = column('CEO', { type: 'enriched', op: ask });
	const agent: Cell = { v: null, s: 'running', owner: 'mcp-x', t: Date.now() };
	const rows = [row('r1', { CEO: done('Ada') }, 0), row('r2', { CEO: agent }, 1)];
	const { commands, enqueued } = harness({ columns: [column('Domain'), ceo], rows });
	assert.deepEqual(await commands.fill([{ source: { rowId: 'r1', columnId: 'CEO' }, target: { rowId: 'r2', columnId: 'CEO' } }], { ready: () => true }), { kind: 'nothing', reason: 'pending' });
	const dangling = column('CEO', { type: 'enriched', op: { ...ask, prompt: 'CEO of {{Missing}}?' } as ColumnOp });
	const blocked = harness({ columns: [column('Domain'), dangling], rows: [row('r1', { CEO: done('Ada') }, 0), row('r2', { CEO: done('Grace') }, 1)] });
	assert.deepEqual(await blocked.commands.fill([{ source: { rowId: 'r1', columnId: 'CEO' }, target: { rowId: 'r2', columnId: 'CEO' } }], { ready: () => true }), { kind: 'nothing', reason: 'blocked' });
	assert.deepEqual([enqueued, blocked.enqueued], [[], []]);
});
