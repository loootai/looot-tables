import 'server-only';

import type { Account } from '../auth-identity';
import { DEFAULT_SHEET_CAP_USD, HALT_AFTER_MISSES } from '../run-cost';
import type { Database, Sql } from './database';
import { EnrichError, failure } from './enrich-failure';

/* The server's money guard for looot runs, in Postgres so no browser can skip it. Before a cell (or a batch) is sent,
   `admit` checks the sheet's spend cap and the column's miss streak, holds the most the run may cost, and stores the
   run's idempotency seed. `settle` turns the hold into what looot charged and counts hits and misses: 20 misses or
   errors in a row halt the column until `resumeColumn`.

   One cell run keeps one seed for all its retries: a retry after an unknown outcome (a timeout, a dropped connection)
   resends the same idempotency keys, so looot answers with the run it already has instead of charging again. Only a
   failure looot settled unbilled and marked retryable moves the run to a fresh generation of keys, because looot
   would otherwise replay that same failure. */

export interface CellRef { sheetId: string; rowId: string; columnId: string }
export type RunVerdict = 'hit' | 'miss' | 'error';
export interface SheetSpend { capUsd: number; spentUsd: number; heldUsd: number; haltedColumns: string[] }

const toMicros = (usd: number) => Math.max(0, Math.round(usd * 1e6));
const toUsd = (micros: unknown) => Number(micros ?? 0) / 1e6;
/** One workspace's writes serialize on its row lock; see `Database.transaction`. */
type Actor = Pick<Account, 'issuer' | 'organization'>;

export class SpendGuard {
	constructor(private readonly database: Database, private readonly actor: Actor) {}

	#write<T>(run: (sql: Sql, workspace: string) => Promise<T>) {
		return this.database.transaction(run, { workspace: this.actor });
	}

	async #sheet(sql: Sql, workspace: string, sheetId: string) {
		await sql.query('INSERT INTO enrichable.sheet_spend (workspace_id, sheet_id, cap_micros) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [workspace, sheetId, toMicros(DEFAULT_SHEET_CAP_USD)]);
		const { rows } = await sql.query('SELECT cap_micros, spent_micros, held_micros FROM enrichable.sheet_spend WHERE workspace_id = $1 AND sheet_id = $2', [workspace, sheetId]);
		return { cap: Number(rows[0].cap_micros), spent: Number(rows[0].spent_micros), held: Number(rows[0].held_micros) };
	}

	/** Hold `holdUsd` for one run of `cell` and return the seed its idempotency keys derive from. Throws `spend_capped`
	    when the sheet cannot afford it and `column_halted` after too many misses. A run already admitted reuses its seed
	    and its hold. */
	async admit(cell: CellRef, attempt: string, holdUsd: number): Promise<{ seed: string; replay: boolean }> {
		return this.#write(async (sql, workspace) => {
			const { rows: [known] } = await sql.query('SELECT generation, status, held_micros FROM enrichable.cell_runs WHERE workspace_id = $1 AND attempt = $2', [workspace, attempt]);
			if (known && known.status !== 'retry') return { seed: `${attempt}.${known.generation}`, replay: true };
			const { rows: [streak] } = await sql.query('SELECT halted FROM enrichable.column_streaks WHERE workspace_id = $1 AND sheet_id = $2 AND column_id = $3', [workspace, cell.sheetId, cell.columnId]);
			if (streak?.halted) throw new EnrichError(`This column stopped after ${HALT_AFTER_MISSES} misses or errors in a row. Check its inputs, then resume it.`, failure('column_halted', 'looot'));
			const sheet = await this.#sheet(sql, workspace, cell.sheetId);
			const hold = toMicros(holdUsd);
			if (sheet.spent + sheet.held + hold > sheet.cap) throw new EnrichError(`This sheet's spend cap is $${toUsd(sheet.cap).toFixed(2)} and $${toUsd(sheet.spent + sheet.held).toFixed(2)} is spent or held. Raise the cap to run more.`, failure('spend_capped', 'looot'));
			await sql.query('UPDATE enrichable.sheet_spend SET held_micros = held_micros + $3 WHERE workspace_id = $1 AND sheet_id = $2', [workspace, cell.sheetId, hold]);
			const generation = known ? Number(known.generation) + 1 : 0;
			await sql.query(`INSERT INTO enrichable.cell_runs (workspace_id, attempt, sheet_id, row_id, column_id, generation, status, held_micros) VALUES ($1, $2, $3, $4, $5, $6, 'dispatched', $7)
				ON CONFLICT (workspace_id, attempt) DO UPDATE SET generation = EXCLUDED.generation, status = 'dispatched', held_micros = EXCLUDED.held_micros`, [workspace, attempt, cell.sheetId, cell.rowId, cell.columnId, generation, hold]);
			return { seed: `${attempt}.${generation}`, replay: false };
		});
	}

	/** Record what a run cost (its total so far, so settling twice never counts twice), release its hold and count its
	    verdicts toward the column's streak. `retry`: looot settled it unbilled and a later attempt may succeed.
	    `final: false` keeps the hold (a batch that is not complete yet) and counts no verdicts. */
	async settle(attempt: string, outcome: { chargedUsd: number; verdicts: RunVerdict[]; retry?: boolean; final?: boolean }): Promise<{ halted: boolean }> {
		return this.#write(async (sql, workspace) => {
			const { rows: [run] } = await sql.query('SELECT sheet_id, column_id, status, held_micros, charged_micros FROM enrichable.cell_runs WHERE workspace_id = $1 AND attempt = $2', [workspace, attempt]);
			if (!run) return { halted: false };
			const charged = toMicros(outcome.chargedUsd);
			const delta = charged - Number(run.charged_micros);
			const final = outcome.final !== false;
			const release = final ? Number(run.held_micros) : 0;
			await sql.query('UPDATE enrichable.sheet_spend SET spent_micros = GREATEST(0, spent_micros + $3), held_micros = GREATEST(0, held_micros - $4) WHERE workspace_id = $1 AND sheet_id = $2', [workspace, run.sheet_id, delta, release]);
			const status = !final ? 'dispatched' : outcome.retry && charged === 0 ? 'retry' : 'settled';
			await sql.query('UPDATE enrichable.cell_runs SET charged_micros = GREATEST(charged_micros, $3), held_micros = held_micros - $4, status = $5 WHERE workspace_id = $1 AND attempt = $2', [workspace, attempt, charged, release, status]);
			// A replayed run was counted when it first settled.
			if (!final || run.status === 'settled' || !outcome.verdicts.length) return { halted: false };
			await sql.query('INSERT INTO enrichable.column_streaks (workspace_id, sheet_id, column_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [workspace, run.sheet_id, run.column_id]);
			const { rows: [streak] } = await sql.query('SELECT misses, halted FROM enrichable.column_streaks WHERE workspace_id = $1 AND sheet_id = $2 AND column_id = $3 FOR UPDATE', [workspace, run.sheet_id, run.column_id]);
			let misses = Number(streak.misses), halted = Boolean(streak.halted);
			for (const verdict of outcome.verdicts) {
				misses = verdict === 'hit' ? 0 : misses + 1;
				if (misses >= HALT_AFTER_MISSES) halted = true;
			}
			await sql.query('UPDATE enrichable.column_streaks SET misses = $4, halted = $5 WHERE workspace_id = $1 AND sheet_id = $2 AND column_id = $3', [workspace, run.sheet_id, run.column_id, misses, halted]);
			return { halted };
		});
	}

	/** The sheet's cap, what it spent and holds, and which columns are halted. */
	async state(sheetId: string): Promise<SheetSpend> {
		return this.#write(async (sql, workspace) => {
			const sheet = await this.#sheet(sql, workspace, sheetId);
			const { rows } = await sql.query('SELECT column_id FROM enrichable.column_streaks WHERE workspace_id = $1 AND sheet_id = $2 AND halted', [workspace, sheetId]);
			return { capUsd: toUsd(sheet.cap), spentUsd: toUsd(sheet.spent), heldUsd: toUsd(sheet.held), haltedColumns: rows.map((row) => String(row.column_id)) };
		});
	}

	async setCap(sheetId: string, capUsd: number): Promise<SheetSpend> {
		await this.#write(async (sql, workspace) => {
			await this.#sheet(sql, workspace, sheetId);
			await sql.query('UPDATE enrichable.sheet_spend SET cap_micros = $3 WHERE workspace_id = $1 AND sheet_id = $2', [workspace, sheetId, toMicros(capUsd)]);
		});
		return this.state(sheetId);
	}

	/** Clear a column's streak so its next cells run again. */
	async resumeColumn(sheetId: string, columnId: string): Promise<void> {
		await this.#write((sql, workspace) => sql.query('UPDATE enrichable.column_streaks SET misses = 0, halted = false WHERE workspace_id = $1 AND sheet_id = $2 AND column_id = $3', [workspace, sheetId, columnId]));
	}
}
