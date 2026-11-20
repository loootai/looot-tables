import 'server-only';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { canonicalJson } from '../cell-content';
import { planCell, type EnrichmentPlan } from '../enrichment-plan';
import { evaluatesLocally, missingProviders } from '../operations';
import { batchJob, quoteLabel, TRY_ROWS } from '../run-cost';
import { formatValue } from '../template';
import type { CellValue, Column, ColumnOp, Row } from '../types';
import { WorkspaceError } from '../workspace';
import type { CellOutcome } from './mcp-tools';
import { quoteRun } from './quote';
import { Budget } from './run-budget';
import type { QuoteRecord, RunRecord } from './run-ledger';
import type { SheetTools } from './sheet-tools';
import type { SHEET_TOOLS } from './tool-specs';

/* Budgeted column runs: quote_run (free) → the user agrees → run_column with the quote id and a budget. The quote fixes
   which cells run; the run re-checks the column has not changed, holds each paid cell against its per-cell cap, the run's
   budget and the sheet's spend cap (SpendGuard) before it starts, and saves every result as it settles. */

/** Cells in flight at once, as the browser's default concurrency. */
export const RUN_CONCURRENCY = 4;
/** No cell starts unless its slowest plausible run ends before this, inside the routes' 300 s limit. */
const RUN_DEADLINE_MS = 280_000;

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
export const opHash = (value: unknown) => createHash('sha256').update(canonicalJson(value) ?? '').digest('hex').slice(0, 32);

function enrichedColumn(columns: readonly Column[], columnId: string): Column & { op: ColumnOp } {
	const column = columns.find((entry) => entry.id === columnId);
	if (!column) throw new WorkspaceError(`No column with id ${columnId}. list_sheets shows the column ids.`, 404);
	if (column.type !== 'enriched' || !column.op) throw new WorkspaceError(`“${column.name}” is a source column; only enriched columns run. Add one with configure_column, add_looot_column or add_contact_columns.`, 422);
	return column as Column & { op: ColumnOp };
}

export async function quoteColumnRun(tools: SheetTools, args: z.infer<typeof SHEET_TOOLS.quote_run.schema>) {
	const snapshot = await tools.readSnapshot(args.sheetId);
	tools.assertRunnable(snapshot);
	const column = enrichedColumn(snapshot.sheet.columns, args.columnId);
	const ids = args.rowIds ?? snapshot.rows.map((row) => row.id);
	const targets: EnrichmentPlan[] = [];
	let finished = 0, waiting = 0, running = 0;
	for (const rowId of ids) {
		const plan = planCell(snapshot, { rowId, columnId: column.id }, { now: Date.now() });
		if (!plan) throw new WorkspaceError(`Unknown row ${rowId}.`, 404);
		if (plan.finished && args.mode === 'unfinished') { finished++; continue; }
		if (plan.busy) { running++; continue; }
		if (plan.readiness.kind === 'waiting') { waiting++; continue; }
		targets.push(plan);
	}
	const chosen = targets.slice(0, args.limit ?? targets.length);
	const access = tools.providerAccess;
	const quote = await quoteRun(access.key('looot') ? access.looot() : null, column.op, chosen.length, chosen.slice(0, 500).map((plan) => plan.record));
	const free = evaluatesLocally(column.op) || quote.perCellMaxUsd === 0;
	const spend = await tools.spendGuard?.state(args.sheetId);
	const remainingUsd = spend ? round(Math.max(0, spend.capUsd - spend.spentUsd - spend.heldUsd)) : null;
	const saved = await tools.ledger.saveQuote({ kind: 'column', sheetId: args.sheetId, columnId: column.id, request: { rowIds: chosen.map((plan) => plan.row.id), mode: args.mode }, opHash: opHash(column.op), cells: chosen.length, perCellUsd: quote.perCellMaxUsd, maxUsd: quote.maxUsd });
	const tryRows = Math.min(TRY_ROWS, chosen.length);
	const tryMaxUsd = round(Math.min(quote.maxUsd, tryRows * quote.perCellMaxUsd));
	const missing = missingProviders(column.op, (provider) => Boolean(access.key(provider)));
	return {
		quoteId: saved.id, sheetId: args.sheetId, columnId: column.id, column: column.name, operation: column.op.kind,
		job: batchJob(column.op) ?? (column.op.kind === 'looot' ? column.op.endpointId : null),
		cells: chosen.length, alreadyFinished: finished, waitingOnOtherColumns: waiting, alreadyRunning: running,
		free, perCellMaxUsd: quote.perCellMaxUsd, maxUsd: quote.maxUsd, typicalUsd: quote.typicalUsd, priceSource: quote.source,
		label: quoteLabel(quote), tryFirst: { rows: tryRows, maxUsd: tryMaxUsd, label: quoteLabel({ cells: tryRows, maxUsd: tryMaxUsd }) },
		sheetCap: spend ? { capUsd: spend.capUsd, spentUsd: spend.spentUsd, heldUsd: spend.heldUsd, remainingUsd } : null,
		fitsSheetCap: remainingUsd === null || quote.maxUsd <= remainingUsd,
		missingKeys: missing, expiresAt: new Date(saved.expiresAt).toISOString(),
		next: chosen.length === 0 ? (waiting ? 'Nothing can run yet: run the columns these cells read first.' : 'Nothing to run: every cell is finished. Use mode "all" to run them again.')
			: missing.length ? `Add the ${missing.join(' and ')} key first: these cells cannot run without it.`
			: free ? 'Free to run: call run_column with this quoteId, maxUsd 0 and a fresh idempotencyKey.'
			: `Show the user “${quoteLabel(quote)}” and the 5-row trial “${quoteLabel({ cells: tryRows, maxUsd: tryMaxUsd })}”. Run only after they agree: run_column with this quoteId, maxUsd at most what they approved, and a fresh idempotencyKey (rows: 5 for the trial).`,
	};
}

/** What a run's outcomes add up to, in the words get_run_status uses too. */
function summarize(outcomes: CellOutcome[]) {
	const count = (test: (outcome: CellOutcome) => boolean) => outcomes.filter(test).length;
	const blank = (value: CellValue | undefined) => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
	const byProvider: Record<string, number> = {};
	for (const outcome of outcomes) {
		const provider = outcome.cell?.m?.looot?.find((call) => call.outcome === 'hit' || call.outcome === 'weak')?.provider ?? (outcome.cell?.m?.moltsets?.outcome === 'hit' ? 'moltsets' : undefined);
		if (provider) byProvider[provider] = (byProvider[provider] ?? 0) + 1;
	}
	return {
		filled: count((o) => o.status === 'done' && !blank(o.cell?.v)),
		empty: count((o) => o.status === 'done' && blank(o.cell?.v)),
		errors: count((o) => o.status === 'error'),
		skipped: count((o) => o.status === 'skipped' || o.status === 'blocked' || o.status === 'conflict'),
		notStarted: count((o) => o.status === 'not_started'),
		byProvider,
	};
}

/** A cell's outcome as a run reports it: the value as text, never the whole receipt (get_cell_details has that). */
const compact = (outcome: CellOutcome) => ({ rowId: outcome.rowId, status: outcome.status, ...(outcome.cell && outcome.status === 'done' ? { value: formatValue(outcome.cell.v).slice(0, 200) } : {}), ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.costUsd ? { costUsd: outcome.costUsd } : {}) });

export interface RunProgress { done: number; total: number; spentUsd: number; outcome?: ReturnType<typeof compact> }

export async function runQuotedColumn(tools: SheetTools, args: z.infer<typeof SHEET_TOOLS.run_column.schema>, onProgress?: (progress: RunProgress) => void) {
	const quote = await tools.ledger.quote(args.quoteId);
	if (quote.kind !== 'column') throw new WorkspaceError('This quote is for finding rows: run it with find_rows.', 400);
	const snapshot = await tools.readSnapshot(quote.sheetId);
	tools.assertRunnable(snapshot);
	const column = enrichedColumn(snapshot.sheet.columns, quote.columnId!);
	if (opHash(column.op) !== quote.opHash) throw new WorkspaceError(`“${column.name}” changed since it was quoted. Quote it again and show the user the new price.`, 409);
	const paid = quote.perCellUsd > 0;
	if (paid && args.maxUsd < quote.perCellUsd) throw new WorkspaceError(`maxUsd $${args.maxUsd} is below one cell’s cap ($${quote.perCellUsd}), so no cell could start. Use the quote’s maxUsd or tryFirst.maxUsd.`, 400);
	const rowIds = (quote.request.rowIds as string[]).slice(0, args.rows ?? Infinity);
	const { run, started } = await tools.ledger.start(quote, args.idempotencyKey, args.maxUsd, rowIds.length);
	if (!started) return { ...runView(run), replayed: true, next: run.status === 'running' ? 'This run is still going: call get_run_status with its runId.' : 'This idempotency key already ran: its result is above. Use a new key to run again.' };
	return executeRun(tools, quote, run, rowIds, { overwrite: quote.request.mode === 'all', budget: new Budget(paid ? args.maxUsd : Number.POSITIVE_INFINITY), onProgress });
}

async function executeRun(tools: SheetTools, quote: QuoteRecord, run: RunRecord, rowIds: string[], options: { overwrite: boolean; budget: Budget; onProgress?: (progress: RunProgress) => void }) {
	const started = Date.now();
	const outcomes: CellOutcome[] = [];
	const queue = [...rowIds];
	let cancelled = false, done = 0;
	const snapshot = await tools.readSnapshot(quote.sheetId);
	const present = new Set(snapshot.rows.map((row) => row.id));
	const worstCaseMs = rowIds.length ? (planCell(snapshot, { rowId: rowIds[0], columnId: quote.columnId! })?.worstCaseMs ?? 0) : 0;
	const worker = async () => {
		for (let rowId = queue.shift(); rowId !== undefined; rowId = queue.shift()) {
			if (cancelled) { outcomes.push({ rowId, status: 'not_started', error: 'Stopped by the user.' }); continue; }
			if (Date.now() - started + worstCaseMs > RUN_DEADLINE_MS) { outcomes.push({ rowId, status: 'not_started', error: 'Time limit for one request: run again with a new idempotencyKey to continue.' }); continue; }
			if (!present.has(rowId)) { outcomes.push({ rowId, status: 'skipped', error: 'The row was deleted.' }); continue; }
			let outcome: CellOutcome;
			try { outcome = await tools.enrichCell(quote.sheetId, rowId, quote.columnId!, options.overwrite, options.budget); }
			catch (error) { outcome = { rowId, status: 'error', error: error instanceof WorkspaceError ? error.message : 'This cell could not run.' }; }
			outcomes.push(outcome);
			if (outcome.status !== 'not_started') done++;
			options.onProgress?.({ done: outcomes.length, total: rowIds.length, spentUsd: options.budget.spentUsd, outcome: compact(outcome) });
			({ cancelRequested: cancelled } = await tools.ledger.progress(run.id, done, options.budget.spentUsd));
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, rowIds.length) }, worker));
	} catch (error) {
		await tools.ledger.finish(run.id, 'uncertain', done, options.budget.spentUsd, { message: 'The run was interrupted. Read the sheet before running again.' });
		throw error;
	}
	const order = new Map(rowIds.map((rowId, index) => [rowId, index]));
	outcomes.sort((a, b) => (order.get(a.rowId) ?? 0) - (order.get(b.rowId) ?? 0));
	const summary = summarize(outcomes);
	const result = { ...summary, spentUsd: options.budget.spentUsd, outcomes: outcomes.map(compact) };
	const finished = await tools.ledger.finish(run.id, cancelled ? 'cancelled' : 'finished', done, options.budget.spentUsd, result);
	const rest = (quote.request.rowIds as string[]).length - rowIds.length;
	return {
		...runView(finished), ...result,
		next: summary.notStarted ? 'Some cells did not start (budget, time limit or stop). Quote again for the rest, or run this quote again with a new idempotencyKey.'
			: rest > 0 ? `This was a trial of ${rowIds.length}. ${rest} more cells are quoted: show the user the result and ask before running them (run_column with the same quoteId, no rows, a new idempotencyKey).`
			: 'Done. Read the results with query_rows, or see get_next_steps for follow-up columns.',
	};
}

const runView = (run: RunRecord) => ({ runId: run.id, quoteId: run.quoteId, sheetId: run.sheetId, columnId: run.columnId, status: run.status, cells: run.cells, done: run.done, budgetUsd: run.budgetUsd, spentUsd: run.spentUsd, startedAt: new Date(run.startedAt).toISOString(), ...(run.result ? { result: run.result } : {}) });

/** A column's state from its cells: what is filled, what came back empty or failed, what is left, and what it cost. */
export function columnStats(column: Column, rows: readonly Row[]) {
	let filled = 0, empty = 0, errors = 0, running = 0, todo = 0, costUsd = 0;
	const providers: Record<string, number> = {};
	for (const row of rows) {
		const cell = row.cells[column.id];
		costUsd += cell?.m?.costUsd ?? 0;
		if (!cell || cell.s === 'idle') todo++;
		else if (cell.s === 'running' || cell.s === 'queued') running++;
		else if (cell.s === 'error') errors++;
		else if (cell.v === null || cell.v === '' || (Array.isArray(cell.v) && !cell.v.length)) empty++;
		else filled++;
		const provider = cell?.m?.looot?.find((call) => call.outcome === 'hit' || call.outcome === 'weak')?.provider ?? (cell?.m?.moltsets?.outcome === 'hit' ? 'moltsets' : undefined);
		if (provider) providers[provider] = (providers[provider] ?? 0) + 1;
	}
	const settled = filled + empty + errors;
	return { columnId: column.id, column: column.name, rows: rows.length, filled, empty, errors, running, toRun: todo, fillRate: settled ? Math.round((filled / settled) * 1000) / 1000 : null, costUsd: round(costUsd), providers };
}

export async function runStatus(tools: SheetTools, args: z.infer<typeof SHEET_TOOLS.get_run_status.schema>) {
	if (args.runId) {
		const run = await tools.ledger.run(args.runId);
		const { sheet, rows } = await tools.readSnapshot(run.sheetId);
		const column = sheet.columns.find((entry) => entry.id === run.columnId);
		return { run: runView(run), column: column ? columnStats(column, rows) : null };
	}
	if (!args.sheetId) throw new WorkspaceError('Pass runId, or sheetId (and columnId).', 400);
	const { sheet, rows } = await tools.readSnapshot(args.sheetId);
	const columns = sheet.columns.filter((column) => column.type === 'enriched' && (!args.columnId || column.id === args.columnId));
	return { runs: (await tools.ledger.runs(args.sheetId, args.columnId, 5)).map(runView), columns: columns.map((column) => columnStats(column, rows)), spend: await tools.spendGuard?.state(args.sheetId) ?? null };
}
