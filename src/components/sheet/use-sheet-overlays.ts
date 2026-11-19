'use client';

import type { Column, EntityKind, Row } from '@/lib/types';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ActiveCell } from './grid';

export type EditorState = { column?: Column; insertAt?: number; initialOp?: Column['op']; initialName?: string };
export type FormulaBuilderState = { cell?: ActiveCell; draft?: string; column?: Column; insertAt?: number };
export type ConfirmState = { title: string; description: string; label: string; danger?: boolean; action: () => Promise<unknown> };

/** The sheet's open menus and dialogs. */
export function useSheetOverlays() {
	const [columnMenu, setColumnMenu] = useState<{ column: Column; anchor: DOMRect } | null>(null);
	const [addColumnMenu, setAddColumnMenu] = useState<DOMRect | null>(null);
	const [rowMenu, setRowMenu] = useState<{ row: Row; anchor: { x: number; y: number } } | null>(null);
	const [cellMenu, setCellMenu] = useState<{ cell: ActiveCell; anchor: { x: number; y: number } } | null>(null);
	const [formulaBuilder, setFormulaBuilder] = useState<FormulaBuilderState | null>(null);
	const [editor, setEditor] = useState<EditorState | null>(null);
	const [formatColumn, setFormatColumn] = useState<Column | null>(null);
	const [importOpen, setImportOpen] = useState(false);
	const [importAfterRowId, setImportAfterRowId] = useState<string>();
	const [renamingColumnId, setRenamingColumnId] = useState<string | null>(null);
	const [renamingSheet, setRenamingSheet] = useState(false);
	const [confirm, setConfirm] = useState<ConfirmState | null>(null);
	return {
		columnMenu, setColumnMenu, addColumnMenu, setAddColumnMenu, rowMenu, setRowMenu, cellMenu, setCellMenu,
		formulaBuilder, setFormulaBuilder, editor, setEditor, formatColumn, setFormatColumn,
		importOpen, setImportOpen, importAfterRowId, setImportAfterRowId,
		renamingColumnId, setRenamingColumnId, renamingSheet, setRenamingSheet, confirm, setConfirm,
		...usePopulateLaunch(),
	};
}

export type SheetOverlayState = ReturnType<typeof useSheetOverlays>;

/** The Find rows dialog. ?find=1 (from "New sheet → find with AI") opens it once, then drops the param. */
function usePopulateLaunch() {
	const searchParams = useSearchParams();
	const [populateOpen, setPopulateOpen] = useState(false);
	const [populateEntity, setPopulateEntity] = useState<EntityKind>();
	const findParam = searchParams.get('find') === '1';
	const [consumedFind, setConsumedFind] = useState(false);
	if (findParam && !consumedFind) {
		setConsumedFind(true);
		const entity = searchParams.get('entity');
		if (entity === 'companies' || entity === 'people' || entity === 'websites') setPopulateEntity(entity);
		setPopulateOpen(true);
	}
	useEffect(() => {
		if (!findParam) return;
		// Consume the launch flag without navigating away from the open composer.
		const url = new URL(window.location.href);
		url.searchParams.delete('find');
		url.searchParams.delete('entity');
		window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
	}, [findParam]);
	return { populateOpen, setPopulateOpen, populateEntity, setPopulateEntity };
}
