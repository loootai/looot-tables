'use client';

import type { AnalyticsEvents } from './analytics';
import { canonicalJson } from './cell-content';
import { addColumns, addFormulaColumn, clearColumnCells, db, deleteColumn, deleteRows, emptyCell, newColumn, setCells, updateColumn } from './db';
import { planCell, type Grid } from './enrichment-plan';
import { entityFieldOp, type EntityField } from './entity-fields';
import { calculateInWorker } from './formula-worker-client';
import type { FormulaCopy, FormulaRequest, FormulaResult } from './formulas';
import { missingProviders } from './operations';
import type { Provider } from './organization-settings';
import { findColumn, opDependencies, uniqueName } from './references';
import { estimateCells, type RunEstimate } from './run-cost';
import { serverNow } from './server-clock';
import { runner, type CancelFilter, type PendingStatus, type RunHalt, type RunnerSnapshot } from './runner';
import type { Cell, Column, ColumnOp, Row, Sheet } from './types';

/* One sheet's intent-level actions. Every mutation stops this tab's queued or running work on the cells it touches
   first, so a finishing run can never overwrite (or resurrect) what the user just changed. Runs are planned before
   they start: a plan knows whether keys are missing, whether there is nothing to do, and what it will cost. */

export interface RunnerPort {
	/** This tab's owner token for the cells it runs (see `startCell`). */
	readonly owner: string;
	subscribe(listener: () => void): () => void;
	getSnapshot(): Pick<RunnerSnapshot, 'bySheet' | 'halted'>;
	isPending(rowId: string, columnId: string, sheetId: string): boolean;
	/** `unfinished`: a "Run unfinished" run, which never runs a cell that has finished by the time it starts. */
	enqueue(sheetId: string, rows: Row[], columns: Column[], options: { limitToRows?: boolean; optimisticStart?: boolean; unfinished?: boolean }): Promise<number>;
	cancel(filters: CancelFilter[]): Promise<void>;
	supersede(sheetId: string, columnId: string): Promise<string[]>;
	resume(sheetId: string): void;
	retryFailed(sheetId: string): Promise<number>;
}

export interface StorePort {
	sheet(sheetId: string): Promise<Sheet | undefined>;
	grid(sheetId: string): Promise<{ sheet: Sheet; rows: Row[] } | undefined>;
	addColumns(sheetId: string, columns: Column[], position?: number, initialCell?: CellWrite): Promise<void>;
	addFormulaColumn(sheetId: string, column: Column, formula: string, position?: number): Promise<void>;
	updateColumn(sheetId: string, columnId: string, patch: Partial<Column>): Promise<void>;
	deleteRows(sheetId: string, rowIds: string[]): Promise<void>;
	deleteColumn(sheetId: string, columnId: string): Promise<void>;
	clearColumn(sheetId: string, columnId: string): Promise<void>;
	setCells(updates: Array<{ rowId: string; columnId: string; cell: Cell }>): Promise<void>;
	calculate(request: FormulaRequest): Promise<FormulaResult[]>;
}

const browserRunner: RunnerPort = {
	get owner() { return runner.owner; },
	subscribe: (listener) => runner.subscribe(listener),
	getSnapshot: () => runner.getSnapshot(),
	isPending: (rowId, columnId, sheetId) => runner.isPending(rowId, columnId, sheetId),
	enqueue: (sheetId, rows, columns, options) => runner.enqueue(sheetId, rows, columns, options),
	cancel: (filters) => runner.cancel(filters),
	supersede: (sheetId, columnId) => runner.supersede(sheetId, columnId),
	resume: (sheetId) => runner.resume(sheetId),
	retryFailed: (sheetId) => runner.retryFailed(sheetId),
};

const browserStore: StorePort = {
	sheet: (sheetId) => db.sheets.get(sheetId),
	async grid(sheetId) {
		const [sheet, rows] = await Promise.all([db.sheets.get(sheetId), db.rows.where('[sheetId+order]').between([sheetId, -Infinity], [sheetId, Infinity]).toArray()]);
		return sheet ? { sheet, rows } : undefined;
	},
	addColumns,
	addFormulaColumn,
	updateColumn,
	deleteRows,
	deleteColumn,
	clearColumn: (sheetId, columnId) => clearColumnCells(sheetId, columnId),
	setCells: (updates) => setCells(updates),
	calculate: calculateInWorker,
};

export interface CellRef { rowId: string; columnId: string }
export interface CellWrite extends CellRef { cell: Cell }
/** `column_added`'s kind: the operation, `formula` or `blank`. `initialCell` fills one cell of a new column in the same
    commit; `formula` fills the one column added down every row. */
export interface AddColumnsOptions { kind: string; position?: number; initialCell?: CellWrite; formula?: string }
export type PendingCells = ReadonlyMap<string, ReadonlyMap<string, PendingStatus>>;
export interface SheetRunStatus { queued: number; running: number; pending: number; cells: PendingCells; halt?: RunHalt }

/** `unfinished`: cells never run, failed or stopped; never a finished one, so a run spends nothing on results the sheet
    already holds. `outdated`: finished cells whose rule or inputs changed since they ran, re-run only when asked.
    `all`: every cell. */
export type RunMode = 'unfinished' | 'outdated' | 'all';
export type RunPlan =
	| { kind: 'run'; estimate: RunEstimate; execute: () => Promise<number> }
	| { kind: 'needs-keys'; providers: Provider[] }
	/** `outdated`: an `unfinished` run found only finished cells, some of them outdated. `blocked`: only finished cells
	    that cannot run (see `savedState`). */
	| { kind: 'nothing'; reason: 'pending' | 'complete' | 'outdated' | 'blocked' | 'none' };
/** Whether a provider is connected; each run asks only for the providers its operations need. */
export type ProviderReady = (provider: Provider) => boolean;
/** `grid` is the sheet as saved, in sheet order: it decides which cells a mode selects (see `savedState`).
    `sheetColumns` lets a run also queue AI input cells in the same rows that have never run. */
interface RunOptions { ready: ProviderReady; grid?: Grid; limitToRows?: boolean; optimistic?: boolean; sheetColumns?: readonly Column[] }
type CellGroup = { column: Column; rows: Row[] };

const NO_CELLS: PendingCells = new Map();
const IDLE: SheetRunStatus = { queued: 0, running: 0, pending: 0, cells: NO_CELLS };
const runnable = (column: Column): column is Column & { op: ColumnOp } => column.type === 'enriched' && Boolean(column.op);
const cellKey = ({ rowId, columnId }: CellRef) => JSON.stringify([rowId, columnId]);

type SavedState = 'unfinished' | 'complete' | 'outdated' | 'busy' | 'blocked';
const savedStates = new WeakMap<Grid, Map<string, SavedState>>();
const CANNOT_RUN: ReadonlySet<string> = new Set(['dangling', 'cycle', 'failed']);
/** A saved cell as a run sees it (see `EnrichmentPlan`): busy while another tab or an agent runs it; blocked when it is
    done but cannot run (a reference that matches no column, a cycle, a failed input), as the runner never replaces a
    value with that reason; otherwise complete, outdated or unfinished. Cached per grid: progress updates re-plan often
    against the same saved grid, and fingerprints are not free. */
function savedState(grid: Grid, target: CellRef, owner: string): SavedState {
	let states = savedStates.get(grid);
	if (!states) savedStates.set(grid, states = new Map());
	const key = cellKey(target);
	let state = states.get(key);
	if (!state) {
		const plan = planCell(grid, target, { owner, now: serverNow() });
		state = !plan ? 'unfinished' : plan.busy ? 'busy' : plan.cell?.s === 'done' && CANNOT_RUN.has(plan.readiness.kind) ? 'blocked'
			: plan.complete ? 'complete' : plan.outdated ? 'outdated' : 'unfinished';
		states.set(key, state);
	}
	return state;
}

const drafts = new WeakMap<Grid, Map<string, Grid>>();
/** The saved grid with `column` as given: the column editor plans a run of its draft before saving it, and the draft
    may fix what kept saved cells from running. */
function gridWith(grid: Grid, column: Column): Grid {
	const saved = grid.sheet.columns.find((entry) => entry.id === column.id);
	const key = canonicalJson([column.id, column.type, column.op])!;
	if (!saved || canonicalJson([saved.id, saved.type, saved.op]) === key) return grid;
	let byColumn = drafts.get(grid);
	if (!byColumn) drafts.set(grid, byColumn = new Map());
	let draft = byColumn.get(key);
	if (!draft) byColumn.set(key, draft = { sheet: { ...grid.sheet, columns: grid.sheet.columns.map((entry) => entry.id === column.id ? column : entry) }, rows: grid.rows });
	return draft;
}

/** Rows as the grid shows them: a cell pending in this tab reads queued or running and keeps its last value. */
export function withProgress(rows: Row[], cells: PendingCells): Row[];
export function withProgress(rows: Row[] | undefined, cells: PendingCells): Row[] | undefined;
export function withProgress(rows: Row[] | undefined, cells: PendingCells) {
	if (!rows || !cells.size) return rows;
	return rows.map((row) => {
		const pending = cells.get(row.id);
		if (!pending) return row;
		const next = { ...row.cells };
		for (const [columnId, status] of pending) next[columnId] = { ...next[columnId], v: next[columnId]?.v ?? null, s: status, e: undefined, t: next[columnId]?.t ?? 0 };
		return { ...row, cells: next };
	});
}

/** Failed enrichment cells, by column. */
export function failedCells(rows: Row[], columns: Column[]): CellGroup[] {
	return columns.filter(runnable).flatMap((column) => {
		const failed = rows.filter((row) => row.cells[column.id]?.s === 'error');
		return failed.length ? [{ column, rows: failed }] : [];
	});
}

/** Cancel filters for the given cells, one per column. */
function cellFilters(sheetId: string, cells: CellRef[]): CancelFilter[] {
	const byColumn = new Map<string, string[]>();
	for (const { rowId, columnId } of cells) {
		const rowIds = byColumn.get(columnId);
		if (rowIds) rowIds.push(rowId);
		else byColumn.set(columnId, [rowId]);
	}
	return [...byColumn].map(([columnId, rowIds]) => ({ sheetId, columnId, rowIds }));
}

export type SheetCommands = ReturnType<typeof createSheetCommands>;

export type TrackPort = <Name extends keyof AnalyticsEvents>(name: Name, properties: AnalyticsEvents[Name]) => void;
// Loaded on use, as in the runner: the analytics SDK doesn't load outside a browser bundle.
const browserTrack: TrackPort = (name, properties) => void import('./analytics').then(({ trackEvent }) => trackEvent(name, properties)).catch(() => {});

export function createSheetCommands(sheetId: string, ports: { runner?: RunnerPort; store?: StorePort; track?: TrackPort } = {}) {
	const work = ports.runner ?? browserRunner;
	const store = ports.store ?? browserStore;
	const track = ports.track ?? browserTrack;
	const isPending = (rowId: string, columnId: string) => work.isPending(rowId, columnId, sheetId);
	let cached: { progress: unknown; halt: unknown; status: SheetRunStatus } | undefined;

	/** Running a column also runs the AI columns it reads, for rows where they never ran (never rows that failed or finished). */
	function withUnrunInputs(groups: CellGroup[], columns: readonly Column[] | undefined): CellGroup[] {
		if (!columns) return groups;
		const result = new Map(groups.map((group) => [group.column.id, { column: group.column, rows: new Map(group.rows.map((row) => [row.id, row])) }]));
		const queue = [...groups];
		for (let group = queue.shift(); group; group = queue.shift()) {
			if (!runnable(group.column)) continue;
			for (const name of opDependencies(group.column.op)) {
				const input = findColumn(columns, name);
				if (!input || input.id === group.column.id || !runnable(input)) continue;
				const unrun = group.rows.filter((row) => (row.cells[input.id]?.s ?? 'idle') === 'idle' && !isPending(row.id, input.id));
				const entry = result.get(input.id) ?? { column: input, rows: new Map<string, Row>() };
				const added = unrun.filter((row) => !entry.rows.has(row.id));
				if (!added.length) continue;
				for (const row of added) entry.rows.set(row.id, row);
				result.set(input.id, entry);
				queue.push({ column: input, rows: added });
			}
		}
		return [...result.values()].map(({ column, rows }) => ({ column, rows: [...rows.values()] }));
	}

	/** The cells of `requested` that `mode` selects, then the never-run AI inputs of those that run. */
	function plan(requested: CellGroup[], mode: RunMode, options: RunOptions): RunPlan {
		const { grid } = options;
		const seen = new Set<SavedState>();
		let pending = false;
		const selected = requested.filter(({ column }) => runnable(column)).map(({ column, rows }) => {
			const judged = grid && gridWith(grid, column);
			return { column, rows: rows.filter((row) => {
				if (isPending(row.id, column.id)) { pending = true; return false; }
				if (!judged) return true;
				const state = savedState(judged, { rowId: row.id, columnId: column.id }, work.owner);
				seen.add(state);
				if (state === 'busy') pending = true;
				return mode === 'all' ? state !== 'busy' && state !== 'blocked' : state === mode;
			}) };
		}).filter((group) => group.rows.length > 0);
		const runs = withUnrunInputs(selected, options.sheetColumns);
		if (!runs.length) return { kind: 'nothing', reason: pending ? 'pending' : mode === 'unfinished' && seen.has('outdated') ? 'outdated' : seen.has('blocked') ? 'blocked' : mode !== 'all' && seen.size ? 'complete' : 'none' };
		const missing = [...new Set(runs.flatMap(({ column }) => missingProviders(column.op!, options.ready)))];
		if (missing.length) return { kind: 'needs-keys', providers: missing };
		return {
			kind: 'run',
			estimate: estimateCells(runs.map(({ column, rows }) => ({ cells: rows.length, op: column.op }))),
			execute: async () => {
				const added = await Promise.all(runs.map(({ column, rows }) => work.enqueue(sheetId, rows, [column], { limitToRows: options.limitToRows, optimisticStart: options.optimistic, unfinished: mode === 'unfinished' })));
				return added.reduce((sum, count) => sum + count, 0);
			},
		};
	}

	/** Every way a column is added ends here, so each one is counted once. */
	async function insert(columns: Column[], kindOf: (column: Column) => string, { position, initialCell, formula }: Omit<AddColumnsOptions, 'kind'>) {
		if (formula !== undefined) await store.addFormulaColumn(sheetId, columns[0], formula, position);
		else await store.addColumns(sheetId, columns, position, initialCell);
		for (const column of columns) track('column_added', { kind: kindOf(column) });
	}

	async function stopCells(cells: CellRef[]) {
		const pending = cells.filter((cell) => isPending(cell.rowId, cell.columnId));
		if (pending.length) await work.cancel(cellFilters(sheetId, pending));
	}

	return {
		subscribe: (listener: () => void) => work.subscribe(listener),
		/** Stable until this sheet's progress or pause changes, for useSyncExternalStore. */
		status(): SheetRunStatus {
			const snapshot = work.getSnapshot();
			const progress = snapshot.bySheet[sheetId], halt = snapshot.halted[sheetId];
			if (!cached || cached.progress !== progress || cached.halt !== halt) {
				const queued = progress?.queued ?? 0, running = progress?.running ?? 0;
				cached = { progress, halt, status: progress || halt ? { queued, running, pending: queued + running, cells: progress?.cells ?? NO_CELLS, halt } : IDLE };
			}
			return cached.status;
		},
		isPending,

		/** The cells of `rows` × `columns` that `mode` selects; no mode selects a cell pending here or elsewhere. */
		plan: (rows: Row[], columns: Column[], mode: RunMode, options: RunOptions & { grid: Grid }) => plan(columns.map((column) => ({ column, rows })), mode, options),
		/** Only the failed cells among `rows`. */
		planRetry: (rows: Row[], columns: Column[], options: RunOptions) => plan(failedCells(rows, columns), 'all', options),
		stop: () => work.cancel([{ sheetId }]),
		/** Continue after a pause, re-running the cells that failed with it. */
		retryHalted: () => work.retryFailed(sheetId),
		/** Drop the pause and the work waiting behind it. */
		dismissHalt: async () => {
			await work.cancel([{ sheetId }]);
			work.resume(sheetId);
		},

		/** Insert columns at `position` (default: last). */
		addColumns: (columns: Column[], { kind, ...options }: AddColumnsOptions) => insert(columns, () => kind, options),
		/** Change a column's name, format or operation. A new operation first stops the column's queued and running cells,
		    which keep their previous values rather than finish with the old one; plan the column's run afterwards to
		    include them. */
		async editColumn(columnId: string, patch: Partial<Column>) {
			const current = patch.op && (await store.sheet(sheetId))?.columns.find((column) => column.id === columnId);
			if (current && canonicalJson(current.op) !== canonicalJson(patch.op)) await work.supersede(sheetId, columnId);
			await store.updateColumn(sheetId, columnId, patch);
		},
		async deleteRows(rowIds: string[]) {
			await work.cancel([{ sheetId, rowIds }]);
			await store.deleteRows(sheetId, rowIds);
		},
		async deleteColumn(columnId: string) {
			await work.cancel([{ sheetId, columnId }]);
			await store.deleteColumn(sheetId, columnId);
		},
		/** Empty a column but keep its rule. */
		async clearColumn(columnId: string) {
			await work.cancel([{ sheetId, columnId }]);
			await store.clearColumn(sheetId, columnId);
		},
		async clearCells(cells: CellRef[]) {
			await stopCells(cells);
			await store.setCells(cells.map(({ rowId, columnId }) => ({ rowId, columnId, cell: emptyCell() })));
		},

		/** Drag-fill: formulas are recalculated for their new position; an enrichment copied down its own column runs there.
		    Cells still pending are left alone. Returns the run the enrichments need, if any. */
		async fill(copies: FormulaCopy[], options: { ready: ProviderReady }): Promise<RunPlan | null> {
			const available = copies.filter(({ target }) => !isPending(target.rowId, target.columnId));
			const grid = available.length ? await store.grid(sheetId) : undefined;
			if (!grid) return null;
			const rowById = new Map(grid.rows.map((row) => [row.id, row]));
			const isFormula = ({ source }: FormulaCopy) => Boolean(rowById.get(source.rowId)?.cells[source.columnId]?.f);
			const formulas = available.filter(isFormula);
			if (formulas.length) {
				const results = await store.calculate({ grid: { columns: grid.sheet.columns, rows: grid.rows }, copies: formulas });
				const targets = new Set(formulas.map(({ target }) => cellKey(target)));
				const now = Date.now();
				await store.setCells(results.filter((result) => targets.has(cellKey(result))).map((result) => ({ ...result, cell: { ...result.cell, t: now } })));
			}
			const columns = new Map(grid.sheet.columns.map((column) => [column.id, column]));
			const groups = new Map<string, CellGroup>();
			for (const copy of available) {
				const column = columns.get(copy.target.columnId), row = rowById.get(copy.target.rowId);
				if (copy.source.columnId !== copy.target.columnId || isFormula(copy) || !column || !row) continue;
				const group = groups.get(column.id);
				if (group) group.rows.push(row);
				else groups.set(column.id, { column, rows: [row] });
			}
			return groups.size ? plan([...groups.values()], 'all', { ready: options.ready, grid, optimistic: true }) : null;
		},

		/** Columns derived from an entity column (company facts, page reads…), inserted after it. An "Extract data" field
		    needs setup, so it is returned for the column editor instead of being added. */
		async addEntityColumns(source: Column, fields: EntityField[], options: { ready: ProviderReady; visibleRows: Row[] }) {
			const extract = fields.find((field) => (field.kind === 'website' || field.kind === 'webpage') && field.field === 'extract');
			const direct = fields.filter((field) => field !== extract);
			const grid = await store.grid(sheetId);
			if (!grid) return { added: [] as Column[], run: null };
			const names = grid.sheet.columns.map((column) => column.name);
			const added = direct.map((field) => {
				const name = uniqueName(field.label, names);
				names.push(name);
				return newColumn({ name, type: 'enriched', op: entityFieldOp(source, grid.sheet.columns, field) });
			});
			const insertAt = grid.sheet.columns.findIndex((column) => column.id === source.id) + 1;
			if (added.length) await insert(added, (column) => column.op?.kind ?? 'blank', { position: insertAt });
			const scope = direct[0]?.run;
			const start = scope ? options.visibleRows.findIndex((row) => row.id === scope.rowId) : -1;
			const targets = !scope || scope.scope === 'column' ? grid.rows : start < 0 ? [] : options.visibleRows.slice(start, start + scope.count);
			return {
				added,
				extract: extract && { insertAt: insertAt + added.length, op: entityFieldOp(source, grid.sheet.columns, extract) },
				run: added.length ? plan(added.map((column) => ({ column, rows: targets })), 'unfinished', { ready: options.ready, grid }) : null,
			};
		},
	};
}
