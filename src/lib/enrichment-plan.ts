import { admittedCell } from './cell-admission';
import { canonicalJson } from './cell-content';
import { cellTransition } from './cell-lifecycle';
import { cycleMembers } from './enrichment-dependencies';
import { dependencyCells, inputFingerprint, inputRecord, inputVersion, isLegacyFingerprint, outdatedResult, rowIndex, ruleOf } from './enrichment-freshness';
import { entityFieldOp, entityKind } from './entity-fields';
import { evaluatesLocally, requiredProviders, worstCaseMs, type ProviderNeed } from './operations';
import { danglingReferences, findColumn, opDependencies, parsePromptReference, readsOtherRows, renameOpReferences } from './references';
import type { Cell, CellMeta, CellValue, Column, ColumnOp, Row, Sheet } from './types';

/* One cell's enrichment, planned from a grid snapshot alone: what it reads, whether it can run now, what it sends, and
   how its result or failure is stored. The browser runner (IndexedDB) and MCP (SQL) are its adapters: each reads a
   grid, plans, and writes the cells built here with its own compare-and-set. */

/** A sheet and its rows in sheet order (independent of sorting and filtering). */
export interface Grid { sheet: Sheet; rows: readonly Row[] }
export interface CellTarget { rowId: string; columnId: string }
export interface PlanContext {
	/** Cells the caller has queued or running that the grid may not show yet, such as a browser tab's queue. */
	pending?(rowId: string, columnId: string): boolean;
	/** The clock the expiry rule reads: the server's (see `serverNow`), as running markers are stamped on it. */
	now?: number;
	/** Who is planning (see `startCell`): a running cell saved by anyone else is busy. */
	owner?: string;
}

/** done: its value is an input. pending: queued or running. unrun: never ran, or was cleared. failed: it errored. */
export type DependencyState = 'done' | 'pending' | 'unrun' | 'failed';
export interface Dependency { row: Row; column: Column; state: DependencyState }

export type Readiness =
	| { kind: 'ready' }
	/** `started`: the dependency is queued or running; otherwise someone must run it first. */
	| { kind: 'waiting'; on: Dependency; started: boolean; message: string }
	| { kind: 'failed'; on: Dependency; message: string }
	| { kind: 'dangling'; references: string[]; message: string }
	| { kind: 'cycle'; message: string };

export interface EnrichmentPlan {
	readonly target: CellTarget;
	readonly row: Row;
	readonly column: Column;
	/** The row's position in the grid's rows. */
	readonly index: number;
	readonly op: ColumnOp;
	/** The operation as what it reads (references by column ID): a rename or move leaves it unchanged, an edit does not. */
	readonly rule: string;
	/** A source person-name column enriched in place: the name stays as written and the match adds its photo. */
	readonly inPlace: boolean;
	/** The cell as saved. */
	readonly cell: Cell | undefined;
	/** Saved as queued or running by another owner than the context's, and not yet expired. */
	readonly busy: boolean;
	/** Saved as running by the context's owner, and not yet expired: its own run, as it left it before a retry wait or a
	    reload. */
	readonly mine: boolean;
	/** Holds a result, current or outdated: done; for names enriched in place, matched. No automatic run selects it. */
	readonly finished: boolean;
	/** Finished, and answering the current rule and inputs. */
	readonly complete: boolean;
	/** Finished with a rule or inputs that changed since it ran: it keeps its value until it is explicitly re-run. */
	readonly outdated: boolean;
	/** Evaluated in the browser, without a request. */
	readonly local: boolean;
	readonly providers: readonly ProviderNeed[];
	readonly worstCaseMs: number;
	/** The AI cells among its inputs, in reference order (see `enrichment-freshness`). */
	readonly dependencies: readonly Dependency[];
	readonly readiness: Readiness;
	/** The row record the operation receives: every column by name, so a whole-row run is also shown answers that are not
	    inputs (see `version`). The cell's own previous value is never sent. */
	readonly record: Record<string, CellValue>;
	/** Everything the run reads: the rule and its inputs (the referenced cells, and for an operation that reads its row,
	    the row's non-empty source values). A result is kept only while this is unchanged, and stored as its fingerprint. */
	readonly version: string;
}

/** A saved run older than this was abandoned: longer than the API's five-minute execution limit and the browser request
    deadline. Markers are stamped and judged on the server's clock (see `server-clock`), never two machines' clocks. */
export const STALLED_ENRICHMENT_MS = 10 * 60_000;
export const CYCLE_MESSAGE = 'Circular enrichment dependency. Edit the AI columns so they no longer read each other.';
export const BUSY_MESSAGE = 'This cell is already queued or running.';
const PERSON_LOOKUP = { kind: 'person', field: 'full_name', label: 'Name' } as const;

/** The expiry rule, shared by browser recovery and MCP: a cell saved as queued or running for STALLED_ENRICHMENT_MS was
    abandoned. Returns what it becomes (a run fails as interrupted; a `queued` cell from older versions never started,
    so it gets its previous value back), or undefined while it may still be live. */
export function expiredCell(cell: Cell | undefined, now = Date.now()): Cell | undefined {
	if (!cell || (cell.s !== 'running' && cell.s !== 'queued') || now - cell.t < STALLED_ENRICHMENT_MS) return undefined;
	return cellTransition(cell, { type: cell.s === 'running' ? 'expire' : 'cancel' }, now);
}

/** What computes a column's cells: its own operation, or for a source person-name column, a person lookup. */
function operationOf(columns: readonly Column[], column: Column): { op: ColumnOp; inPlace: boolean } | undefined {
	if (column.type === 'enriched') return column.op && { op: column.op, inPlace: false };
	if (entityKind(column) === 'person') return { op: entityFieldOp(column, columns as Column[], PERSON_LOOKUP), inPlace: true };
}

const onCycles = new WeakMap<readonly Column[], Set<string>>();
/** Columns on a reference cycle between columns. A cell can only be on a cycle when its column is. */
function cyclicColumns(columns: readonly Column[]): Set<string> {
	let found = onCycles.get(columns);
	if (found) return found;
	const graph = new Map<string, string[]>();
	for (const column of columns) if (column.type === 'enriched' && column.op) graph.set(column.id, opDependencies(column.op).flatMap((text) => {
		const named = findColumn(columns, text);
		if (named) return [named.id];
		const reference = parsePromptReference(text);
		return reference ? columns.slice(Math.min(reference.start.column, reference.end.column), Math.max(reference.start.column, reference.end.column) + 1).map((entry) => entry.id) : [];
	}));
	onCycles.set(columns, found = cycleMembers(graph));
	return found;
}

/** Whether planning a column's cells needs every row of the sheet rather than just the cell's own: cell references
    read other rows, and a cycle can pass through them. */
export function readsWholeSheet(sheet: Sheet, columnId: string): boolean {
	const column = sheet.columns.find((entry) => entry.id === columnId);
	const operation = column && operationOf(sheet.columns, column);
	return Boolean(operation) && (readsOtherRows(opDependencies(operation!.op), sheet.columns) || cyclicColumns(sheet.columns).has(columnId));
}

function stateOf(row: Row, column: Column, context: PlanContext, now: number): DependencyState {
	if (context.pending?.(row.id, column.id)) return 'pending';
	const saved = row.cells[column.id];
	const cell = expiredCell(saved, now) ?? saved;
	return cell?.s === 'done' ? 'done' : cell?.s === 'error' ? 'failed' : cell?.s === 'running' || cell?.s === 'queued' ? 'pending' : 'unrun';
}

/** Whether the target waits, through cells that would wait too, on itself. Done and failed cells end a chain: they
    never wait. */
function onCycle(grid: Grid, index: number, column: Column, op: ColumnOp, context: PlanContext, now: number): boolean {
	if (!cyclicColumns(grid.sheet.columns).has(column.id)) return false;
	const target = grid.rows[index];
	const seen = new Set<string>();
	const stack: Array<{ index: number; op: ColumnOp }> = [{ index, op }];
	while (stack.length) {
		const cell = stack.pop()!;
		for (const dep of dependencyCells(grid.sheet.columns, grid.rows, cell.index, cell.op)) {
			if (dep.row.id === target.id && dep.column.id === column.id) return true;
			const key = JSON.stringify([dep.row.id, dep.column.id]);
			if (seen.has(key)) continue;
			seen.add(key);
			const state = stateOf(dep.row, dep.column, context, now);
			if (state === 'pending' || state === 'unrun') stack.push({ index: rowIndex(grid.rows, dep.row.id), op: dep.column.op! });
		}
	}
	return false;
}

function readinessOf(grid: Grid, index: number, column: Column, op: ColumnOp, context: PlanContext, now: number): { dependencies: Dependency[]; readiness: Readiness } {
	const dangling = danglingReferences(op, grid.sheet.columns);
	if (dangling.length) return { dependencies: [], readiness: { kind: 'dangling', references: dangling, message: `${dangling.map((name) => `{{${name}}}`).join(', ')} ${dangling.length === 1 ? 'doesn’t' : 'don’t'} match any column. Edit this column to fix it.` } };
	const dependencies = dependencyCells(grid.sheet.columns, grid.rows, index, op).map((dep) => ({ ...dep, state: stateOf(dep.row, dep.column, context, now) }));
	const find = (state: DependencyState) => dependencies.find((dep) => dep.state === state);
	const waiting = find('pending') ?? (find('failed') ? undefined : find('unrun'));
	if (!waiting) {
		const failed = find('failed');
		return { dependencies, readiness: failed ? { kind: 'failed', on: failed, message: `Waiting on "${failed.column.name}", which failed` } : { kind: 'ready' } };
	}
	if (dependencies.some((dep) => dep.row.id === grid.rows[index].id && dep.column.id === column.id) || onCycle(grid, index, column, op, context, now)) return { dependencies, readiness: { kind: 'cycle', message: CYCLE_MESSAGE } };
	const started = waiting.state === 'pending';
	return { dependencies, readiness: { kind: 'waiting', on: waiting, started, message: started ? `Waiting on "${waiting.column.name}", which is still running` : `Waiting on "${waiting.column.name}", which hasn’t run yet. Run it first.` } };
}

/** Plan one cell, or undefined when its row is gone or its column computes nothing. Rows must be in sheet order. */
export function planCell(grid: Grid, target: CellTarget, context: PlanContext = {}): EnrichmentPlan | undefined {
	const { sheet, rows } = grid;
	const column = sheet.columns.find((entry) => entry.id === target.columnId);
	const operation = column && operationOf(sheet.columns, column);
	const index = rowIndex(rows, target.rowId);
	if (!column || !operation || index < 0) return undefined;
	const { op, inPlace } = operation;
	const row = rows[index], cell = row.cells[column.id], now = context.now ?? Date.now();
	const blank = inPlace ? undefined : column.id;
	const pending = (cell?.s === 'running' || cell?.s === 'queued') && !expiredCell(cell, now);
	const mine = pending && context.owner !== undefined && cell?.owner === context.owner;
	const finished = cell?.s === 'done' && (!inPlace || Boolean(cell.m?.person));
	let readiness: ReturnType<typeof readinessOf> | undefined, record: Record<string, CellValue> | undefined, rule: string | undefined, version: string | undefined, complete: boolean | undefined;
	return {
		target, row, column, index, op, inPlace, cell, mine, finished,
		busy: pending && !mine,
		local: evaluatesLocally(op),
		providers: requiredProviders(op),
		worstCaseMs: worstCaseMs(op),
		get dependencies() { return (readiness ??= readinessOf(grid, index, column, op, context, now)).dependencies; },
		get readiness() { return (readiness ??= readinessOf(grid, index, column, op, context, now)).readiness; },
		get record() { return record ??= inputRecord(sheet.columns, rows, index, op, blank); },
		get rule() { return rule ??= canonicalJson(ruleOf(op, sheet.columns))!; },
		get version() { return version ??= inputVersion(sheet.columns, rows, index, op, blank); },
		get complete() { return complete ??= finished && (inPlace || !outdatedResult(cell, sheet.columns, rows, index, op, column.id, this)); },
		get outdated() { return finished && !this.complete; },
	};
}

/* ───────────── Stored cells ───────────── */

/** The cell as its run starts: running for `owner` (a browser tab or an MCP request), keeping its last settled value so
    stopping restores it. An abandoned run is expired first. */
export function startCell(plan: EnrichmentPlan, owner?: string, at = Date.now()): Cell {
	return cellTransition(expiredCell(plan.cell, at) ?? plan.cell, { type: 'start', owner }, at);
}

/** A run's answer, stamped with the inputs it answers. A name enriched in place keeps its spelling and gains the match's photo. */
export function resultCell(plan: EnrichmentPlan, value: CellValue, meta?: CellMeta, at = Date.now()): Cell {
	const name = plan.inPlace ? plan.cell?.v : undefined;
	if (typeof name === 'string') return cellTransition(undefined, { type: 'succeed', v: name, m: { ...meta, person: { name, avatarUrl: meta?.person?.avatarUrl ?? null }, inputFingerprint: inputFingerprint(plan.version) } }, at);
	return cellTransition(undefined, { type: 'succeed', v: value, m: { ...meta, inputFingerprint: inputFingerprint(plan.version) } }, at);
}

/** `after`'s rows, with the `v1:` results that were current in `before` restamped as current in `after`. `v1:`
    fingerprints name the columns they read, so a rename, move, deletion or redefinition breaks them; `v2:` ones need
    no help. With `after` the same grid, an upgrade before such a change, so it is judged as any other. */
function restampCurrentResults(before: Grid, after: Grid): Row[] {
	const columns = after.sheet.columns.filter((column) => column.type === 'enriched' && column.op);
	return after.rows.map((row) => {
		let cells: Row['cells'] | undefined;
		for (const column of columns) {
			const cell = row.cells[column.id];
			if (cell?.s !== 'done' || !cell.m || !isLegacyFingerprint(cell.m.inputFingerprint) || !planCell(before, { rowId: row.id, columnId: column.id })?.complete) continue;
			(cells ??= { ...row.cells })[column.id] = { ...cell, m: { ...cell.m, inputFingerprint: inputFingerprint(planCell(after, { rowId: row.id, columnId: column.id })!.version) } };
		}
		return cells ? { ...row, cells } : row;
	});
}

/** `grid`'s rows with every result that is current under a `v1:` fingerprint restamped `v2:`. Call it on the grid as it
    is before deleting, moving or redefining a column. Rows it leaves alone are returned as they were. */
export const upgradeLegacyResults = (grid: Grid): Row[] => restampCurrentResults(grid, grid);

/** `grid` with a column renamed: references follow it, and results it leaves current stay current. The browser and MCP
    both rename through here; each checks the name is free its own way. */
export function renameColumn(grid: { sheet: Sheet; rows: Row[] }, columnId: string, name: string): { sheet: Sheet; rows: Row[] } {
	const previous = grid.sheet.columns.find((column) => column.id === columnId);
	if (!previous || previous.name === name) return grid;
	const columns = grid.sheet.columns.map((column) => {
		const next = column.id === columnId ? { ...column, name } : column;
		return next.op ? { ...next, op: renameOpReferences(next.op, previous.name, name) } : next;
	});
	const sheet = { ...grid.sheet, columns };
	return { sheet, rows: restampCurrentResults(grid, { sheet, rows: grid.rows }) };
}

/** A failed run (`from` is its running marker), or a cell that cannot run. The value it started from is kept with the
    error, so a failed re-run never erases a result, and a name enriched in place keeps its spelling. */
export function failureCell(plan: EnrichmentPlan, message: string, meta?: CellMeta, at = Date.now(), from: Cell | undefined = plan.cell): Cell {
	return cellTransition(from, { type: 'fail', e: message, m: meta }, at);
}

export type CommitOutcome = 'applied' | 'stale' | 'superseded';

/** Whether a run planned as `plan` still applies to the grid as it is now: its rule and every input unchanged, whatever
    was renamed or moved meanwhile. */
export function recheck(plan: EnrichmentPlan, grid: Grid): CommitOutcome {
	return recheckPlan(plan, grid).outcome;
}

function recheckPlan(plan: EnrichmentPlan, grid: Grid): { outcome: CommitOutcome; fresh?: EnrichmentPlan } {
	const fresh = planCell(grid, plan.target);
	if (!fresh || fresh.inPlace !== plan.inPlace || fresh.rule !== plan.rule) return { outcome: 'superseded' };
	return { outcome: fresh.version === plan.version ? 'applied' : 'stale', fresh };
}

/** What a finished run stores, given the cell it expected (its running marker) and the grid as it is now: `next`
    admitted to the column's current format while the run still applies; otherwise the expected cell's settled value,
    marked stale when inputs changed. A failure, including an answer the format refuses, keeps the value the run
    started from, and a name enriched in place is never erased. */
export function settleCell(plan: EnrichmentPlan, grid: Grid, next: Cell, expected: Cell | undefined): { outcome: CommitOutcome; cell: Cell } {
	const { outcome, fresh } = recheckPlan(plan, grid);
	if (outcome !== 'applied') return { outcome, cell: cellTransition(expected, { type: outcome === 'stale' && !plan.inPlace ? 'stale' : 'cancel' }) };
	const cell = admittedCell({ ...fresh!.column, op: fresh!.op }, next, 'enrichment');
	return { outcome, cell: cell.s === 'error' && next.s !== 'error' ? cellTransition(expected, { type: 'fail', e: cell.e!, m: cell.m }) : cell };
}
