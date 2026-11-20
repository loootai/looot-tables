'use client';

import { cellRangeBounds, type CellRange } from '@/lib/cell-range';
import { publishSelection } from '@/lib/realtime-client';
import type { Row, Sheet } from '@/lib/types';
import { useEffect, useRef, useState } from 'react';
import type { ActiveCell } from './grid';

/** Checked rows, the active cell and range (shared with collaborators), its details panel, and where Add inserts. */
export function useSheetSelection(sheet: Sheet, rows: Row[], rowById: ReadonlyMap<string, Row>) {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [active, setActive] = useState<ActiveCell | null>(null);
	useEffect(() => { publishSelection(active?.rowId ?? null, active?.columnId ?? null); }, [active?.rowId, active?.columnId]);
	const [cellRange, setCellRange] = useState<CellRange | null>(null);
	const [panelOpen, setPanelOpen] = useState(false);
	const lastToggled = useRef<string | null>(null);

	const activeRow = active ? rowById.get(active.rowId) : undefined;
	const activeColumn = active ? sheet.columns.find((column) => column.id === active.columnId) : undefined;
	const activeCell = activeRow && activeColumn ? activeRow.cells[activeColumn.id] : undefined;
	const selectedRows = rows.filter((row) => selected.has(row.id));
	const bounds = cellRangeBounds(cellRange, rows.map((row) => row.id), sheet.columns.map((column) => column.id));
	const insertColumnAt = bounds ? bounds.right + 1 : active ? sheet.columns.findIndex((column) => column.id === active.columnId) + 1 || undefined : undefined;
	const insertAfterRowId = selectedRows.at(-1)?.id ?? (bounds ? rows[bounds.bottom]?.id : active?.rowId);

	const toggleRow = (rowId: string, shift: boolean) => {
		const next = new Set(selected);
		const from = shift && lastToggled.current ? rows.findIndex((row) => row.id === lastToggled.current) : -1;
		const to = from < 0 ? -1 : rows.findIndex((row) => row.id === rowId);
		if (to >= 0) for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(rows[i].id);
		else {
			if (next.has(rowId)) next.delete(rowId);
			else next.add(rowId);
			lastToggled.current = rowId;
		}
		setSelected(next);
	};
	const toggleAll = () => setSelected(rows.every((row) => selected.has(row.id)) ? new Set() : new Set(rows.map((row) => row.id)));
	const activate = (cell: ActiveCell | null) => {
		setActive(cell);
		setCellRange(cell ? { anchor: cell, focus: cell } : null);
		if (!cell) setPanelOpen(false);
	};
	const openCell = (cell: ActiveCell) => {
		setActive(cell);
		setCellRange({ anchor: cell, focus: cell });
		setPanelOpen(true);
	};
	return {
		selected, setSelected, selectedRows, toggleRow, toggleAll,
		active, setActive, activate, openCell, activeRow, activeColumn, activeCell, activeIndex: Math.max(0, rows.findIndex((row) => row.id === active?.rowId)),
		cellRange, setCellRange, panelOpen, setPanelOpen, insertColumnAt, insertAfterRowId,
	};
}

export type SheetSelection = ReturnType<typeof useSheetSelection>;
