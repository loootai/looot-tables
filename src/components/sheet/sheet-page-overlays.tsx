'use client';

import { RoutingEditor } from './routing-editor';
import { ConfirmDialog, NameDialog } from '@/components/ui/dialog';
import { FloatingMenu } from '@/components/ui/menu';
import { updateSheet } from '@/lib/db';
import { cellFromInput } from '@/lib/formula-input';
import { populateRunner } from '@/lib/populate-runner';
import { uniqueName } from '@/lib/references';
import type { RunScope } from '@/lib/run-scope';
import type { SheetCommands } from '@/lib/sheet-commands';
import type { Column, ColumnOp, Row, Sheet } from '@/lib/types';
import type { RefObject } from 'react';
import { ColumnEditorDialog } from './column-editor';
import { ColumnFormatDialog } from './column-format-dialog';
import { FormulaBuilder } from './formula-builder';
import type { ActiveCell } from './grid';
import { ImportCsvDialog } from './import-csv-dialog';
import { PopulateDialog } from './populate-dialog';
import type { SheetActions } from './use-sheet-actions';
import type { SheetRows } from './use-sheet-data';
import type { SheetMenuItems } from './use-sheet-menus';
import type { EditorState, FormulaBuilderState, SheetOverlayState } from './use-sheet-overlays';

/** The column, Add column, cell and row menus. */
export function SheetMenus({ overlays, menus, onSaveRouting }: { overlays: SheetOverlayState; menus: SheetMenuItems; onSaveRouting?: (column: Column, op: ColumnOp) => Promise<void> }) {
	const { columnMenu, addColumnMenu, cellMenu, rowMenu, routing } = overlays;
	return <>
		{columnMenu && <FloatingMenu anchor={columnMenu.anchor} items={menus.columnMenuItems(columnMenu.column)} onClose={() => overlays.setColumnMenu(null)} width="w-60" />}
		{addColumnMenu && <FloatingMenu anchor={addColumnMenu} items={menus.addColumnItems()} onClose={() => overlays.setAddColumnMenu(null)} />}
		{cellMenu && <FloatingMenu anchor={cellMenu.anchor} onClose={() => overlays.setCellMenu(null)} width="w-64" items={menus.cellMenuItems(cellMenu.cell)} />}
		{rowMenu && <FloatingMenu anchor={rowMenu.anchor} items={menus.rowMenuItems(rowMenu.row)} onClose={() => overlays.setRowMenu(null)} width="w-60" />}
		{routing && onSaveRouting && <RoutingEditor key={routing.column.id} column={routing.column} anchor={routing.anchor} onClose={() => overlays.setRouting(null)} onSave={(op) => onSaveRouting(routing.column, op)} />}
	</>;
}

type DialogsProps = { sheetId: string; sheet: Sheet; allRows: Row[]; commands: SheetCommands; content: SheetRows; activeIndex: number; overlays: SheetOverlayState; actions: SheetActions; onActivate: (cell: ActiveCell) => void; findButtonRef: RefObject<HTMLButtonElement | null> };

/** The sheet's dialogs, stacked in the order they can open over one another. */
export function SheetDialogs({ sheetId, sheet, allRows, commands, content, activeIndex, overlays, actions, onActivate, findButtonRef }: DialogsProps) {
	const { formulaBuilder, editor, formatColumn, confirm } = overlays;
	return <>
		{formulaBuilder && <SheetFormulaBuilder sheet={sheet} allRows={allRows} state={formulaBuilder} commands={commands} saveCell={content.saveCell} onActivate={onActivate} onClose={() => overlays.setFormulaBuilder(null)} />}
		{editor && <SheetColumnEditor sheet={sheet} allRows={allRows} rows={content.rows} activeIndex={activeIndex} editor={editor} commands={commands} actions={actions} onClose={() => overlays.setEditor(null)} />}
		{formatColumn && <ColumnFormatDialog column={formatColumn} commands={commands} onClose={() => overlays.setFormatColumn(null)} />}
		{overlays.populateOpen && <PopulateDialog sheet={sheet} rowCount={allRows.length} initialEntity={overlays.populateEntity} collapseTarget={findButtonRef} onGenerate={(request) => populateRunner.start(sheet, request)} onClose={() => { overlays.setPopulateOpen(false); overlays.setPopulateEntity(undefined); }} />}
		{overlays.importOpen && <ImportCsvDialog sheetId={sheetId} afterRowId={overlays.importAfterRowId} onClose={() => overlays.setImportOpen(false)} onImported={() => {}} />}
		{overlays.renamingSheet && <NameDialog title="Rename sheet" initial={sheet.name} confirmLabel="Rename" onClose={() => overlays.setRenamingSheet(false)} onSubmit={(name) => updateSheet(sheetId, { name })} />}
		{confirm && (
			<ConfirmDialog
				title={confirm.title}
				description={confirm.description}
				confirmLabel={confirm.label}
				danger={confirm.danger}
				onClose={() => overlays.setConfirm(null)}
				onConfirm={async () => { await confirm.action(); }}
			/>
		)}
	</>;
}

/** Writes a formula for one cell, or for a new formula column (inserted at `insertAt`, or created beside the cell). */
function SheetFormulaBuilder({ sheet, allRows, state, commands, saveCell, onActivate, onClose }: { sheet: Sheet; allRows: Row[]; state: FormulaBuilderState; commands: SheetCommands; saveCell: SheetRows['saveCell']; onActivate: (cell: ActiveCell) => void; onClose: () => void }) {
	const insertAt = state.insertAt ?? sheet.columns.length;
	const applyFormula = async (formula: string, name: string) => {
		if (state.column) {
			const column = { ...state.column, name: uniqueName(state.cell ? 'New column' : name, sheet.columns.map((item) => item.name)) };
			if (state.cell) {
				await commands.addColumns([column], { kind: 'formula', initialCell: { rowId: state.cell.rowId, columnId: column.id, cell: cellFromInput(formula, column) } });
				onActivate({ rowId: state.cell.rowId, columnId: column.id });
			} else await commands.addColumns([column], { kind: 'formula', position: state.insertAt, formula });
		} else if (state.cell) {
			const column = sheet.columns.find((item) => item.id === state.cell!.columnId);
			if (column) await saveCell(state.cell.rowId, column.id, cellFromInput(formula, column));
		}
	};
	return <FormulaBuilder originalColumns={sheet.columns} columns={state.column ? [...sheet.columns.slice(0, insertAt), state.column, ...sheet.columns.slice(insertAt)] : sheet.columns} rows={allRows} columnId={state.column?.id ?? state.cell!.columnId} rowId={state.cell?.rowId} initial={state.draft} newColumn={Boolean(state.column && !state.cell)} onClose={onClose} onApply={applyFormula} />;
}

/** Creates or edits an AI column, then runs it over the rows the editor chose, starting at the active row. */
function SheetColumnEditor({ sheet, allRows, rows, activeIndex, editor, commands, actions, onClose }: { sheet: Sheet; allRows: Row[]; rows: Row[]; activeIndex: number; editor: EditorState; commands: SheetCommands; actions: SheetActions; onClose: () => void }) {
	// The editor previews the draft with this plan, then it is planned again once saved: an edit stops the column's
	// pending cells first, so the run asks again only if it outgrew the estimate the editor showed.
	const planRun = (column: Column, scope: RunScope) => commands.plan(scope.scope === 'column' ? allRows : rows.slice(activeIndex, activeIndex + scope.count), [column], editor.column ? 'all' : 'unfinished', { ready: actions.providerReady, grid: { sheet, rows: allRows }, limitToRows: true, sheetColumns: [...sheet.columns.filter((item) => item.id !== column.id), column] });
	return (
		<ColumnEditorDialog
			sheet={sheet}
			column={editor.column}
			insertAt={editor.insertAt}
			initialOp={editor.initialOp}
			initialName={editor.initialName}
			sampleRow={rows[activeIndex]}
			rows={allRows}
			remainingRows={rows.length - activeIndex}
			totalRows={allRows.length}
			onClose={onClose}
			commands={commands}
			planRun={planRun}
			onSaved={(column, run) => { if (run) actions.request(planRun(column, run.scope), run.seen); }}
		/>
	);
}
