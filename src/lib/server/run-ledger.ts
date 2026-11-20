import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Account } from '../auth-identity';
import { WorkspaceError } from '../workspace';
import { workspaceId, type Database, type Rows } from './database';

/* Quotes and budgeted runs, in Postgres so every server and both front doors (the MCP endpoint and the in-app agent) see
   the same ones. A quote is free: it names the cells a run may fill and the most they can cost. A run needs a quote and
   the caller's budget; the same quote and idempotency key always return the same run, so a retried request never starts
   a second one. Cancelling sets a flag the running request reads before it starts each cell. */

/** How long a quote can be run. Prices and the sheet move on; an old quote asks the agent to quote again. */
export const QUOTE_TTL_MS = 30 * 60_000;
/** A run still marked running after this was cut off with its request (the route limit is 300 s). */
export const RUN_LEASE_MS = 330_000;

export type QuoteKind = 'column' | 'find';
export interface QuoteRecord {
	id: string;
	kind: QuoteKind;
	sheetId: string;
	columnId: string | null;
	/** What was quoted: the rows, the mode, or the search. Run reads it back instead of trusting new arguments. */
	request: Record<string, unknown>;
	/** Fingerprint of the column operation or search when quoted; a different one makes the quote stale. */
	opHash: string;
	cells: number;
	perCellUsd: number;
	maxUsd: number;
	createdAt: number;
	expiresAt: number;
}
export type RunStatus = 'running' | 'finished' | 'cancelled' | 'uncertain';
export interface RunRecord {
	id: string;
	quoteId: string;
	idempotencyKey: string;
	sheetId: string;
	columnId: string | null;
	budgetUsd: number;
	status: RunStatus;
	cancelRequested: boolean;
	cells: number;
	done: number;
	spentUsd: number;
	result: Record<string, unknown> | null;
	startedAt: number;
	updatedAt: number;
}

const micros = (usd: number) => Math.max(0, Math.round(usd * 1e6));
const usd = (value: unknown) => Number(value ?? 0) / 1e6;
const newId = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`;

const quoteOf = (row: Rows[number]): QuoteRecord => ({ id: String(row.id), kind: row.kind as QuoteKind, sheetId: String(row.sheet_id), columnId: row.column_id === null ? null : String(row.column_id), request: row.request as Record<string, unknown>, opHash: String(row.op_hash), cells: Number(row.cells), perCellUsd: usd(row.per_cell_micros), maxUsd: usd(row.max_micros), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) });
const runOf = (row: Rows[number]): RunRecord => ({ id: String(row.id), quoteId: String(row.quote_id), idempotencyKey: String(row.idempotency_key), sheetId: String(row.sheet_id), columnId: row.column_id === null ? null : String(row.column_id), budgetUsd: usd(row.budget_micros), status: row.status as RunStatus, cancelRequested: Boolean(row.cancel_requested), cells: Number(row.cells), done: Number(row.done), spentUsd: usd(row.spent_micros), result: (row.result as Record<string, unknown> | null) ?? null, startedAt: Number(row.started_at), updatedAt: Number(row.updated_at) });

export class RunLedger {
	constructor(private readonly database: Database, private readonly actor: Pick<Account, 'issuer' | 'organization'>, private readonly now: () => number = Date.now) {}

	#write<T>(run: (sql: { query(text: string, values?: unknown[]): Promise<{ rows: Rows }> }, workspace: string) => Promise<T>) {
		return this.database.transaction(run, { workspace: this.actor });
	}

	async saveQuote(quote: Omit<QuoteRecord, 'id' | 'createdAt' | 'expiresAt'>): Promise<QuoteRecord> {
		const now = this.now();
		const saved: QuoteRecord = { ...quote, id: newId('q'), createdAt: now, expiresAt: now + QUOTE_TTL_MS };
		await this.#write((sql, workspace) => sql.query('INSERT INTO looot_tables.run_quotes (workspace_id,id,kind,sheet_id,column_id,request,op_hash,cells,per_cell_micros,max_micros,created_at,expires_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)', [workspace, saved.id, saved.kind, saved.sheetId, saved.columnId, JSON.stringify(saved.request), saved.opHash, saved.cells, micros(saved.perCellUsd), micros(saved.maxUsd), saved.createdAt, saved.expiresAt]));
		return saved;
	}

	/** The quote, or a 404 naming what to do. An expired quote is refused with 410. */
	async quote(id: string): Promise<QuoteRecord> {
		const row = (await this.database.read('SELECT * FROM looot_tables.run_quotes WHERE workspace_id=$1 AND id=$2', [workspaceId(this.actor), id])).rows[0];
		if (!row) throw new WorkspaceError('Unknown quoteId. Call quote_run (or find_rows with preview) first, show the quote to the user, then run with its quoteId.', 404);
		const quote = quoteOf(row);
		if (quote.expiresAt <= this.now()) throw new WorkspaceError('This quote expired after 30 minutes. Quote the run again; prices and the sheet may have changed.', 410);
		return quote;
	}

	/** Start a run of `quote`, or return the run this quote and key already started (`started: false`). */
	async start(quote: QuoteRecord, idempotencyKey: string, budgetUsd: number, cells: number): Promise<{ run: RunRecord; started: boolean }> {
		return this.#write(async (sql, workspace) => {
			const now = this.now();
			await sql.query("UPDATE looot_tables.agent_runs SET status='uncertain', updated_at=$2 WHERE workspace_id=$1 AND status='running' AND updated_at<$3", [workspace, now, now - RUN_LEASE_MS]);
			const known = (await sql.query('SELECT * FROM looot_tables.agent_runs WHERE workspace_id=$1 AND quote_id=$2 AND idempotency_key=$3', [workspace, quote.id, idempotencyKey])).rows[0];
			if (known) return { run: runOf(known), started: false };
			const id = newId('run');
			const row = (await sql.query("INSERT INTO looot_tables.agent_runs (workspace_id,id,quote_id,idempotency_key,sheet_id,column_id,budget_micros,status,cells,started_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$9) RETURNING *", [workspace, id, quote.id, idempotencyKey, quote.sheetId, quote.columnId, micros(budgetUsd), cells, now])).rows[0];
			return { run: runOf(row), started: true };
		});
	}

	/** Record progress; answers whether the user asked to stop. */
	async progress(runId: string, done: number, spentUsd: number): Promise<{ cancelRequested: boolean }> {
		return this.#write(async (sql, workspace) => {
			const row = (await sql.query('UPDATE looot_tables.agent_runs SET done=$3, spent_micros=$4, updated_at=$5 WHERE workspace_id=$1 AND id=$2 RETURNING cancel_requested', [workspace, runId, done, micros(spentUsd), this.now()])).rows[0];
			return { cancelRequested: Boolean(row?.cancel_requested) };
		});
	}

	async finish(runId: string, status: Exclude<RunStatus, 'running'>, done: number, spentUsd: number, result: Record<string, unknown>): Promise<RunRecord> {
		return this.#write(async (sql, workspace) => runOf((await sql.query('UPDATE looot_tables.agent_runs SET status=$3, done=$4, spent_micros=$5, result=$6::jsonb, updated_at=$7 WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspace, runId, status, done, micros(spentUsd), JSON.stringify(result), this.now()])).rows[0]));
	}

	/** Ask a running run to stop starting cells. Cells already started finish and are saved. */
	async cancel(runId: string): Promise<RunRecord> {
		return this.#write(async (sql, workspace) => {
			const row = (await sql.query('UPDATE looot_tables.agent_runs SET cancel_requested=true, updated_at=$3 WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspace, runId, this.now()])).rows[0];
			if (!row) throw new WorkspaceError('Unknown runId.', 404);
			return runOf(row);
		});
	}

	async run(runId: string): Promise<RunRecord> {
		const row = (await this.database.read('SELECT * FROM looot_tables.agent_runs WHERE workspace_id=$1 AND id=$2', [workspaceId(this.actor), runId])).rows[0];
		if (!row) throw new WorkspaceError('Unknown runId.', 404);
		const run = runOf(row);
		return run.status === 'running' && run.updatedAt < this.now() - RUN_LEASE_MS ? { ...run, status: 'uncertain' } : run;
	}

	/** The latest runs of a sheet (or one of its columns), newest first. */
	async runs(sheetId: string, columnId?: string, limit = 10): Promise<RunRecord[]> {
		const { rows } = await this.database.read(`SELECT * FROM looot_tables.agent_runs WHERE workspace_id=$1 AND sheet_id=$2 ${columnId ? 'AND column_id=$4' : ''} ORDER BY started_at DESC LIMIT $3`, columnId ? [workspaceId(this.actor), sheetId, limit, columnId] : [workspaceId(this.actor), sheetId, limit]);
		return rows.map(runOf);
	}
}
