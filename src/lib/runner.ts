'use client';

import { nanoid } from 'nanoid';
import { ApiError, enrichCell } from './api';
import { canonicalJson } from './cell-content';
import { cellTransition, isPendingCell } from './cell-lifecycle';
import { db, updateCellsIf, type CellChange } from './db';
import { failureCell, planCell, readsWholeSheet, recheck, resultCell, settleCell, startCell, type EnrichmentPlan, type Grid, type PlanContext } from './enrichment-plan';
import { loadSettings } from './keys';
import { renderEmailDraft } from './email-draft';
import { CloudError } from './sheet-remote';
import { serverNow } from './server-clock';
import { claimTabOwner } from './tab-owner';
import { renderTemplate } from './template';
import type { Cell, CellMeta, CellValue, Column, ColumnOp, EnrichFailure, EnrichResponse, FailureProvider, FailureReason, Row, Sheet } from './types';

/* The enrichment runner lives for the whole app session (a module singleton), so navigating between sheets does not
   stop running jobs. Each task is one cell, planned by `enrichment-plan`: tasks wait for the cells they reference, run
   with bounded concurrency, and retry transient failures. Only `running` is saved, naming this tab as its owner: queued
   cells live in this tab's memory, so a closed tab never strands them, and a pending cell keeps its previous value and
   metadata until its result lands. A cell another tab or an agent is running is waited on, never run twice. */

export type PendingStatus = 'queued' | 'running';
export type HaltReason = 'credits_exhausted' | 'credential_missing' | 'credential_invalid' | 'save_failed';

/** A sheet paused because every further request would fail the same way (or results could not be saved). */
export interface RunHalt {
	sheetId: string;
	reason: HaltReason;
	provider?: FailureProvider;
	/** The first failure's message, safe to show. */
	message: string;
	/** Cells that failed this way. `retryFailed` runs them again. */
	failedCells: number;
}

export interface SheetProgress {
	queued: number;
	running: number;
	/** Pending cells by row ID, then column ID. */
	cells: ReadonlyMap<string, ReadonlyMap<string, PendingStatus>>;
}

export interface RunnerSnapshot {
	queued: number;
	running: number;
	/** Work remains, including stopped runs still restoring their cells. */
	active: boolean;
	bySheet: Readonly<Record<string, SheetProgress>>;
	/** Paused sheets by ID. Their queued cells wait for `resume` or `retryFailed`; a new run also resumes. */
	halted: Readonly<Record<string, RunHalt>>;
}

export interface CancelFilter { sheetId?: string; columnId?: string; rowIds?: string[] }

/** Where the runner reads grids and writes cells. */
export interface RunnerStore {
	sheet(sheetId: string): Promise<Sheet | undefined>;
	/** The sheet's rows in sheet order; with `rowIds`, only those still in the sheet. */
	rows(sheetId: string, rowIds?: readonly string[]): Promise<Row[]>;
	/** Compare-and-set writes to one sheet in a single commit (see `CellChange`). Returns which were written. */
	updateCells(sheetId: string, changes: CellChange[]): Promise<boolean[]>;
}

export interface RunnerPorts {
	store: RunnerStore;
	enrich(op: ColumnOp, record: Record<string, CellValue>, signal: AbortSignal): Promise<EnrichResponse>;
	concurrency(): number;
	/** How long a cell waiting on one running in another tab or an agent waits before looking again. */
	waitMs: number;
	/** The clock running markers are stamped and expired on (see `serverNow`); this machine's by default. */
	now?: () => number;
	/** This tab's owner token for the cells it runs (see `startCell`); a fresh one by default. Nothing starts until a
	    pending claim settles (see `claimTabOwner`). */
	owner?: string | Promise<string>;
}

type TaskState =
	| { phase: 'queued'; starting: boolean }
	| { phase: 'running'; controller: AbortController; op: string; signature: string }
	| { phase: 'backoff'; controller: AbortController; op: string };

/** A finished run whose cell could not be saved yet: the save is retried on resume, and the provider is never asked again. */
interface Unsaved { plan: EnrichmentPlan; duplicates: Row[]; marker: Cell | undefined; next: Cell; op: string }

interface Task {
	readonly key: string;
	readonly sheetId: string;
	readonly rowId: string;
	readonly columnId: string;
	readonly attempts: number;
	/** Restrict duplicate filling to the explicitly requested run scope. */
	readonly targetRowIds?: ReadonlySet<string>;
	/** The cell as it was queued (see `basisOf`): a result saved over it since, by another tab or an agent, is not run
	    again. Undefined when it replaced this tab's own run. */
	readonly basis?: string;
	/** Queued by "Run unfinished": a finished cell is never run. */
	readonly unfinished?: boolean;
	state: TaskState;
	unsaved?: Unsaved;
}

/** A cell that cannot run, failed against the cell it was planned from. */
type Failure = { task: Task; cell: Cell; expected: Cell | undefined };
type Ready = { task: Task; signature: string; op: string };
type CommitOutcome = 'applied' | 'stale' | 'superseded' | 'skipped';

const MAX_ATTEMPTS = 3;
const PUBLISH_MS = 100;
const YIELD_MS = 40;
const FATAL: ReadonlySet<FailureReason> = new Set(['credits_exhausted', 'credential_missing', 'credential_invalid']);

/** Cell identity for maps only. It is never parsed, so IDs may contain any character. */
const cellKey = (sheetId: string, rowId: string, columnId: string) => JSON.stringify([sheetId, rowId, columnId]);
const byOrder = (a: Row, b: Row) => a.order - b.order;
/** A saved cell's status and time: whoever saves a result there changes them. */
const basisOf = (cell: Cell | undefined) => JSON.stringify([cell?.s ?? 'idle', cell?.t ?? 0]);
const statusOf = (task: Task): PendingStatus => task.state.phase === 'running' || task.state.phase === 'queued' && task.state.starting ? 'running' : 'queued';

function yieldToMain(): Promise<void> {
	const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
	return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0));
}

/** Call in long loops: yields to input and rendering once the time slice is used up. */
function yielder() {
	let until = performance.now() + YIELD_MS;
	return async () => {
		if (performance.now() < until) return;
		await yieldToMain();
		until = performance.now() + YIELD_MS;
	};
}

function sleep(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

/** Without a `failure` (an older server, or a request that failed on its way), only a rate limit is plainly refused
    before processing: a timeout, a server error or a dropped connection may come after the provider billed the work. */
const RATE_LIMITED = /\b429\b|rate.?limit/i;

/** The server's `failure` decides (see `enrich-failure`); message patterns are only a fallback for responses without one. */
function describeFailure(result: EnrichResponse | undefined, error: unknown): { message: string; failure?: EnrichFailure; meta?: CellMeta; retryable: boolean } {
	if (result?.error) return { message: result.error, failure: result.failure, meta: result.meta, retryable: result.failure ? result.failure.retryable : RATE_LIMITED.test(result.error) };
	const message = error instanceof Error ? error.message : 'Request failed';
	const failure = error instanceof ApiError ? error.failure : undefined;
	const status = error instanceof ApiError ? error.status : 0;
	return { message, failure, retryable: failure ? failure.retryable : status === 429 || RATE_LIMITED.test(message) };
}

/** Formulas need no network: the browser evaluates them. */
function evaluate(op: ColumnOp, record: Record<string, CellValue>): CellValue {
	if (op.kind === 'email-draft') return JSON.stringify(renderEmailDraft(op, record));
	if (op.kind === 'template') return renderTemplate(op.template, record) || null;
	throw new Error(`${op.kind} cannot run in the browser.`);
}

/** Analytics loads lazily because its SDK is browser-only. */
function trackStarted(cells: number) {
	void import('./analytics').then(({ trackEvent }) => trackEvent('enrichment_started', { cells })).catch(() => {});
}

export class Runner {
	/** Live tasks by cell, in queue order. */
	private tasks = new Map<string, Task>();
	/** In-flight runs by cell, including stopped ones still restoring their cell. A cell never has two. */
	private runs = new Map<string, Task>();
	private halts = new Map<string, { halt: RunHalt; cells: Array<{ rowId: string; columnId: string }> }>();
	private listeners = new Set<() => void>();
	private snapshot: RunnerSnapshot = { queued: 0, running: 0, active: false, bySheet: {}, halted: {} };
	private dirty = false;
	private notifyTimer: ReturnType<typeof setTimeout> | undefined;
	private ticking = false;
	private wake = false;
	/** Failed tasks already removed from the queue whose error cell is still being written, by cell. */
	private failing = new Map<string, number>();
	/** Changes whenever saved cells may have changed under a scan's cached rows. */
	private generation = 0;
	private recheckTimer: ReturnType<typeof setTimeout> | undefined;
	/** While the session is signed out nothing new starts; queued cells wait for `hold(false)`. */
	private held = false;
	/** Saved in the running cells this tab starts, so it knows them from runs elsewhere. */
	owner: string;
	private claim: Promise<void> | undefined;

	constructor(private ports: RunnerPorts) {
		const { owner = `tab-${nanoid()}` } = ports;
		this.owner = typeof owner === 'string' ? owner : `tab-${nanoid()}`;
		if (typeof owner !== 'string') this.claim = owner.then((claimed) => { this.owner = claimed; }, () => {}).finally(() => { this.claim = undefined; });
	}
	private get store() { return this.ports.store; }
	private sheet(sheetId: string) { return this.store.sheet(sheetId); }
	private concurrency() { return Math.max(1, Math.min(16, this.ports.concurrency() || 4)); }
	private now() { return this.ports.now?.() ?? Date.now(); }

	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): RunnerSnapshot {
		if (this.dirty) this.rebuild();
		return this.snapshot;
	}

	/** Pending status of one cell in this tab, as the grid should show it. */
	cellStatus(sheetId: string, rowId: string, columnId: string): PendingStatus | undefined {
		const task = this.tasks.get(cellKey(sheetId, rowId, columnId));
		return task && statusOf(task);
	}

	/** Queued, running, or still restoring a stopped run in this tab. Pass sheetId for an exact constant-time check. */
	isPending(rowId: string, columnId: string, sheetId?: string): boolean {
		if (sheetId !== undefined) {
			const key = cellKey(sheetId, rowId, columnId);
			return this.tasks.has(key) || this.runs.has(key);
		}
		for (const tasks of [this.tasks, this.runs]) for (const task of tasks.values()) if (task.rowId === rowId && task.columnId === columnId) return true;
		return false;
	}

	/** Listeners hear about background progress at most every PUBLISH_MS; user actions publish immediately. */
	private publish(now = false) {
		this.dirty = true;
		if (now) this.notify();
		else this.notifyTimer ??= setTimeout(() => this.notify(), PUBLISH_MS);
	}

	private notify() {
		clearTimeout(this.notifyTimer);
		this.notifyTimer = undefined;
		this.rebuild();
		for (const listener of this.listeners) listener();
	}

	private rebuild() {
		this.dirty = false;
		const bySheet: Record<string, { queued: number; running: number; cells: Map<string, Map<string, PendingStatus>> }> = Object.create(null);
		let queued = 0, running = 0;
		for (const task of this.tasks.values()) {
			const status = statusOf(task);
			const sheet = bySheet[task.sheetId] ??= { queued: 0, running: 0, cells: new Map() };
			sheet[status] += 1;
			if (status === 'queued') queued += 1;
			else running += 1;
			let row = sheet.cells.get(task.rowId);
			if (!row) sheet.cells.set(task.rowId, row = new Map());
			row.set(task.columnId, status);
		}
		const halted: Record<string, RunHalt> = Object.create(null);
		for (const [sheetId, { halt }] of this.halts) halted[sheetId] = halt;
		this.snapshot = { queued, running, active: this.tasks.size > 0 || this.runs.size > 0 || this.failing.size > 0, bySheet, halted };
	}

	/** Queue cells and return how many were added. Which cells to run is the caller's plan (see `EnrichmentPlan.complete`).
	    Pending cells are skipped, except a running cell whose rule changed: it is stopped and queued again with the new
	    rule. Queuing also resumes a paused sheet. */
	async enqueue(sheet: string | Pick<Sheet, 'id'>, rows: Row[], columns: Column[], options: { limitToRows?: boolean; optimisticStart?: boolean; unfinished?: boolean } = {}) {
		const targetRowIds = options.limitToRows ? new Set(rows.map((row) => row.id)) : undefined;
		return this.add(typeof sheet === 'string' ? sheet : sheet.id, rows.flatMap((row) => columns.map((column) => ({ row, column }))), { ...options, targetRowIds });
	}

	private add(sheetId: string, cells: Array<{ row: Row; column: Column }>, options: { optimisticStart?: boolean; targetRowIds?: ReadonlySet<string>; unfinished?: boolean }) {
		const idle = ![...this.tasks.values()].some((task) => task.state.phase === 'queued');
		const added: Task[] = [];
		for (const { row, column } of cells) {
			if (column.type !== 'enriched' || !column.op) continue;
			const key = cellKey(sheetId, row.id, column.id);
			const existing = this.tasks.get(key);
			if (existing) {
				if (existing.state.phase === 'queued' || existing.state.op === canonicalJson(column.op)) continue;
				existing.state.controller.abort();
			}
			const task: Task = { key, sheetId, rowId: row.id, columnId: column.id, attempts: 0, targetRowIds: options.targetRowIds, basis: existing ? undefined : basisOf(row.cells[column.id]), unfinished: options.unfinished, state: { phase: 'queued', starting: false } };
			this.tasks.delete(key);
			this.tasks.set(key, task);
			added.push(task);
		}
		if (!added.length) return 0;
		// Play and drag-fill show progress before dependency reads finish.
		if (options.optimisticStart && idle) for (const task of added.slice(0, Math.max(0, this.concurrency() - this.runs.size))) task.state = { phase: 'queued', starting: true };
		this.halts.delete(sheetId);
		this.publish(true);
		trackStarted(added.length);
		this.tick();
		return added.length;
	}

	/** Stop matching cells: drop queued ones, abort running ones, and give saved cells back their previous values.
	    `persist` lets callers that already hold the sheet's lock write without waiting for it. */
	async cancel(filter: CancelFilter | CancelFilter[] = {}, persist: (sheetId: string, changes: CellChange[]) => Promise<boolean[]> = (sheetId, changes) => this.store.updateCells(sheetId, changes)) {
		const filters = (Array.isArray(filter) ? filter : [filter]).map((entry) => ({ ...entry, rowIds: entry.rowIds && new Set(entry.rowIds) }));
		const stopped: Task[] = [];
		for (const task of this.tasks.values()) {
			if (!filters.some((entry) => (!entry.sheetId || task.sheetId === entry.sheetId) && (!entry.columnId || task.columnId === entry.columnId) && (!entry.rowIds || entry.rowIds.has(task.rowId)))) continue;
			if (task.state.phase !== 'queued') task.state.controller.abort();
			this.tasks.delete(task.key);
			stopped.push(task);
		}
		this.publish(true);
		if (!stopped.length) return;
		// Only this tab's own running cells are restored; one queued here may be running elsewhere. A start still being saved is undone by its run.
		const bySheet = new Map<string, Set<string>>();
		for (const task of stopped) bySheet.set(task.sheetId, (bySheet.get(task.sheetId) ?? new Set()).add(task.rowId));
		const saved = await Promise.all([...bySheet].map(([sheetId, rowIds]) => this.store.rows(sheetId, [...rowIds])));
		const rows = new Map(saved.flat().map((row) => [JSON.stringify([row.sheetId, row.id]), row]));
		const changes = new Map<string, CellChange[]>();
		for (const task of stopped) {
			const cell = rows.get(JSON.stringify([task.sheetId, task.rowId]))?.cells[task.columnId];
			if (!isPendingCell(cell) || cell!.owner !== this.owner) continue;
			const list = changes.get(task.sheetId) ?? [];
			list.push({ rowId: task.rowId, columnId: task.columnId, expected: cell, update: () => cellTransition(cell, { type: 'cancel' }) });
			changes.set(task.sheetId, list);
		}
		await Promise.all([...changes].map(([sheetId, list]) => persist(sheetId, list)));
	}

	/** A column's rule changed: stop its queued and running cells and restore their previous values, instead of letting
	    them finish with the old rule. Returns the row IDs that were pending, so callers can run them again. */
	async supersede(sheetId: string, columnId: string): Promise<string[]> {
		const rowIds = [...this.tasks.values()].filter((task) => task.sheetId === sheetId && task.columnId === columnId).map((task) => task.rowId);
		await this.cancel({ sheetId, columnId });
		return rowIds;
	}

	/** Hold every queue (a signed-out session would fail each request), or release them. */
	hold(held: boolean) {
		if (this.held === held) return;
		this.held = held;
		if (!held) this.tick();
	}

	/** Continue a paused sheet's queue. With nothing queued this just dismisses the pause. */
	resume(sheetId: string) {
		if (!this.halts.delete(sheetId)) return;
		this.publish(true);
		this.tick();
	}

	/** Run the cells that paused the sheet again (those still failed), and continue its queue. */
	async retryFailed(sheetId: string): Promise<number> {
		const entry = this.halts.get(sheetId);
		if (!entry) return 0;
		const [sheet, saved] = await Promise.all([this.sheet(sheetId), this.store.rows(sheetId, entry.cells.map((cell) => cell.rowId))]);
		const columns = new Map(sheet?.columns.map((column) => [column.id, column]));
		const rows = new Map(saved.map((row) => [row.id, row]));
		const cells = entry.cells.flatMap(({ rowId, columnId }) => {
			const row = rows.get(rowId), column = columns.get(columnId);
			return row && column && row.cells[columnId]?.s === 'error' ? [{ row, column }] : [];
		});
		const added = this.add(sheetId, cells, {});
		if (!added) this.resume(sheetId);
		return added;
	}

	private halt(sheetId: string, cause: { reason: HaltReason; provider?: FailureProvider; message: string }, cell?: { rowId: string; columnId: string }) {
		const entry = this.halts.get(sheetId) ?? { halt: { sheetId, ...cause, failedCells: 0 }, cells: [] };
		if (cell) entry.cells.push(cell);
		entry.halt = { ...entry.halt, failedCells: entry.cells.length };
		this.halts.set(sheetId, entry);
		for (const task of this.tasks.values()) if (task.sheetId === sheetId && task.state.phase === 'queued') task.state = { phase: 'queued', starting: false };
		this.publish(true);
	}

	/** Start ready tasks up to the concurrency limit. Requests made during a pass are coalesced into one more pass. */
	private tick() {
		this.wake = true;
		if (this.ticking) return;
		this.ticking = true;
		void (async () => {
			try {
				await this.claim;
				while (this.wake) {
					this.wake = false;
					while (this.runs.size < this.concurrency()) {
						const ready = await this.nextReadyTask();
						if (!ready) break;
						this.start(ready);
					}
				}
			} catch (error) {
				// The local database could not be read: pause rather than strand the queue silently.
				const message = error instanceof Error ? error.message : 'Could not load the sheet.';
				for (const sheetId of new Set([...this.tasks.values()].filter((task) => this.waiting(task)).map((task) => task.sheetId))) this.halt(sheetId, { reason: 'save_failed', message });
			} finally {
				this.ticking = false;
			}
		})();
	}

	private start({ task, signature, op }: Ready) {
		const controller = new AbortController();
		task.state = { phase: 'running', controller, op, signature };
		this.runs.set(task.key, task);
		this.publish();
		void this.run(task, controller).catch((error) => this.runFailed(task, error)).finally(() => {
			if (this.runs.get(task.key) === task) this.runs.delete(task.key);
			if (this.tasks.get(task.key) === task) this.tasks.delete(task.key);
			this.generation += 1;
			this.publish();
			this.tick();
		});
	}

	/** Queued in this tab, not paused, and no earlier run for the cell is still finishing. */
	private waiting(task?: Task): task is Task {
		return !this.held && task !== undefined && this.tasks.get(task.key) === task && task.state.phase === 'queued' && !this.halts.has(task.sheetId) && !this.runs.has(task.key);
	}

	private unstart(task: Task) {
		if (task.state.phase !== 'queued' || !task.state.starting) return;
		task.state = { phase: 'queued', starting: false };
		this.publish();
	}

	private requeue(task: Task, attempts: number) {
		this.tasks.delete(task.key);
		this.tasks.set(task.key, { ...task, attempts, state: { phase: 'queued', starting: false } });
	}

	/** What planning treats as pending besides saved cells: this tab's tasks, and failures still being written. */
	private context(sheetId: string) {
		return { owner: this.owner, now: this.now(), pending: (rowId: string, columnId: string) => this.isPending(rowId, columnId, sheetId) || this.failing.has(cellKey(sheetId, rowId, columnId)) } satisfies PlanContext;
	}

	/** First queued task whose plan is ready. Cells that can never run fail; written failures can settle their dependents. */
	private async nextReadyTask(): Promise<Ready | null> {
		for (;;) {
			const failures: Failure[] = [];
			let ready: Ready | null;
			try { ready = await this.scan(failures); }
			finally { await this.fail(failures); }
			if (ready || !failures.length) return ready;
			this.publish();
		}
	}

	private async scan(failures: Failure[]): Promise<Ready | null> {
		const sheets = new Map<string, Promise<Sheet | undefined>>();
		const sheetRows = new Map<string, { generation: number; rows: Promise<Row[]> }>();
		const signatures = new Set<string>();
		for (const task of this.tasks.values()) if (task.state.phase === 'running') signatures.add(task.state.signature);
		const pause = yielder();
		let elsewhere = false;
		try {
			// Map iteration is live: tasks queued during the scan are visited too.
			for (const task of this.tasks.values()) {
				if (!this.waiting(task)) continue;
				if (task.unsaved) return { task, signature: JSON.stringify(['save', task.key]), op: task.unsaved.op };
				await pause();
				if (!sheets.has(task.sheetId)) sheets.set(task.sheetId, this.sheet(task.sheetId));
				const sheet = await sheets.get(task.sheetId);
				if (!this.waiting(task)) continue;
				let generation = this.generation, rows: Row[] = [];
				if (sheet && readsWholeSheet(sheet, task.columnId)) {
					let cached = sheetRows.get(sheet.id);
					if (cached?.generation !== generation) sheetRows.set(sheet.id, cached = { generation, rows: this.store.rows(sheet.id) });
					generation = cached.generation;
					rows = await cached.rows;
				} else if (sheet) rows = await this.store.rows(sheet.id, [task.rowId]);
				if (!this.waiting(task)) continue;
				const context = this.context(task.sheetId);
				const plan = sheet && planCell({ sheet, rows }, task, context);
				if (!plan || plan.column.type !== 'enriched' || this.finishedSince(task, plan)) { this.drop(task); continue; }
				// Another tab or an agent is running it: wait for its result, as for a dependency running elsewhere.
				if (plan.busy) { elsewhere = true; this.unstart(task); continue; }
				const { readiness } = plan;
				if (readiness.kind === 'ready') {
					// Identical inputs wait for the running request, which fills them when it finishes.
					const signature = JSON.stringify([task.sheetId, task.columnId, plan.version]);
					if (signatures.has(signature)) { this.unstart(task); continue; }
					return { task, signature, op: canonicalJson(plan.op)! };
				}
				if (readiness.kind === 'waiting' && readiness.started) {
					elsewhere ||= !context.pending(readiness.on.row.id, readiness.on.column.id);
					this.unstart(task);
					continue;
				}
				// Rows read before this tab's latest results landed may be outdated: decide on the next pass.
				if (generation !== this.generation) { this.unstart(task); continue; }
				// A saved result is never replaced by a reason it cannot run.
				if (plan.cell?.s === 'done') { this.drop(task); continue; }
				this.retire(task);
				failures.push({ task, cell: failureCell(plan, readiness.message), expected: plan.cell });
			}
			return null;
		} finally {
			if (elsewhere) this.recheckSoon();
		}
	}

	/** A result was saved since the task was queued, by another tab or an agent: it is waited on, never run twice. */
	private finishedSince(task: Task, plan: EnrichmentPlan) {
		return plan.finished && (task.unfinished || task.basis !== undefined && task.basis !== basisOf(plan.cell));
	}

	/** Another tab or an agent is running a cell a task waits on; nothing here hears when it lands, so look again later. */
	private recheckSoon() {
		this.recheckTimer ??= setTimeout(() => {
			this.recheckTimer = undefined;
			this.tick();
		}, this.ports.waitMs);
	}

	/** Drop a task the scan will not run. A task scanned earlier in the same pass may have waited on it as pending in this
	    tab, which schedules no recheck: the scan runs again. */
	private drop(task: Task) {
		this.tasks.delete(task.key);
		this.wake = true;
		this.publish();
	}

	/** Drop a task that is about to fail; the queue stays active until `fail` has written its error. */
	private retire(task: Task) {
		this.tasks.delete(task.key);
		this.failing.set(task.key, (this.failing.get(task.key) ?? 0) + 1);
		this.wake = true;
	}

	/** Write failures as compare-and-set against the cells they were planned from, so a retried commit never replays one
	    over a result saved meanwhile. */
	private async fail(failures: Failure[]) {
		if (!failures.length) return;
		this.generation += 1;
		const bySheet = new Map<string, CellChange[]>();
		for (const { task, cell, expected } of failures) {
			const changes = bySheet.get(task.sheetId) ?? [];
			changes.push({ rowId: task.rowId, columnId: task.columnId, expected, update: () => cell });
			bySheet.set(task.sheetId, changes);
		}
		try { await Promise.all([...bySheet].map(([sheetId, changes]) => this.store.updateCells(sheetId, changes))); }
		finally {
			for (const { task } of failures) {
				const count = this.failing.get(task.key)! - 1;
				if (count) this.failing.set(task.key, count);
				else this.failing.delete(task.key);
			}
		}
		this.publish();
	}

	/** Storage failed: pause the sheet rather than spend more requests. A finished run keeps its cell on the task (see
	    `Unsaved`), so resuming saves it without asking the provider again. A deleted sheet drops its work. */
	private runFailed(task: Task, error: unknown) {
		if (error instanceof CloudError && error.status === 404) {
			for (const entry of this.tasks.values()) if (entry.sheetId === task.sheetId) {
				if (entry.state.phase !== 'queued') entry.state.controller.abort();
				this.tasks.delete(entry.key);
			}
			this.halts.delete(task.sheetId);
			return;
		}
		if (this.tasks.get(task.key) !== task) return;
		this.requeue(task, task.attempts);
		this.halt(task.sheetId, { reason: 'save_failed', message: error instanceof Error ? error.message : 'Could not save enrichment results.' });
	}

	private async run(task: Task, controller: AbortController) {
		const { signal } = controller;
		const { unsaved } = task;
		let plan: EnrichmentPlan, duplicates: Row[], current: Cell | undefined;
		/** A pause can outlast the expiry rule: another viewer or an agent then fails the marker as interrupted. That cell
		    is still this run's to settle, and the result is saved if its inputs are unchanged. */
		const adoptExpired = async (marker: Cell | undefined) => {
			const saved = (await this.store.rows(task.sheetId, [task.rowId]))[0]?.cells[task.columnId];
			if (!saved || !marker || canonicalJson(saved) !== canonicalJson(cellTransition(marker, { type: 'expire' }, saved.t))) return false;
			current = saved;
			return true;
		};
		if (unsaved) {
			({ plan, duplicates, marker: current } = unsaved);
			await adoptExpired(unsaved.marker);
		} else {
			const [sheet, rows] = await Promise.all([this.sheet(task.sheetId), this.store.rows(task.sheetId)]);
			const planned = sheet && planCell({ sheet, rows }, task, this.context(task.sheetId));
			if (!sheet || !planned || planned.column.type !== 'enriched' || signal.aborted || this.finishedSince(task, planned)) return;
			// Inputs moved since the scan, or another tab or an agent started the cell: wait or fail as the queue decides,
			// rather than run on unsettled values or twice.
			if (planned.busy || planned.readiness.kind !== 'ready') { if (this.tasks.get(task.key) === task) this.requeue(task, task.attempts); return; }
			plan = planned;
			// Snapshot candidates before requesting so edits made during a run are preserved.
			duplicates = await this.duplicates(task, { sheet, rows }, plan);
			current = plan.cell;
		}
		const { op, row, column } = plan, sheetId = task.sheetId, opJson = canonicalJson(op)!;
		if (task.state.phase === 'running') task.state.op = opJson;

		/** Compare-and-set against what this run last saw. A start needs current inputs; a result whose rule changed
		    restores the previous value, and one whose inputs changed fails. A result the column's current format cannot
		    hold is saved as a failed cell, so saving never fails for its value. */
		const commit = async (next: Cell, kind: 'start' | 'result'): Promise<CommitOutcome> => {
			const expected = current;
			let outcome: CommitOutcome = 'skipped', written: Cell | undefined;
			const [applied] = await this.store.updateCells(sheetId, [{ rowId: row.id, columnId: column.id, expected, update: (freshSheet, freshRows) => {
				outcome = 'skipped';
				if (signal.aborted) return written = undefined;
				const grid = { sheet: freshSheet, rows: [...freshRows].sort(byOrder) };
				if (kind === 'start') return written = (outcome = recheck(plan, grid)) === 'applied' ? next : undefined;
				const settled = settleCell(plan, grid, next, expected);
				outcome = settled.outcome;
				return written = settled.cell;
			} }]);
			// A conflict replays the change on the workspace's version; when the cell changed there, `update` is not called
			// again and what an earlier attempt decided was never saved.
			if (!applied) {
				if (written) outcome = 'skipped';
				written = undefined;
			}
			if (written) current = written;
			return outcome;
		};

		const fillDuplicates = async (result: Cell) => {
			if (!duplicates.length || signal.aborted) return;
			let source: Row[] | undefined, ordered: Row[] = [];
			const context = this.context(sheetId);
			// Unfilled duplicates stay queued and run on their own, so a failed save here is not the run's failure.
			const applied = await this.store.updateCells(sheetId, duplicates.map((candidate) => ({ rowId: candidate.id, columnId: column.id, expected: candidate.cells[column.id], update: (freshSheet, freshRows) => {
				if (signal.aborted) return undefined;
				if (source !== freshRows) ordered = [...(source = freshRows)].sort(byOrder);
				const twin = planCell({ sheet: freshSheet, rows: ordered }, { rowId: candidate.id, columnId: column.id }, context);
				return twin?.readiness.kind === 'ready' && twin.version === plan.version ? result : undefined;
			} }))).catch(() => duplicates.map(() => false));
			for (const [i, candidate] of duplicates.entries()) {
				const key = cellKey(sheetId, candidate.id, column.id);
				if (applied[i] && this.tasks.get(key)?.state.phase === 'queued') this.tasks.delete(key);
			}
			this.publish();
		};

		/** Save a finished run's cell. The task holds it until it is saved, so a failed save pauses the sheet and resuming
		    saves it again instead of asking the provider again. */
		const finish = async (next: Cell): Promise<CommitOutcome> => {
			task.unsaved = { plan, duplicates, marker: current, next, op: opJson };
			const outcome = await commit(next, 'result');
			task.unsaved = undefined;
			if (outcome === 'applied') await fillDuplicates(current!);
			return outcome;
		};

		if (signal.aborted) return;
		if (unsaved) {
			// This tab's cache may not have shown the expiry yet; the commit's conflict replay has refreshed it.
			if (await finish(unsaved.next) === 'skipped' && current === unsaved.marker && await adoptExpired(unsaved.marker)) await finish(unsaved.next);
			return;
		}
		if (plan.local) { await finish(resultCell(plan, evaluate(op, plan.record))); return; }
		const started = await commit(startCell(plan, this.owner, this.now()), 'start');
		if (started !== 'applied') {
			// Inputs moved, or someone else changed the cell first: plan it again rather than fail, so a run started
			// elsewhere is waited on.
			if (this.tasks.get(task.key) === task) this.requeue(task, task.attempts);
			return;
		}
		try {
			if (signal.aborted) return;
			let result: EnrichResponse | undefined, error: unknown;
			try { result = await this.ports.enrich(op, plan.record, signal); }
			catch (caught) { error = caught; }
			if (signal.aborted) return;
			if (result && !result.error) { await finish(resultCell(plan, result.value, result.meta)); return; }
			const { message, failure, meta, retryable } = describeFailure(result, error);
			if (failure && FATAL.has(failure.reason)) {
				const applied = await finish(failureCell(plan, message, meta, undefined, current)) === 'applied';
				this.halt(task.sheetId, { reason: failure.reason as HaltReason, provider: failure.provider, message }, applied ? { rowId: row.id, columnId: column.id } : undefined);
				return;
			}
			if (retryable && task.attempts + 1 < MAX_ATTEMPTS) return await this.backoff(task, controller, opJson);
			await finish(failureCell(plan, message, meta, undefined, current));
		} finally {
			// A stopped or superseded run leaves the cell as it found it.
			if (signal.aborted && isPendingCell(current)) {
				const pending = current;
				await this.store.updateCells(sheetId, [{ rowId: row.id, columnId: column.id, expected: pending, update: () => cellTransition(pending, { type: 'cancel' }) }]);
			}
		}
	}

	/** Wait, holding the concurrency slot, then queue the next attempt. The saved cell stays `running` meanwhile. */
	private async backoff(task: Task, controller: AbortController, op: string) {
		if (this.tasks.get(task.key) !== task) return;
		task.state = { phase: 'backoff', controller, op };
		this.publish();
		await sleep(1500 * 2 ** task.attempts, controller.signal);
		if (!controller.signal.aborted && this.tasks.get(task.key) === task) this.requeue(task, task.attempts + 1);
	}

	/** Empty cells with identical inputs that one request can fill. */
	private async duplicates(task: Task, grid: Grid, plan: EnrichmentPlan): Promise<Row[]> {
		const pause = yielder();
		const context = this.context(task.sheetId);
		const found: Row[] = [];
		for (const candidate of grid.rows) {
			if (candidate.id === task.rowId || task.targetRowIds && !task.targetRowIds.has(candidate.id)) continue;
			const cell = candidate.cells[plan.column.id];
			if (cell?.s === 'done' || cell?.s === 'running' || cell?.f || cell?.v != null && cell.v !== '') continue;
			const key = cellKey(task.sheetId, candidate.id, plan.column.id);
			if (this.runs.has(key) || this.tasks.get(key)?.state.phase === 'running' || this.tasks.get(key)?.state.phase === 'backoff') continue;
			await pause();
			const twin = planCell(grid, { rowId: candidate.id, columnId: plan.column.id }, context);
			if (twin?.readiness.kind === 'ready' && twin.version === plan.version) found.push(candidate);
		}
		return found;
	}
}

const indexedDbStore: RunnerStore = {
	sheet: (sheetId) => db.sheets.get(sheetId),
	async rows(sheetId, rowIds) {
		if (!rowIds) return db.rows.where('sheetId').equals(sheetId).sortBy('order');
		return (await db.rows.bulkGet([...rowIds])).filter((row): row is Row => row?.sheetId === sheetId).sort(byOrder);
	},
	updateCells: updateCellsIf,
};

function tabOwner() {
	try { return claimTabOwner(sessionStorage, navigator.locks); } catch { return undefined; }
}

export const runner = new Runner({ store: indexedDbStore, enrich: enrichCell, concurrency: () => loadSettings().concurrency, waitMs: 2_000, owner: tabOwner(), now: serverNow });
