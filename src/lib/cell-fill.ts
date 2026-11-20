import { cellRangeBounds, type CellRange } from './cell-range';
import type { FormulaCopy } from './formulas';
import type { Column, Row } from './types';

/** Repeat the selected pattern into the extended rectangle, excluding its source. */
export function cellFillCopies(source: CellRange, destination: CellRange, rows: Row[], columns: Column[]): FormulaCopy[] {
	const rowIds = rows.map((row) => row.id), columnIds = columns.map((column) => column.id);
	const from = cellRangeBounds(source, rowIds, columnIds), to = cellRangeBounds(destination, rowIds, columnIds);
	if (!from || !to) return [];
	const mod = (value: number, size: number) => ((value % size) + size) % size;
	const copies: FormulaCopy[] = [];
	for (let r = to.top; r <= to.bottom; r++) for (let c = to.left; c <= to.right; c++) {
		if (r >= from.top && r <= from.bottom && c >= from.left && c <= from.right) continue;
		copies.push({
			source: { rowId: rows[from.top + mod(r - from.top, from.bottom - from.top + 1)].id, columnId: columns[from.left + mod(c - from.left, from.right - from.left + 1)].id },
			target: { rowId: rows[r].id, columnId: columns[c].id },
		});
	}
	return copies;
}
