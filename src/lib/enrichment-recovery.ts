'use client';

import { updateCellsIf, type CellChange } from './db';
import { expiredCell } from './enrichment-plan';
import { serverNow } from './server-clock';
import type { Row } from './types';

/** Save the expiry of abandoned runs (see `expiredCell`), judged on the server's clock, without treating this tab's own
    work as abandoned. */
export async function recoverStalledEnrichments(sheetId: string, rows: Row[], isPending: (rowId: string, columnId: string) => boolean, now = serverNow()) {
	const changes: CellChange[] = [];
	for (const row of rows) {
		if (row.sheetId !== sheetId) continue;
		for (const [columnId, cell] of Object.entries(row.cells)) {
			const expired = expiredCell(cell, now);
			if (!expired || isPending(row.id, columnId)) continue;
			// A local task might have started while persistence was awaiting its lock.
			changes.push({ rowId: row.id, columnId, expected: cell, update: () => isPending(row.id, columnId) ? undefined : expired });
		}
	}
	if (changes.length) await updateCellsIf(sheetId, changes);
}
