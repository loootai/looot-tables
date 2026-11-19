'use client';

import { appendRows, db, newColumn, onSheetRemoved, updateSheet } from './db';
import { foundRecords, foundRowColumns, foundRowKey } from './found-rows';
import { streamPopulate } from './populate-client';
import { RowArrivalPacer } from './row-arrival-pacer';
import { MAX_ROWS } from './workspace';
import type { EnrichFailure, PopulateRequest, Row, Sheet } from './types';

/**
 * idle → finding → finished (server sent `done`) | interrupted (the stream ended without it) | failed;
 * finding → stopping → stopped.
 */
export type PopulatePhase = 'idle' | 'finding' | 'stopping' | 'finished' | 'interrupted' | 'stopped' | 'failed';

export interface PopulateState {
	phase: PopulatePhase;
	/** Finding or stopping. */
	running: boolean;
	status: string;
	added: number;
	error: string | null;
	/** Why a failed search failed, when the server says: a missing or rejected key offers its fix. */
	failure?: EnrichFailure;
	request?: PopulateRequest;
	/** Started away from its sheet (the Sheets page): the sheet's Find rows dialog reports the outcome, then acknowledges it. */
	handoff: boolean;
	/** Only presentation is delayed; every row is already committed to IndexedDB. */
	hidden: ReadonlySet<string>;
	revealAt: ReadonlyMap<string, number>;
}
const idle: PopulateState = { phase: 'idle', running: false, status: '', added: 0, error: null, handoff: false, hidden: new Set(), revealAt: new Map() };

class PopulateRunner {
	private states = new Map<string, PopulateState>();
	private runs = new Map<string, Promise<PopulateState>>();
	private controllers = new Map<string, AbortController>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private pacers = new Map<string, RowArrivalPacer>();
	private listeners = new Set<() => void>();
	constructor() {
		// Deleting a sheet (here or by a teammate) must not keep spending on its search.
		onSheetRemoved((sheetId) => this.stop(sheetId));
	}
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	getSnapshot = (sheetId: string) => this.states.get(sheetId) ?? idle;
	/** The in-flight run for a sheet, resolving to its final state. */
	settled = (sheetId: string) => this.runs.get(sheetId);
	acknowledge = (sheetId: string) => { if (this.getSnapshot(sheetId).handoff) this.patch(sheetId, { handoff: false }); };
	private patch(sheetId: string, patch: Partial<PopulateState>) {
		this.states.set(sheetId, { ...this.getSnapshot(sheetId), ...patch });
		for (const listener of this.listeners) listener();
	}
	private tick(sheetId: string) {
		clearTimeout(this.timers.get(sheetId));
		const state = this.getSnapshot(sheetId), now = Date.now();
		const hidden = new Set([...state.hidden].filter((id) => (state.revealAt.get(id) ?? 0) > now));
		const revealAt = new Map([...state.revealAt].filter(([, at]) => at + 1800 > now));
		this.patch(sheetId, { hidden, revealAt });
		if (revealAt.size) {
			const next = Math.min(...[...revealAt].map(([id, at]) => hidden.has(id) ? at : at + 1800));
			this.timers.set(sheetId, setTimeout(() => this.tick(sheetId), Math.max(16, next - now)));
		}
	}
	private queue(sheetId: string, rows: Row[]) {
		if (!rows.length) return;
		const state = this.getSnapshot(sheetId), now = Date.now();
		const pacer = this.pacers.get(sheetId);
		if (!pacer) return;
		const schedule = pacer.add(rows.map((row) => row.id), now);
		const revealAt = new Map(state.revealAt);
		for (const [id, at] of schedule) revealAt.set(id, at);
		const hidden = new Set([...schedule].filter(([, at]) => at > now).map(([id]) => id));
		this.patch(sheetId, { revealAt, hidden, added: state.added + rows.length });
		this.tick(sheetId);
	}
	private finishPresentation(sheetId: string) {
		const schedule = this.pacers.get(sheetId)?.finish(Date.now());
		if (!schedule) return;
		const revealAt = new Map(this.getSnapshot(sheetId).revealAt);
		for (const [id, at] of schedule) revealAt.set(id, at);
		this.patch(sheetId, { revealAt });
		this.tick(sheetId);
	}
	stop = (sheetId: string) => {
		const controller = this.controllers.get(sheetId);
		if (!controller || controller.signal.aborted) return;
		controller.abort();
		this.patch(sheetId, { phase: 'stopping', status: 'Stopping…', hidden: new Set(), revealAt: new Map() });
	};
	/** Starts Find rows on a sheet, or returns the run already in flight there. Resolves to the final state; never rejects. */
	start(sheet: Sheet, input: PopulateRequest, options: { handoff?: boolean } = {}): Promise<PopulateState> {
		const current = this.runs.get(sheet.id);
		if (current) return current;
		const run = this.run(sheet, input, options.handoff ?? false);
		this.runs.set(sheet.id, run);
		void run.finally(() => { if (this.runs.get(sheet.id) === run) this.runs.delete(sheet.id); });
		return run;
	}
	private async run(sheet: Sheet, input: PopulateRequest, handoff: boolean): Promise<PopulateState> {
		const controller = new AbortController();
		this.controllers.set(sheet.id, controller);
		this.pacers.set(sheet.id, new RowArrivalPacer());
		clearTimeout(this.timers.get(sheet.id));
		this.patch(sheet.id, { ...idle, failure: undefined, phase: 'finding', running: true, status: 'Finding rows…', request: input, handoff });
		let outcome: Pick<PopulateState, 'phase' | 'error' | 'failure'> = { phase: 'finished', error: null };
		try {
			const completed = await this.search(sheet, input, controller.signal);
			if (!completed && !controller.signal.aborted) {
				const added = this.getSnapshot(sheet.id).added;
				outcome = { phase: 'interrupted', error: `The connection closed before Find rows finished${added ? `, after ${added.toLocaleString()} ${added === 1 ? 'row' : 'rows'}` : ''}. Try again to continue.` };
			}
		} catch (error) {
			if (!controller.signal.aborted) outcome = { phase: 'failed', error: error instanceof Error ? error.message : 'Could not find rows', failure: (error as { failure?: EnrichFailure }).failure };
		} finally {
			const stopped = controller.signal.aborted;
			if (stopped) this.patch(sheet.id, { hidden: new Set(), revealAt: new Map() });
			else this.finishPresentation(sheet.id);
			controller.abort();
			this.pacers.delete(sheet.id);
			this.controllers.delete(sheet.id);
			const added = this.getSnapshot(sheet.id).added;
			this.patch(sheet.id, stopped
				? { phase: 'stopped', running: false, status: 'Stopped', error: null }
				: { ...outcome, running: false, status: outcome.phase === 'finished' ? `${added.toLocaleString()} rows added` : 'Could not finish finding rows' });
		}
		return this.getSnapshot(sheet.id);
	}
	/** Resolves true when the server reported `done`. */
	private async search(sheet: Sheet, input: PopulateRequest, signal: AbortSignal): Promise<boolean> {
		const fresh = (await db.sheets.get(sheet.id)) ?? sheet;
		const rows = await db.rows.where('sheetId').equals(sheet.id).toArray();
		const capacity = MAX_ROWS - rows.length;
		if (capacity <= 0) throw new Error(`This sheet already has ${MAX_ROWS.toLocaleString()} rows. Delete rows before finding more.`);
		const target = Math.min(input.target, capacity);
		const { key, missing } = foundRowColumns(input.entity, fresh.columns);
		// A sheet created for this search already has its columns and request.
		if (missing.length || JSON.stringify(fresh.populate) !== JSON.stringify(input)) await updateSheet(sheet.id, (current) => {
			const columns = foundRowColumns(input.entity, current.columns).missing.map((column) => newColumn({ name: column.name, type: 'source', width: column.width, format: column.format }));
			const combined = [...current.columns, ...columns];
			if (rows.length === 0 && current.columns.every((column) => column.type === 'source')) {
				const { rank } = foundRowColumns(input.entity, combined);
				combined.sort((a, b) => rank(a) - rank(b));
			}
			return { columns: combined, populate: input };
		}, { history: false });
		if (signal.aborted) return false;
		const request = { ...input, target, availableRows: capacity, existingKeys: key ? rows.map((row) => foundRowKey(row.cells[key.id]?.v)).filter(Boolean).slice(0, 20000) : [] };
		const { completed } = await streamPopulate(request, async (event) => {
			if (event.type === 'status') this.patch(sheet.id, { status: event.message });
			if (event.type === 'rows') {
				const remaining = Math.max(0, (input.entity === 'people' ? capacity : target) - this.getSnapshot(sheet.id).added);
				if (remaining) {
					const current = await db.sheets.get(sheet.id);
					if (!current) { this.stop(sheet.id); return; }
					const { records, cellMeta, dedupeOn } = foundRecords(input.entity, event.rows.slice(0, remaining), current.columns);
					await appendRows(sheet.id, records, { source: 'find-rows', cellMeta, createColumns: true, dedupeOn, history: false, onAdded: (added) => this.queue(sheet.id, added) });
				}
			}
		}, signal);
		return completed;
	}
}

export const populateRunner = new PopulateRunner();
