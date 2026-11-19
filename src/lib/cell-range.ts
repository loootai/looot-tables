import { columnAddress } from './formula-input';
import { formatValue } from './template';
import type { Column, Row } from './types';

export interface CellAddress { rowId: string; columnId: string }
export interface CellRange { anchor: CellAddress; focus: CellAddress }
export interface CellRangeBounds { top: number; bottom: number; left: number; right: number }

export function cellRangeBounds(range: CellRange | null, rowIds: string[], columnIds: string[]): CellRangeBounds | null {
	if (!range) return null;
	const a = rowIds.indexOf(range.anchor.rowId), b = rowIds.indexOf(range.focus.rowId);
	const c = columnIds.indexOf(range.anchor.columnId), d = columnIds.indexOf(range.focus.columnId);
	if (Math.min(a, b, c, d) < 0) return null;
	return { top: Math.min(a, b), bottom: Math.max(a, b), left: Math.min(c, d), right: Math.max(c, d) };
}

function runs(values: number[]): Array<[number, number]> {
	const result: Array<[number, number]> = [];
	for (const value of [...new Set(values)].sort((a, b) => a - b)) {
		const last = result.at(-1);
		if (last && last[1] + 1 === value) last[1] = value;
		else result.push([value, value]);
	}
	return result;
}

/** Use stable sheet coordinates, even when the display is sorted, filtered, or hides columns. */
export function cellRangeReference(range: CellRange | null, rows: Row[], columns: Column[], rowNumbers: Map<string, number>, allColumns: Column[]): string {
	const bounds = cellRangeBounds(range, rows.map((row) => row.id), columns.map((column) => column.id));
	if (!bounds) return '';
	const rowRuns = runs(rows.slice(bounds.top, bounds.bottom + 1).flatMap((row) => rowNumbers.has(row.id) ? [rowNumbers.get(row.id)!] : []));
	const columnRuns = runs(columns.slice(bounds.left, bounds.right + 1).map((column) => allColumns.findIndex((candidate) => candidate.id === column.id)).filter((index) => index >= 0));
	return rowRuns.flatMap(([top, bottom]) => columnRuns.map(([left, right]) => {
		const first = `${columnAddress(left)}${top}`, last = `${columnAddress(right)}${bottom}`;
		return first === last ? first : `${first}:${last}`;
	})).join(',');
}

export function cellsInRange(range: CellRange | null, rows: Row[], columns: Column[]): CellAddress[] {
	const bounds = cellRangeBounds(range, rows.map((row) => row.id), columns.map((column) => column.id));
	return bounds ? rows.slice(bounds.top, bounds.bottom + 1).flatMap((row) => columns.slice(bounds.left, bounds.right + 1).map((column) => ({ rowId: row.id, columnId: column.id }))) : [];
}

export function cellRangeTsv(range: CellRange | null, rows: Row[], columns: Column[]): string {
	const bounds = cellRangeBounds(range, rows.map((row) => row.id), columns.map((column) => column.id));
	if (!bounds) return '';
	return rows.slice(bounds.top, bounds.bottom + 1).map((row) => columns.slice(bounds.left, bounds.right + 1).map((column) => {
		const cell = row.cells[column.id];
		const value = cell?.s === 'error' ? '' : formatValue(cell?.v);
		return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
	}).join('\t')).join('\n');
}
