'use client';

import { nextSort } from '@/lib/filters';
import { saveSheetView, sheetView, storedSheetView, subscribeSheetViews } from '@/lib/sheet-view';
import type { Filter, Sheet, Sort } from '@/lib/types';
import { useMemo, useSyncExternalStore } from 'react';

/** This viewer's filters and sort for the sheet (see sheet-view.ts). Changes are not undo steps: undo is for the shared sheet. */
export function useSheetView(sheet: Sheet) {
	const stored = useSyncExternalStore(subscribeSheetViews, () => storedSheetView(sheet.id), () => null);
	const view = useMemo(() => sheetView(stored, sheet), [stored, sheet]);
	// From the latest stored view, so two changes in one event both apply.
	const current = () => sheetView(storedSheetView(sheet.id), sheet);
	return {
		...view,
		setFilters: (filters: Filter[]) => saveSheetView(sheet.id, { ...current(), filters }),
		/** See `nextSort`: no `dir` cycles the column (a header click); a `dir` sets it, or clears it when already set. */
		sortBy: (columnId: string, dir?: Sort['dir']) => { const latest = current(); saveSheetView(sheet.id, { ...latest, sort: nextSort(latest.sort, columnId, dir) }); },
	};
}

export type SheetViewState = ReturnType<typeof useSheetView>;
