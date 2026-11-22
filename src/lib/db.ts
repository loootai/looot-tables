'use client';

import { applyHistory, makeHistoryEntry, sheetHistory, type GridSnapshot } from './sheet-history';
import { admitChange, admittedCell, fitGuessedFormat, type CellSource } from './cell-admission';
import { canonicalJson } from './cell-content';
import { inferredFormat, roleColumns } from './column-roles';
import { renameColumn, upgradeLegacyResults } from './enrichment-plan';
import { foundRowKey } from './found-rows';
import Dexie, { type EntityTable } from 'dexie';
import { nanoid } from 'nanoid';

import { accountStorageKey } from './account-storage';
import { CloudError, type SheetRemote, type SheetSnapshot } from './sheet-remote';
import { MAX_ROWS, MAX_SHEETS, SHEET_DATA_VERSION } from './workspace';
import { calculateInWorker } from './formula-worker-client';
import { upgradeGrid } from './sheet-upgrade';
import { nameTaken, shiftColumnReferences } from './references';
import { assertNoEnrichmentCycles } from './enrichment-dependencies';
import type { Cell, CellMeta, CellValue, Column, ColumnOp, ColumnFormat, PopulateRequest, Row, Sheet } from './types';
import { decodeLiveSheet, type LiveSheetEntry } from './collaboration';
import { sheetSchema, rowSchema } from './workspace';

/** Default width of a work email column: a full address fits beside its grade and the provider that answered. */
export const EMAIL_COLUMN_WIDTH = 290;

class LoootTablesDB extends Dexie {
	sheets!: EntityTable<Sheet, 'id'>;
	rows!: EntityTable<Row, 'id'>;

	constructor(name = 'looot-tables.signed-out') {
		super(name);
		this.version(1).stores({
			sheets: 'id, updatedAt',
			rows: 'id, sheetId, [sheetId+order]',
		});
	}
}

/** The IndexedDB cache of the workspace's sheets. Every change commits to the workspace (`SheetRemote`) first. */
export let db = new LoootTablesDB();
let remote: SheetRemote | undefined;
let workspacePending: Promise<unknown> = Promise.resolve();

function connected() {
	if (!remote) throw new Error('The workspace is not connected yet.');
	return remote;
}

function inWorkspaceOrder<T>(operation: () => Promise<T>): Promise<T> {
	const pending = workspacePending.catch(() => {}).then(operation);
	workspacePending = pending;
	return pending;
}

const removedListeners = new Set<(sheetId: string) => void>();
/** Lets long-running work (Find rows) stop when its sheet is deleted, here or by a teammate. */
export function onSheetRemoved(listener: (sheetId: string) => void) {
	removedListeners.add(listener);
	return () => { removedListeners.delete(listener); };
}

async function removeLocalSheets(sheetIds: string[]) {
	if (!sheetIds.length) return;
	await db.transaction('rw', db.sheets, db.rows, async () => {
		await db.rows.where('sheetId').anyOf(sheetIds).delete();
		await db.sheets.bulkDelete(sheetIds);
	});
	for (const sheetId of sheetIds) {
		sheetHistory.clear(sheetId);
		for (const listener of removedListeners) listener(sheetId);
	}
}

/** The rows `after` wrote over `before` (any difference, even key order), and the IDs it removed. */
function rowChanges(before: readonly Row[], after: readonly Row[]) {
	const previous = new Map(before.map((row) => [row.id, JSON.stringify(row)]));
	const kept = new Set(after.map((row) => row.id));
	return { changed: after.filter((row) => previous.get(row.id) !== JSON.stringify(row)), deleted: before.filter((row) => !kept.has(row.id)).map((row) => row.id) };
}

/** Replace a sheet's cached copy with the workspace's, writing only rows that differ. */
async function cacheSnapshot({ sheet, rows }: SheetSnapshot, newerOnly = false) {
	await db.transaction('rw', db.sheets, db.rows, async () => {
		if (newerOnly && ((await db.sheets.get(sheet.id))?.revision ?? 0) >= sheet.revision!) return;
		const { changed, deleted } = rowChanges(await db.rows.where('sheetId').equals(sheet.id).toArray(), rows);
		if (deleted.length) await db.rows.bulkDelete(deleted);
		if (changed.length) await db.rows.bulkPut(changed);
		await db.sheets.put(sheet);
	});
}

/** Cache the workspace's copy of a sheet. A cache miss is not proof that a sheet is gone; the workspace saying so is,
    and then the cached copy is dropped and this returns false. */
async function syncSheet(sheetId: string): Promise<boolean> {
	const snapshot = await connected().read(sheetId);
	if (snapshot) await cacheSnapshot(snapshot);
	else await removeLocalSheets([sheetId]);
	return Boolean(snapshot);
}

/** Cache the workspace's copy of a sheet that a change is about to use; a sheet deleted there fails the change. */
async function refreshSheet(sheetId: string) {
	const snapshot = await connected().read(sheetId);
	if (!snapshot) throw new CloudError('Sheet not found in this workspace.', 404);
	await cacheSnapshot(snapshot);
}

/** A list can be stale relative to a sheet created or restored in another tab: read a cached sheet it lacks, and drop it
    only if the workspace no longer has it. */
async function dropUnlisted(listed: ReadonlySet<string>, except?: string) {
	for (const sheet of await db.sheets.toArray()) if (!listed.has(sheet.id) && sheet.id !== except) await syncSheet(sheet.id);
}

/**
 * A shared sheet can be known only from the live index (no rows cached), or have a newer server revision
 * than the cached rows. Both must load before they are shown or edited.
 */
export type SheetSync = 'index-only' | 'stale' | 'synced';
export function sheetSync(sheet: Sheet): SheetSync {
	if (sheet.revision === undefined) return 'index-only';
	return (sheet.cloudSummary?.revision ?? sheet.revision) > sheet.revision ? 'stale' : 'synced';
}
const behind = (sheet: Sheet | undefined) => Boolean(sheet && sheetSync(sheet) !== 'synced');

export function openAccountDatabase() {
	const name = accountStorageKey('looot-tables.cloud');
	if (db.name === name) return;
	db.close();
	db = new LoootTablesDB(name);
}

/** Commit every change to `workspace` (`cloudSheets` in the browser) and load its sheets into the cache. */
export async function connectWorkspace(workspace: SheetRemote) {
	remote = workspace;
	await refreshWorkspace();
}

export function refreshWorkspace() { return inWorkspaceOrder(refreshWorkspaceNow); }

/** Apply a complete materialized live result, preserving newer local acknowledgments. */
export function applyLiveSheet(sheetId: string, entries: readonly LiveSheetEntry[]) {
	return inWorkspaceOrder(async () => {
		const snapshot = decodeLiveSheet(entries, sheetId);
		if (snapshot) await cacheSnapshot(snapshot, true);
		else await syncSheet(sheetId);
	});
}

/** Sidebar metadata is live; unopened sheet rows are loaded when the sheet is opened. */
export function applyLiveIndex(entries: readonly { id: string; revision: number; data: unknown; row_count: number; preview_rows: unknown[] }[], activeSheetId?: string) {
	return inWorkspaceOrder(async () => {
		const parsed = entries.map((entry) => ({ ...sheetSchema.parse(entry.data), revision: Number(entry.revision), cloudSummary: { revision: Number(entry.revision), rowCount: Number(entry.row_count), rows: entry.preview_rows.map((row) => rowSchema.parse(row)) } }));
		const cached = await db.sheets.bulkGet(parsed.map((sheet) => sheet.id));
		// Keep each cached revision with its rows: sheetSync() then reports the sheet behind until it is loaded.
		const changed = parsed.flatMap((sheet, index) => {
			const current = cached[index];
			if (sheet.id === activeSheetId) return [];
			if (!current) return [{ ...sheet, revision: undefined }];
			return (current.revision ?? 0) < sheet.revision ? [{ ...sheet, revision: current.revision }] : [];
		});
		if (changed.length) await db.sheets.bulkPut(changed);
		await dropUnlisted(new Set(parsed.map((sheet) => sheet.id)), activeSheetId);
	});
}

async function refreshWorkspaceNow() {
	const listed = await connected().list();
	const cached = await db.sheets.bulkGet(listed.map((sheet) => sheet.id));
	// One sheet at a time: each read pages through up to 1,000 rows.
	for (const [position, sheet] of listed.entries()) if (cached[position]?.revision !== sheet.revision) await refreshSheet(sheet.id);
	await dropUnlisted(new Set(listed.map((sheet) => sheet.id)));
}

export function loadSheet(sheetId: string): Promise<boolean> {
	return inWorkspaceOrder(() => syncSheet(sheetId));
}

export const id = () => nanoid(12);

export function newColumn(input: { name: string; type: Column['type']; op?: ColumnOp; width?: number; format?: ColumnFormat; categoryOptions?: string[]; categoryColors?: Record<string, string>; currency?: string; unit?: string; useGrouping?: boolean; decimalPlaces?: number; dateFormat?: Column['dateFormat'] }): Column {
	return { id: id(), name: input.name, type: input.type, op: input.op, width: input.width ?? (input.op?.kind === 'email-enrichment' ? EMAIL_COLUMN_WIDTH : input.type === 'enriched' ? 250 : 180), format: input.format ?? inferredFormat(input), categoryOptions: input.categoryOptions, categoryColors: input.categoryColors, currency: input.currency, unit: input.unit, useGrouping: input.useGrouping, decimalPlaces: input.decimalPlaces, dateFormat: input.dateFormat, createdAt: Date.now() };
}

export const SHEET_LIMIT_MESSAGE = `Your workspace can have up to ${MAX_SHEETS} sheets. Delete a sheet to create another.`;

/** Rows (with this sheet's `id`) and the populate request are created in the same request as the sheet. */
export async function createSheet(name?: string, columns: Column[] = [], initial: { id?: string; rows?: Row[]; populate?: PopulateRequest } = {}): Promise<Sheet> {
	return inWorkspaceOrder(async () => {
		if (await db.sheets.count() >= MAX_SHEETS) throw new Error(SHEET_LIMIT_MESSAGE);
		if (name === undefined) {
			const names = new Set((await db.sheets.toArray()).map((sheet) => sheet.name));
			name = 'Untitled';
			for (let suffix = 2; names.has(name); suffix++) name = `Untitled ${suffix}`;
		}
		const rows = initial.rows ?? [];
		const sheet = await connected().create({ id: initial.id ?? id(), name, columns, filters: [], sort: null, ...(initial.populate ? { populate: initial.populate } : {}), dataVersion: SHEET_DATA_VERSION, createdAt: Date.now(), updatedAt: Date.now() }, rows);
		await db.transaction('rw', db.sheets, db.rows, async () => {
			await db.sheets.add(sheet);
			if (rows.length) await db.rows.bulkAdd(rows);
		});
		return sheet;
	});
}

const recordEntry = (record: Record<string, CellValue>, name: string) => Object.entries(record).find(([key]) => key.toLowerCase() === name.toLowerCase());

/** Import as one request, so a failed import never leaves an empty sheet behind. */
export async function createSheetFromRecords(name: string, records: Record<string, CellValue>[]): Promise<Sheet> {
	if (records.length > MAX_ROWS) throw new Error(`Each sheet can have up to ${MAX_ROWS.toLocaleString()} rows.`);
	const sheetId = id();
	const columns: Column[] = [];
	const seen = new Set<string>();
	for (const record of records) for (const key of Object.keys(record)) if (!seen.has(key.toLowerCase())) {
		seen.add(key.toLowerCase());
		columns.push(newColumn({ name: key, type: 'source' }));
	}
	const valueOf = (record: Record<string, CellValue>, column: Column) => recordEntry(record, column.name)?.[1];
	// A "Domain" column with a stray "n/a" imports as plain text rather than failing the whole file.
	const fitted = columns.map((column) => fitGuessedFormat(column, records.map((record) => valueOf(record, column))));
	const rows: Row[] = records.map((record, order) => ({ id: id(), sheetId, order, createdAt: Date.now(), cells: Object.fromEntries(fitted.map((column) => {
		const value = valueOf(record, column);
		return [column.id, value === undefined ? emptyCell() : admittedCell(column, sourceCell(value), 'import')];
	})) }));
	return createSheet(name, fitted, { id: sheetId, rows });
}

export async function updateSheet(sheetId: string, patch: Partial<Sheet> | ((sheet: Sheet) => Partial<Sheet>), options: { history?: boolean } = {}) {
	// The Sheets list can rename a sheet it knows only from the live index; edit its current revision.
	await inWorkspaceOrder(async () => { if (behind(await db.sheets.get(sheetId))) await refreshSheet(sheetId); });
	await changeGrid(sheetId, (sheet, rows) => ({ sheet: { ...sheet, ...(typeof patch === 'function' ? patch(sheet) : patch), updatedAt: Date.now() }, rows }), options);
}

export async function deleteSheet(sheetId: string) {
	return inWorkspaceOrder(async () => {
		const sheet = await db.sheets.get(sheetId);
		if (sheet) {
			// The list shows the live index, so its revision is the one the user confirmed. A newer edit gets one fresh retry.
			const newer = await connected().remove(sheet.id, Math.max(sheet.revision ?? 0, sheet.cloudSummary?.revision ?? 0));
			if (newer !== null && await connected().remove(sheet.id, newer) !== null) throw new Error(`“${sheet.name}” is being edited right now. Try deleting it again in a moment.`);
		}
		await removeLocalSheets([sheetId]);
	});
}

export async function duplicateSheet(sheetId: string): Promise<Sheet | null> {
	return inWorkspaceOrder(async () => {
		if (await db.sheets.count() >= MAX_SHEETS) throw new Error(SHEET_LIMIT_MESSAGE);
		await refreshSheet(sheetId);
		const sheet = await db.sheets.get(sheetId);
		if (!sheet) return null;
		const rows = await db.rows.where('sheetId').equals(sheetId).toArray();
		const draft: Sheet = { ...sheet, revision: undefined, id: id(), name: `${sheet.name} copy`, createdAt: Date.now(), updatedAt: Date.now() };
		delete draft.cloudSummary;
		const copiedRows = rows.map((row) => ({ ...row, id: id(), sheetId: draft.id }));
		const copy = await connected().create(draft, copiedRows);
		await db.transaction('rw', db.sheets, db.rows, async () => {
			await db.sheets.add(copy);
			await db.rows.bulkAdd(copiedRows);
		});
		return copy;
	});
}

export async function importMyLocalSheets(): Promise<number> {
	const name = accountStorageKey('looot-tables');
	if (!await Dexie.exists(name)) return 0;
	const legacy = new LoootTablesDB(name);
	try {
		const sheets = await legacy.sheets.toArray();
		const snapshots = await Promise.all(sheets.map(async (sheet) => ({ sheet, rows: await legacy.rows.where('sheetId').equals(sheet.id).toArray() })));
		if (snapshots.some((entry) => entry.rows.length > MAX_ROWS)) throw new Error('One of your local sheets has over 1,000 rows. Export and split it before importing.');
		return await inWorkspaceOrder(async () => {
			await refreshWorkspaceNow();
			const existing = new Set(await db.sheets.toCollection().primaryKeys());
			const pending = snapshots.filter((entry) => !existing.has(entry.sheet.id));
			if (existing.size + pending.length > MAX_SHEETS) throw new Error(`Importing these sheets would exceed this workspace’s ${MAX_SHEETS}-sheet limit.`);
			let imported = 0;
			for (const snapshot of pending) {
				if (snapshot.sheet.populate) snapshot.sheet.populate.target = Math.min(MAX_ROWS, snapshot.sheet.populate.target);
				const sheet = await connected().create(snapshot.sheet, snapshot.rows);
				await db.transaction('rw', db.sheets, db.rows, async () => { await db.sheets.put(sheet); await db.rows.bulkPut(snapshot.rows); });
				imported++;
			}
			return imported;
		});
	} finally { legacy.close(); }
}

export const emptyCell = (): Cell => ({ v: null, s: 'idle', t: Date.now() });
export const sourceCell = (value: CellValue): Cell => ({ v: value, s: 'done', t: Date.now() });

/** The existing column each imported header fills: the one it names, or for a header naming a web role ("Website",
    "Domain", "URL"), the sheet's only source column playing that role, unless another header names that column. */
export function importTargets(columns: readonly Column[], headers: readonly string[]): Map<string, string> {
	const byName = new Map(columns.map((column) => [column.name.toLowerCase(), column.name]));
	const named = new Set(headers.map((header) => header.toLowerCase()));
	const targets = new Map<string, string>();
	for (const header of headers) {
		const existing = byName.get(header.toLowerCase());
		const role = existing ? undefined : inferredFormat({ name: header, type: 'source' });
		const [column, other] = role ? roleColumns(columns.filter((entry) => entry.type === 'source'), role) : [];
		if (existing) targets.set(header, existing);
		else if (column && !other && !named.has(column.name.toLowerCase())) { targets.set(header, column.name); named.add(column.name.toLowerCase()); }
	}
	return targets;
}

/** Append rows given as column-name → value maps. Creates missing source columns. Returns the number added.
    A value its column cannot hold never fails the append; `source` decides what is kept (see cell-admission). */
export async function appendRows(sheetId: string, input: Record<string, CellValue>[], options: { source?: Extract<CellSource, 'import' | 'find-rows'>; cellMeta?: Record<string, CellMeta>[]; createColumns?: boolean; dedupeOn?: string; history?: boolean; afterRowId?: string; onAdded?: (rows: Row[]) => void } = {}): Promise<number> {
	if (input.length === 0) return 0;
	const source = options.source ?? 'import';
	let added = 0;
	let addedRows: Row[] = [];
	await changeGrid(sheetId, (sheet, existingRows) => {
		// Find rows already places its fields (found-rows.ts); imported headers are matched here.
		const targets = source === 'import' ? importTargets(sheet.columns, [...new Set(input.flatMap(Object.keys))]) : new Map<string, string>();
		const records = targets.size ? input.map((record) => Object.fromEntries(Object.entries(record).map(([header, value]) => [targets.get(header) ?? header, value]))) : input;
		const columns = [...sheet.columns];
		const created = new Map<string, Column>();
		if (options.createColumns !== false) {
			const known = new Set(columns.map((c) => c.name.toLowerCase()));
			for (const record of records) for (const name of Object.keys(record)) if (!known.has(name.toLowerCase()) && !created.has(name.toLowerCase())) created.set(name.toLowerCase(), newColumn({ name, type: 'source' }));
		}
		// A created column's format was only guessed from its header, so it gives way to the values.
		columns.push(...[...created.values()].map((column) => fitGuessedFormat(column, records.map((record) => recordEntry(record, column.name)?.[1]))));
		const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
		const columnsChanged = created.size > 0;
		let existingKeys = new Set<string>();
		const dedupeColumn = options.dedupeOn ? byName.get(options.dedupeOn.toLowerCase()) : undefined;
		if (dedupeColumn) {
			const existing = existingRows;
			existingKeys = new Set(existing.map((row) => foundRowKey(row.cells[dedupeColumn.id]?.v)).filter(Boolean));
		}
		let order = existingRows.reduce((max, row) => Math.max(max, row.order), -1) + 1;
		const rows: Row[] = [];
		for (const [recordIndex, record] of records.entries()) {
			if (dedupeColumn) {
				const key = foundRowKey(record[dedupeColumn.name]);
				if (key && existingKeys.has(key)) continue;
				if (key) existingKeys.add(key);
			}
			const cells: Record<string, Cell> = {};
			for (const column of columns) {
				const entry = recordEntry(record, column.name);
				cells[column.id] = admittedCell(column, column.type === 'source' && entry ? { ...sourceCell(entry[1]), ...(options.cellMeta?.[recordIndex]?.[entry[0]] ? { m: options.cellMeta[recordIndex][entry[0]] } : {}) } : emptyCell(), source);
			}
			rows.push({ id: id(), sheetId, order: order++, cells, createdAt: Date.now() });
		}
		added = rows.length;
		addedRows = rows;
		return { sheet: { ...sheet, ...(columnsChanged ? { columns } : {}), updatedAt: Date.now() }, rows: placeRows(existingRows, rows, options.afterRowId) };
	}, { ...options, source });
	options.onAdded?.(addedRows);
	return added;
}

/** Insert against a stable row ID so queued mutations and conflict retries keep the intended anchor. */
function placeRows(existing: Row[], added: Row[], afterRowId?: string): Row[] {
	const index = afterRowId ? existing.findIndex((row) => row.id === afterRowId) : -1;
	if (index < 0 || !added.length) return [...existing, ...added];
	const rows = [...existing];
	rows.splice(index + 1, 0, ...added);
	for (let i = 0; i < rows.length; i++) rows[i].order = i;
	return rows;
}

export async function addEmptyRow(sheetId: string, afterRowId?: string): Promise<Row> {
	let added: Row | undefined;
	await changeGrid(sheetId, (sheet, rows) => {
		const cells = Object.fromEntries(sheet.columns.map((column) => [column.id, emptyCell()]));
		added = { id: id(), sheetId, order: rows.reduce((max, row) => Math.max(max, row.order), -1) + 1, cells, createdAt: Date.now() };
		return { sheet: { ...sheet, updatedAt: Date.now() }, rows: placeRows(rows, [added], afterRowId) };
	});
	if (!added) throw new Error('Sheet not found');
	return added;
}

export async function setCell(rowId: string, columnId: string, cell: Cell, options: { history?: boolean } = {}) {
	await setCells([{ rowId, columnId, cell }], options);
}

/** A compare-and-set cell write. `update` sees the fresh grid and may return undefined to leave the cell unchanged. */
export interface CellChange { rowId: string; columnId: string; expected: Cell | undefined; update: (sheet: Sheet, rows: Row[]) => Cell | undefined }

/** Apply several compare-and-set writes to one sheet in a single commit, checked and written against the same snapshot
    (also when a cloud conflict is replayed). Returns which ones were written. */
export function updateCellsIf(sheetId: string, changes: CellChange[]) {
	return inSheetOrder(sheetId, () => inWorkspaceOrder(() => commitCellsIf(sheetId, changes)));
}

async function commitCellsIf(sheetId: string, changes: CellChange[]): Promise<boolean[]> {
	let applied = changes.map(() => false);
	if (!changes.length) return applied;
	await commitGrid(sheetId, (sheet, rows) => {
		const byId = new Map(rows.map((row) => [row.id, row]));
		const columns = new Set(sheet.columns.map((column) => column.id));
		applied = changes.map(({ rowId, columnId, expected, update }) => {
			const row = byId.get(rowId);
			if (!row || !columns.has(columnId) || canonicalJson(row.cells[columnId]) !== canonicalJson(expected)) return false;
			const next = update(sheet, rows);
			if (next) row.cells[columnId] = next;
			return Boolean(next);
		});
		return { sheet, rows };
	}, { history: false, source: 'enrichment' });
	return applied;
}

/** Write cells as a person's edit: when a teammate changed one of them while the edit was saving, the edit is refused
    and their change kept. */
export async function setCells(updates: Array<{ rowId: string; columnId: string; cell: Cell }>, options: { history?: boolean } = {}) {
	if (!updates.length) return;
	const existing = await db.rows.bulkGet([...new Set(updates.map((update) => update.rowId))]);
	const sheetIds = new Set(existing.flatMap((row) => row ? [row.sheetId] : []));
	await Promise.all([...sheetIds].map((sheetId) => {
		let expected: Map<string, string | undefined> | undefined;
		return changeGrid(sheetId, (sheet, rows) => {
		const byId = new Map(rows.map((row) => [row.id, row]));
		if (!expected) expected = new Map(updates.map((edit) => [`${edit.rowId}:${edit.columnId}`, canonicalJson(byId.get(edit.rowId)?.cells[edit.columnId])]));
		for (const { rowId, columnId, cell } of updates) {
			const row = byId.get(rowId);
			if (row?.sheetId === sheetId && canonicalJson(row.cells[columnId]) !== expected.get(`${rowId}:${columnId}`)) throw new Error('Someone changed this cell while your edit was saving. Their change was kept. Review the current value before trying again.');
			if (row && sheet.columns.some((column) => column.id === columnId)) row.cells[columnId] = cell;
		}
		return { sheet, rows };
	}, options);
	}));
}

const containsFormulas = (rows: Row[]) => rows.some((row) => Object.values(row.cells).some((cell) => Boolean(cell.f)));

async function gridSnapshot(sheetId: string) {
	return db.transaction('r', db.sheets, db.rows, async () => {
		const [sheet, rows] = await Promise.all([db.sheets.get(sheetId), db.rows.where('[sheetId+order]').between([sheetId, Dexie.minKey], [sheetId, Dexie.maxKey]).toArray()]);
		return sheet ? { sheet, rows } : undefined;
	});
}

/** Commit only against the snapshot we calculated, so edits/enrichments in flight cannot be overwritten. */
// Serialize mutations and history navigation within each sheet, including worker calculations.
const pendingChanges = new Map<string, Promise<unknown>>();
function inSheetOrder<T>(sheetId: string, operation: () => Promise<T>): Promise<T> {
	const result = (pendingChanges.get(sheetId) ?? Promise.resolve()).catch(() => {}).then(operation);
	pendingChanges.set(sheetId, result);
	void result.finally(() => { if (pendingChanges.get(sheetId) === result) pendingChanges.delete(sheetId); }).catch(() => {});
	return result;
}

type CommitOptions = { history?: boolean; replay?: boolean; source?: CellSource };

function changeGrid(sheetId: string, change?: (sheet: Sheet, rows: Row[]) => GridSnapshot | Promise<GridSnapshot>, options: CommitOptions = {}) {
	return inSheetOrder(sheetId, () => inWorkspaceOrder(() => commitGrid(sheetId, change, options)));
}

/** Writers declare their `source` (default: a user edit). Only the cells a change wrote are admitted, so a value stored
    long ago never blocks an unrelated edit; a column whose format changed has every cell checked. */
async function commitGrid(sheetId: string, change?: (sheet: Sheet, rows: Row[]) => GridSnapshot | Promise<GridSnapshot>, options: CommitOptions = {}) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const before = await gridSnapshot(sheetId);
		if (!before) return;
		if (!change && !containsFormulas(before.rows)) return;
		const after = change ? await change(structuredClone(before.sheet), structuredClone(before.rows)) : structuredClone(before);
		admitChange({ columns: before.sheet.columns, rows: before.rows }, { columns: after.sheet.columns, rows: after.rows }, options.source ?? 'edit');
		if (after.rows.length > MAX_ROWS) throw new Error(`Each sheet can have up to ${MAX_ROWS.toLocaleString()} rows.`);
		const results = containsFormulas(after.rows) ? await calculateInWorker({
			grid: options.replay ? { columns: after.sheet.columns, rows: after.rows } : { columns: before.sheet.columns, rows: before.rows },
			...(change && !options.replay ? { next: { columns: after.sheet.columns, rows: after.rows } } : {}),
		}) : [];
		const byId = new Map(after.rows.map((row) => [row.id, row]));
		const columnsById = new Map(after.sheet.columns.map((column) => [column.id, column]));
		for (const { rowId, columnId, cell } of results) {
			const column = columnsById.get(columnId);
			byId.get(rowId)!.cells[columnId] = column ? admittedCell(column, cell, 'formula') : cell;
		}
		if (canonicalJson(before) === canonicalJson(after)) return;
		const { changed, deleted } = rowChanges(before.rows, after.rows);
		// Callers load a sheet known only from the live index before changing it (updateSheet, the sheet page's load gate).
		const saved = await connected().patch({ revision: before.sheet.revision!, sheet: after.sheet, rows: changed, deleted });
		// Someone else changed the sheet first: redo this change on their version.
		if (!saved) { await refreshSheet(sheetId); continue; }
		await db.transaction('rw', db.sheets, db.rows, async () => {
			if (((await db.sheets.get(sheetId))?.revision ?? 0) > saved.revision) return;
			if (deleted.length) await db.rows.bulkDelete(deleted);
			if (changed.length) await db.rows.bulkPut(changed);
			// Stamp a copy: the revision is server bookkeeping, which the undo history must not record.
			await db.sheets.put({ ...after.sheet, revision: saved.revision, updatedAt: saved.updatedAt });
		});
		if (change && options.history !== false) sheetHistory.record(sheetId, makeHistoryEntry(before, after));
		return;
	}
	throw new Error('The sheet is changing too quickly to calculate. Try again when enrichment settles.');
}

export async function recalculateSheet(sheetId: string) {
	await changeGrid(sheetId);
}

export async function deleteRows(sheetId: string, rowIds: string[]) {
	const removed = new Set(rowIds);
	await changeGrid(sheetId, (sheet, rows) => ({ sheet: { ...sheet, updatedAt: Date.now() }, rows: rows.filter((row) => !removed.has(row.id)) }));
}

/* Results fingerprinted by column name (`v1:`) cannot follow a column added, moved, redefined or deleted: each change
   below restamps the ones still current first (see `upgradeLegacyResults`), so it outdates only what it changes. */

export async function addColumns(sheetId: string, added: Column[], position?: number, initialCell?: { rowId: string; columnId: string; cell: Cell }) {
	await changeGrid(sheetId, (sheet, before) => {
		const rows = upgradeLegacyResults({ sheet, rows: before });
		if (initialCell && (!rows.some((row) => row.id === initialCell.rowId) || !added.some((column) => column.id === initialCell.columnId))) throw new Error('The row is no longer available.');
		const inserted = [...sheet.columns];
		inserted.splice(position ?? inserted.length, 0, ...added);
		const columns = shiftColumnReferences(sheet.columns, inserted);
		if (added.some((column) => column.type === 'enriched')) assertNoEnrichmentCycles(columns, rows);
		for (const row of rows) for (const column of added) row.cells[column.id] = initialCell?.rowId === row.id && initialCell.columnId === column.id ? initialCell.cell : emptyCell();
		return { sheet: { ...sheet, columns, updatedAt: Date.now() }, rows };
	});
}

/** Add and fill in one mutation, so failed calculation leaves no column and undo removes it in one step. */
export async function addFormulaColumn(sheetId: string, column: Column, formula: string, position?: number) {
	await changeGrid(sheetId, async (sheet, before) => {
		const rows = upgradeLegacyResults({ sheet, rows: before });
		const inserted = [...sheet.columns];
		inserted.splice(position ?? inserted.length, 0, column);
		const columns = shiftColumnReferences(sheet.columns, inserted);
		if (rows.length) {
			const first = rows[0];
			first.cells[column.id] = { f: formula, v: null, s: 'done', t: Date.now() };
			const results = await calculateInWorker({ grid: { columns, rows }, copies: rows.slice(1).map((row) => ({ source: { rowId: first.id, columnId: column.id }, target: { rowId: row.id, columnId: column.id } })) });
			const byId = new Map(rows.map((row) => [row.id, row]));
			for (const result of results) if (result.columnId === column.id) byId.get(result.rowId)!.cells[column.id] = result.cell;
		}
		return { sheet: { ...sheet, columns, updatedAt: Date.now() }, rows };
	});
}

/** Saved values stay when the operation changes: they become outdated, keeping their values until they are explicitly
    re-run. A rename keeps them current (see `renameColumn`). */
export async function updateColumn(sheetId: string, columnId: string, patch: Partial<Column>) {
	await changeGrid(sheetId, (sheet, before) => {
		if (patch.name !== undefined && nameTaken(patch.name, sheet.columns, columnId)) throw new Error('A column with this name already exists.');
		const rows = upgradeLegacyResults({ sheet, rows: before });
		const grid = patch.name === undefined ? { sheet, rows } : renameColumn({ sheet, rows }, columnId, patch.name);
		const columns = grid.sheet.columns.map((column) => column.id === columnId ? { ...column, ...patch } : column);
		if (patch.op !== undefined || patch.name !== undefined || patch.type !== undefined) assertNoEnrichmentCycles(columns, grid.rows);
		return { sheet: { ...grid.sheet, columns, updatedAt: Date.now() }, rows: grid.rows };
	});
}

/** A sheet saved before `SHEET_DATA_VERSION` is upgraded when it loads (see `upgradeGrid`), and stamped even when
    nothing else changes. Not an undo step. */
export async function upgradeSheet(sheetId: string) {
	const cached = await db.sheets.get(sheetId);
	if (!cached || (cached.dataVersion ?? 0) >= SHEET_DATA_VERSION) return;
	await changeGrid(sheetId, (sheet, rows) => upgradeGrid({ sheet, rows }) ?? { sheet, rows }, { history: false });
}

export async function deleteColumn(sheetId: string, columnId: string) {
	await changeGrid(sheetId, (sheet, before) => {
		const rows = upgradeLegacyResults({ sheet, rows: before });
		for (const row of rows) delete row.cells[columnId];
		// Cell references shift or become {{#REF!}}; named references to it are left dangling for their columns to report.
		return { rows, sheet: { ...sheet,
			columns: shiftColumnReferences(sheet.columns, sheet.columns.filter((column) => column.id !== columnId)),
			filters: sheet.filters.filter((filter) => filter.columnId !== columnId),
			sort: sheet.sort?.columnId === columnId ? null : sheet.sort,
			updatedAt: Date.now(),
		} };
	});
}

export async function moveColumn(sheetId: string, columnId: string, toIndex: number) {
	await changeGrid(sheetId, (sheet, before) => {
		const rows = upgradeLegacyResults({ sheet, rows: before });
		const moved = [...sheet.columns];
		const from = moved.findIndex((column) => column.id === columnId);
		if (from === -1) return { sheet, rows };
		const [column] = moved.splice(from, 1);
		moved.splice(Math.max(0, Math.min(toIndex, moved.length)), 0, column);
		// References follow their columns, but a range can now span a column that reads it.
		const columns = shiftColumnReferences(sheet.columns, moved);
		assertNoEnrichmentCycles(columns, rows);
		return { sheet: { ...sheet, columns, updatedAt: Date.now() }, rows };
	});
}

export async function clearColumnCells(sheetId: string, columnId: string, rowIds?: string[]) {
	await changeGrid(sheetId, (sheet, rows) => {
		const targets = rowIds ? new Set(rowIds) : undefined;
		for (const row of rows) if (!targets || targets.has(row.id)) row.cells[columnId] = emptyCell();
		return { sheet, rows };
	});
}

export function undoSheet(sheetId: string) { return travelHistory(sheetId, 'undo'); }
export function redoSheet(sheetId: string) { return travelHistory(sheetId, 'redo'); }

function travelHistory(sheetId: string, direction: 'undo' | 'redo') {
	return inSheetOrder(sheetId, () => inWorkspaceOrder(async () => {
		const entry = sheetHistory.peek(sheetId, direction);
		if (!entry) return;
		// Stop work that could overwrite restored cells or target removed rows/columns.
		const { runner } = await import('./runner');
		const stops: Array<{ sheetId: string; rowIds?: string[]; columnId?: string }> = [];
		if (entry.rows.length) stops.push({ sheetId, rowIds: entry.rows.map((row) => row.id) });
		const cellsByColumn = new Map<string, string[]>();
		for (const cell of entry.cells) {
			const rowIds = cellsByColumn.get(cell.columnId) ?? [];
			rowIds.push(cell.rowId);
			cellsByColumn.set(cell.columnId, rowIds);
		}
		for (const [columnId, rowIds] of cellsByColumn) stops.push({ sheetId, rowIds, columnId });
		const columns = entry.sheet.find((field) => field.key === 'columns');
		if (columns) {
			const source = columns[direction === 'undo' ? 'after' : 'before'] as Column[];
			const target = new Map((columns[direction === 'undo' ? 'before' : 'after'] as Column[]).map((column) => [column.id, column]));
			for (const column of source) {
				const next = target.get(column.id);
				if (!next || JSON.stringify(next.op) !== JSON.stringify(column.op)) stops.push({ sheetId, columnId: column.id });
			}
		}
		// Already inside this sheet's lock, so settle stopped cells without queueing behind it.
		if (stops.length) await runner.cancel(stops, commitCellsIf);
		await commitGrid(sheetId, (sheet, rows) => applyHistory({ sheet, rows }, entry, direction), { history: false, replay: true });
		sheetHistory.finish(sheetId, direction);
	}));
}
