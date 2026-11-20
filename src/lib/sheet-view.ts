'use client';

import { z } from 'zod';
import { accountStorageKey } from './account-storage';
import type { Filter, Sheet, Sort } from './types';
import { sheetSchema } from './workspace';

/* Filters and sort are each viewer's own: kept in this browser per workspace account and sheet, never written to the
   shared sheet, so changing them leaves teammates' grids and exports alone. A viewer who hasn't changed them yet sees
   the view the sheet saved before views moved here (the sheet's `filters` and `sort`, still read by agents). */

export interface SheetView { filters: Filter[]; sort: Sort | null }

const viewSchema = z.object({ filters: sheetSchema.shape.filters, sort: sheetSchema.shape.sort });
const listeners = new Set<() => void>();
// Views that storage refused (private mode, quota) last for this page.
const unsaved = new Map<string, string>();
const storageKey = (sheetId: string) => accountStorageKey(`looot-tables.sheet-view.v1.${sheetId}`);

/** The stored view as text, for useSyncExternalStore: equal text is the same view. */
export function storedSheetView(sheetId: string): string | null {
	try {
		const key = storageKey(sheetId);
		try { return unsaved.get(key) ?? localStorage.getItem(key); } catch { return unsaved.get(key) ?? null; }
	} catch { return null; }
}

export function subscribeSheetViews(listener: () => void) {
	listeners.add(listener);
	window.addEventListener('storage', listener);
	return () => { listeners.delete(listener); window.removeEventListener('storage', listener); };
}

/** The view `stored` describes, or the sheet's saved one, without filters or a sort on columns since deleted. */
export function sheetView(stored: string | null, sheet: Pick<Sheet, 'filters' | 'sort' | 'columns'>): SheetView {
	let view: SheetView = { filters: sheet.filters, sort: sheet.sort };
	try { if (stored) view = viewSchema.parse(JSON.parse(stored)); } catch { /* A damaged entry falls back to the saved view. */ }
	const columns = new Set(sheet.columns.map((column) => column.id));
	return { filters: view.filters.filter((filter) => columns.has(filter.columnId)), sort: view.sort && columns.has(view.sort.columnId) ? view.sort : null };
}

export function saveSheetView(sheetId: string, view: SheetView) {
	try {
		const key = storageKey(sheetId), text = JSON.stringify(view);
		try { localStorage.setItem(key, text); unsaved.delete(key); } catch { unsaved.set(key, text); }
	} catch { /* Signed out: nothing to keep. */ }
	listeners.forEach((listener) => listener());
}
