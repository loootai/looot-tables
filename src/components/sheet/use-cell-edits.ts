'use client';

import { setCell } from '@/lib/db';
import type { Cell, Row } from '@/lib/types';
import { useCallback, useMemo, useRef, useState } from 'react';

type PendingEdit = { rowId: string; columnId: string; cell: Cell };

/** Bridge the gap between closing an editor and receiving its committed live query. */
export function useCellEdits(persistedRows: Row[] | undefined) {
	const [pending, setPending] = useState<PendingEdit[]>([]);
	const lastTimestamp = useRef(0);
	const persistedById = useMemo(() => new Map(persistedRows?.map((row) => [row.id, row])), [persistedRows]);
	const unacknowledged = pending.filter((edit) => {
		const row = persistedById.get(edit.rowId);
		return row && (row.cells[edit.columnId]?.t ?? -Infinity) < edit.cell.t;
	});
	// Drop acknowledged edits during render, so formulas and later undo operations
	// display the actual persisted result immediately, without an extra paint.
	if (unacknowledged.length !== pending.length) setPending(unacknowledged);

	const rows = useMemo(() => {
		if (!pending.length) return persistedRows;
		const byRow = new Map<string, PendingEdit[]>();
		for (const edit of pending) {
			if ((persistedById.get(edit.rowId)?.cells[edit.columnId]?.t ?? -Infinity) >= edit.cell.t) continue;
			const edits = byRow.get(edit.rowId) ?? [];
			edits.push(edit);
			byRow.set(edit.rowId, edits);
		}
		return persistedRows?.map((row) => {
			const edits = byRow.get(row.id);
			return edits ? { ...row, cells: { ...row.cells, ...Object.fromEntries(edits.map((edit) => [edit.columnId, edit.cell])) } } : row;
		});
	}, [persistedRows, persistedById, pending]);

	const saveCell = useCallback(async (rowId: string, columnId: string, input: Cell) => {
		// A distinct version also disambiguates rapid successive edits to the same cell.
		const t = Math.max(input.t, (persistedById.get(rowId)?.cells[columnId]?.t ?? 0) + 1, lastTimestamp.current + 1);
		lastTimestamp.current = t;
		const edit: PendingEdit = { rowId, columnId, cell: { ...input, t } };
		setPending((current) => [...current.filter((item) => item.rowId !== rowId || item.columnId !== columnId), edit]);
		try { await setCell(rowId, columnId, edit.cell); }
		catch (error) {
			// An older failed write must not roll back a newer edit.
			setPending((current) => current.filter((item) => item !== edit));
			throw error;
		}
	}, [persistedById]);

	return { rows, saveCell };
}
