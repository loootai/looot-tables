import { cellTransition, isPendingCell } from './cell-lifecycle';
import { cellContent } from './cell-content';
import type { Cell, Column, Row, Sheet } from './types';

export interface GridSnapshot { sheet: Sheet; rows: Row[] }
type Change<T> = { before: T | undefined; after: T | undefined };
export interface HistoryEntry {
	sheet: Array<{ key: keyof Sheet } & Change<Sheet[keyof Sheet]>>;
	rows: Array<{ id: string } & Change<Row>>;
	rowOrder?: { before: string[]; after: string[] };
	cells: Array<{ rowId: string; columnId: string } & Change<Cell>>;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keep only the edited data, never unrelated rows or derived formula results. */
export function makeHistoryEntry(before: GridSnapshot, after: GridSnapshot): HistoryEntry {
	const entry: HistoryEntry = { sheet: [], rows: [], cells: [] };
	const beforeOrder = before.rows.map((row) => row.id), afterOrder = after.rows.map((row) => row.id);
	if (!equal(beforeOrder, afterOrder)) entry.rowOrder = { before: beforeOrder, after: afterOrder };
	for (const key of new Set([...Object.keys(before.sheet), ...Object.keys(after.sheet)]) as Set<keyof Sheet>) {
		if (key !== 'updatedAt' && !equal(before.sheet[key], after.sheet[key])) entry.sheet.push({ key, before: before.sheet[key], after: after.sheet[key] });
	}
	const oldRows = new Map(before.rows.map((row) => [row.id, row]));
	const newRows = new Map(after.rows.map((row) => [row.id, row]));
	for (const id of new Set([...oldRows.keys(), ...newRows.keys()])) {
		const previous = oldRows.get(id), next = newRows.get(id);
		if (!previous || !next) { entry.rows.push({ id, before: previous, after: next }); continue; }
		for (const columnId of new Set([...Object.keys(previous.cells), ...Object.keys(next.cells)])) {
			if (!equal(cellContent(previous.cells[columnId]), cellContent(next.cells[columnId]))) entry.cells.push({ rowId: id, columnId, before: previous.cells[columnId], after: next.cells[columnId] });
		}
	}
	return structuredClone(entry);
}

// Background population may have appended columns since the action was recorded.
function restoreColumns(current: Column[], source: Column[], target: Column[]): Column[] {
	const columns = new Map(current.map((column) => [column.id, structuredClone(column)]));
	const from = new Map(source.map((column) => [column.id, column]));
	const to = new Map(target.map((column) => [column.id, column]));
	for (const column of source) if (!to.has(column.id)) columns.delete(column.id);
	for (const column of target) {
		const previous = from.get(column.id), existing = columns.get(column.id);
		if (!previous || !existing) { columns.set(column.id, structuredClone(column)); continue; }
		for (const key of new Set([...Object.keys(previous), ...Object.keys(column)])) {
			const field = key as keyof Column;
			if (!equal(previous[field], column[field])) {
				if (column[field] === undefined) delete (existing as unknown as Record<string, unknown>)[field];
				else (existing as unknown as Record<string, unknown>)[field] = structuredClone(column[field]);
			}
		}
	}
	const orderChanged = !equal(source.map((column) => column.id), target.map((column) => column.id));
	const order = orderChanged ? [...target.map((column) => column.id), ...current.filter((column) => !to.has(column.id)).map((column) => column.id)] : current.map((column) => column.id);
	return order.flatMap((id) => columns.has(id) ? [columns.get(id)!] : []);
}

/** A pending cell is restored as settled: its run belongs to this tab's runner, which undo stops. */
function restoredCell(cell: Cell): Cell {
	return isPendingCell(cell) ? cellTransition(structuredClone(cell), { type: 'cancel' }) : { ...structuredClone(cell), t: Date.now() };
}

export function applyHistory(snapshot: GridSnapshot, entry: HistoryEntry, direction: 'undo' | 'redo'): GridSnapshot {
	const target = direction === 'undo' ? 'before' : 'after';
	const sheet = structuredClone(snapshot.sheet);
	for (const field of entry.sheet) {
		if (field.key === 'columns') {
			sheet.columns = restoreColumns(sheet.columns, field[direction === 'undo' ? 'after' : 'before'] as Column[], field[target] as Column[]);
			continue;
		}
		if (field[target] === undefined) delete (sheet as unknown as Record<string, unknown>)[field.key];
		else (sheet as unknown as Record<string, unknown>)[field.key] = structuredClone(field[target]);
	}
	sheet.updatedAt = Date.now();
	const rows = new Map(snapshot.rows.map((row) => [row.id, structuredClone(row)]));
	for (const change of entry.rows) {
		const row = change[target];
		if (!row) rows.delete(change.id);
		else rows.set(row.id, { ...structuredClone(row), cells: Object.fromEntries(Object.entries(row.cells).map(([id, cell]) => [id, restoredCell(cell)])) });
	}
	if (entry.rowOrder) {
		const targetIds = entry.rowOrder[target].filter((id) => rows.has(id));
		const known = new Set(targetIds);
		const following = new Map<string | null, string[]>();
		let anchor: string | null = null;
		for (const row of snapshot.rows) {
			if (!rows.has(row.id)) continue;
			if (known.has(row.id)) anchor = row.id;
			else {
				const siblings = following.get(anchor) ?? [];
				siblings.push(row.id);
				following.set(anchor, siblings);
			}
		}
		const order = [...(following.get(null) ?? []), ...targetIds.flatMap((id) => [id, ...(following.get(id) ?? [])])];
		order.forEach((id, index) => { rows.get(id)!.order = index; });
	}
	for (const change of entry.cells) {
		const row = rows.get(change.rowId);
		if (!row) continue;
		const cell = change[target];
		if (cell) row.cells[change.columnId] = restoredCell(cell);
		else delete row.cells[change.columnId];
	}
	return { sheet, rows: [...rows.values()].sort((a, b) => a.order - b.order) };
}

const EMPTY: Readonly<{ undo: number; redo: number }> = Object.freeze({ undo: 0, redo: 0 });
class SheetHistory {
	private sheets = new Map<string, { undo: HistoryEntry[]; redo: HistoryEntry[]; snapshot: typeof EMPTY }>();
	private listeners = new Set<() => void>();
	subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
	getSnapshot = (sheetId: string) => this.sheets.get(sheetId)?.snapshot ?? EMPTY;
	private publish(sheetId: string) {
		const state = this.sheets.get(sheetId)!;
		state.snapshot = { undo: state.undo.length, redo: state.redo.length };
		for (const listener of this.listeners) listener();
	}
	record(sheetId: string, entry: HistoryEntry) {
		if (!entry.sheet.length && !entry.rows.length && !entry.rowOrder && !entry.cells.length) return;
		let state = this.sheets.get(sheetId);
		if (!state) { state = { undo: [], redo: [], snapshot: EMPTY }; this.sheets.set(sheetId, state); }
		state.undo.push(entry);
		if (state.undo.length > 50) state.undo.shift();
		state.redo = [];
		this.publish(sheetId);
	}
	peek(sheetId: string, direction: 'undo' | 'redo') { return this.sheets.get(sheetId)?.[direction].at(-1); }
	finish(sheetId: string, direction: 'undo' | 'redo') {
		const state = this.sheets.get(sheetId);
		const entry = state?.[direction].pop();
		if (!state || !entry) return;
		state[direction === 'undo' ? 'redo' : 'undo'].push(entry);
		this.publish(sheetId);
	}
	clear(sheetId: string) { this.sheets.delete(sheetId); for (const listener of this.listeners) listener(); }
}

/** Session-only history survives navigation, and is intentionally cleared by a reload. */
export const sheetHistory = new SheetHistory();
