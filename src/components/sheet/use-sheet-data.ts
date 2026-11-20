'use client';

import { useToast } from '@/components/ui/toast';
import { db, loadSheet, recalculateSheet, sheetSync, upgradeSheet } from '@/lib/db';
import { recoverStalledEnrichments } from '@/lib/enrichment-recovery';
import { applyFilters, applySort } from '@/lib/filters';
import { populateRunner } from '@/lib/populate-runner';
import { watchRealtimeSheet } from '@/lib/realtime-client';
import { failedCells, withProgress, type RunMode, type SheetCommands } from '@/lib/sheet-commands';
import type { SheetView } from '@/lib/sheet-view';
import type { Row, Sheet } from '@/lib/types';
import { SHEET_DATA_VERSION } from '@/lib/workspace';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { messageOf } from './sheet-page-utils';
import { useCellEdits } from './use-cell-edits';

type SheetLoad = { id: string; status: 'loading' | 'missing' | 'error'; message?: string };

/** The sheet and its rows from the local database: fetches a sheet that isn't cached, upgrades one saved by an older version, follows realtime changes, recovers stalled cells and recalculates formulas. */
export function useSheetData(sheetId: string, commands: SheetCommands) {
	const { toast } = useToast();
	const database = db;
	const sheet = useLiveQuery(async () => (await database.sheets.get(sheetId)) ?? null, [sheetId, database]);
	const allRows = useLiveQuery(() => database.rows.where('[sheetId+order]').between([sheetId, -Infinity], [sheetId, Infinity]).toArray(), [sheetId, database]);
	const [sheetLoad, setSheetLoad] = useState<SheetLoad | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);
	if (sheet && sheetLoad !== null) setSheetLoad(null);
	useEffect(() => {
		if (sheet !== null) return;
		let disposed = false;
		void loadSheet(sheetId).then((found) => {
			if (!disposed) setSheetLoad(found ? null : { id: sheetId, status: 'missing' });
		}).catch((error) => {
			if (!disposed) setSheetLoad({ id: sheetId, status: 'error', message: messageOf(error, 'Could not load this sheet.') });
		});
		return () => { disposed = true; };
	}, [sheet, sheetId, database, loadAttempt]);
	useEffect(() => {
		if (!allRows) return;
		let checking = false;
		const recover = async () => {
			if (checking) return;
			checking = true;
			try { await recoverStalledEnrichments(sheetId, allRows, commands.isPending); }
			catch { /* Keep the saved state on network failure; retry on the next check. */ }
			finally { checking = false; }
		};
		void recover();
		const timer = setInterval(() => { void recover(); }, 30_000);
		return () => clearInterval(timer);
	}, [sheetId, allRows, commands]);
	// A sheet saved by an older version is upgraded once its rows are loaded (see `upgradeGrid`).
	const upgradable = Boolean(sheet && sheetSync(sheet) === 'synced' && (sheet.dataVersion ?? 0) < SHEET_DATA_VERSION);
	useEffect(() => {
		if (upgradable) void upgradeSheet(sheetId).catch(() => {});
	}, [upgradable, sheetId]);
	useEffect(() => watchRealtimeSheet(sheetId), [sheetId]);
	useEffect(() => {
		if (allRows?.some((row) => Object.values(row.cells).some((cell) => cell.f))) {
			void recalculateSheet(sheetId).catch((error) => toast(messageOf(error, 'Formula calculation failed'), 'error'));
		}
	}, [allRows, sheet?.columns, sheetId, toast]);
	const failure = sheet === null && sheetLoad?.id === sheetId && sheetLoad.status !== 'loading' ? sheetLoad : null;
	const retry = () => { setSheetLoad({ id: sheetId, status: 'loading' }); setLoadAttempt((attempt) => attempt + 1); };
	return { sheet, allRows, failure, retry };
}

/** The rows the sheet shows: unsaved edits and run progress applied, rows Find rows hasn't revealed yet held back, then search and this viewer's filters and sort. */
export function useSheetRows({ sheetId, sheet, allRows, commands, search, view }: { sheetId: string; sheet: Sheet; allRows: Row[]; commands: SheetCommands; search: string; view: SheetView }) {
	const { rows: displayRows, saveCell } = useCellEdits(allRows);
	const runStatus = useSyncExternalStore(commands.subscribe, commands.status, commands.status);
	const progressRows = useMemo(() => withProgress(displayRows, runStatus.cells), [displayRows, runStatus.cells]);
	const populate = useSyncExternalStore(populateRunner.subscribe, () => populateRunner.getSnapshot(sheetId), () => populateRunner.getSnapshot(sheetId));
	const { filters, sort } = view;
	const rows = useMemo(() => (progressRows ? applySort(applyFilters(progressRows.filter((row) => !populate.hidden.has(row.id)), filters, search, sheet.columns), sort) : []), [sheet.columns, filters, sort, progressRows, search, populate.hidden]);
	const enrichedColumns = useMemo(() => sheet.columns.filter((column) => column.type === 'enriched' && column.op), [sheet.columns]);
	// The saved grid in sheet order: it decides which cells are unfinished and which finished ones are outdated.
	const grid = useMemo(() => ({ sheet, rows: displayRows ?? allRows }), [sheet, displayRows, allRows]);
	const { unfinished, outdated } = useMemo(() => {
		const count = (mode: RunMode) => {
			const plan = commands.plan(rows, enrichedColumns, mode, { ready: () => true, grid });
			return plan.kind === 'run' ? plan.estimate.cells : 0;
		};
		return { unfinished: count('unfinished'), outdated: count('outdated') };
	}, [commands, rows, enrichedColumns, grid]);
	const failed = useMemo(() => failedCells(progressRows ?? [], enrichedColumns).reduce((sum, group) => sum + group.rows.length, 0), [progressRows, enrichedColumns]);
	const rowNumbers = useMemo(() => new Map(allRows.map((row, index) => [row.id, index + 1])), [allRows]);
	const rowById = useMemo(() => new Map((displayRows ?? []).map((row) => [row.id, row])), [displayRows]);
	return { displayRows, saveCell, runStatus, progressRows, populate, findingRows: populate.running || populate.hidden.size > 0, rows, grid, enrichedColumns, unfinished, outdated, failed, rowNumbers, rowById };
}

export type SheetRows = ReturnType<typeof useSheetRows>;
