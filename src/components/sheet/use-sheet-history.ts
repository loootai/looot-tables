'use client';

import { useToast } from '@/components/ui/toast';
import { redoSheet, undoSheet } from '@/lib/db';
import { sheetHistory } from '@/lib/sheet-history';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { messageOf } from './sheet-page-utils';

/** Undo and redo for the sheet, from the toolbar or ⌘Z / ⌘⇧Z / Ctrl+Y outside text fields and dialogs. */
export function useSheetHistory(sheetId: string) {
	const { toast } = useToast();
	const historyState = useSyncExternalStore(sheetHistory.subscribe, () => sheetHistory.getSnapshot(sheetId), () => sheetHistory.getSnapshot(sheetId));
	const [busy, setBusy] = useState(false);
	const pendingHistory = useRef(0);
	const navigate = useCallback(async (direction: 'undo' | 'redo') => {
		pendingHistory.current += 1;
		setBusy(true);
		try { await (direction === 'undo' ? undoSheet(sheetId) : redoSheet(sheetId)); }
		catch (error) { toast(messageOf(error, 'Could not restore change'), 'error'); }
		finally { pendingHistory.current -= 1; setBusy(pendingHistory.current > 0); }
	}, [sheetId, toast]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.altKey || event.isComposing || !(event.metaKey || event.ctrlKey)) return;
			const target = event.target;
			if (target instanceof HTMLElement && (target.closest('input, textarea, select, [contenteditable="true"], dialog, [role="dialog"]') || target.isContentEditable)) return;
			const key = event.key.toLowerCase();
			if (key !== 'z' && !(key === 'y' && event.ctrlKey && !event.shiftKey)) return;
			event.preventDefault();
			void navigate(key === 'y' || event.shiftKey ? 'redo' : 'undo');
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [navigate]);
	return { undo: historyState.undo > 0, redo: historyState.redo > 0, busy, navigate: (direction: 'undo' | 'redo') => void navigate(direction) };
}
