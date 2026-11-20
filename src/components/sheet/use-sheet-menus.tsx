'use client';

import type { MenuItem } from '@/components/ui/menu';
import { addEmptyRow, newColumn, updateColumn } from '@/lib/db';
import { defaultEmailFind } from '@/lib/email-defaults';
import { OPERATIONS } from '@/lib/operations';
import { uniqueName } from '@/lib/references';
import type { SheetCommands } from '@/lib/sheet-commands';
import type { Column, Row, Sheet, Sort } from '@/lib/types';
import { unpackableFields } from '@/lib/unpack';
import { routedJob } from '@/lib/job-of';
import { PackageOpen, Route } from 'lucide-react';
import { ArrowDown, ArrowUp, Columns3, Eraser, EyeOff, FileText, Filter, FunctionSquare, Mail, MoveLeft, MoveRight, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2, Upload } from 'lucide-react';
import type { ActiveCell } from './grid';
import { deleteColumnNotice, plural } from './sheet-page-utils';
import type { SheetActions } from './use-sheet-actions';
import type { SheetRows } from './use-sheet-data';
import type { SheetOverlayState } from './use-sheet-overlays';
import type { SheetSelection } from './use-sheet-selection';
import type { SheetViewState } from './use-sheet-view';

/** Items for the Add menu, the column header menu, and the row and cell context menus. */
export function useSheetMenus({ sheetId, sheet, allRows, commands, content, selection, overlays, actions, view, onFilter }: { sheetId: string; sheet: Sheet; allRows: Row[]; commands: SheetCommands; content: SheetRows; selection: SheetSelection; overlays: SheetOverlayState; actions: SheetActions; view: SheetViewState; onFilter: () => void }) {
	const { rows, enrichedColumns, rowById } = content;	const { columnNames, report, runCells } = actions;
	const announceUnpack = (added: number) => actions.toast(`Added ${added} ${added === 1 ? 'column' : 'columns'} from answers already paid for. Nothing ran.`);

	const addColumnItems = (insertAt?: number): MenuItem[] => [
		{ label: 'AI column', icon: <Sparkles />, onSelect: () => overlays.setEditor({ insertAt }) },
		{ label: 'Formula', icon: <FunctionSquare />, onSelect: () => overlays.setFormulaBuilder({ column: newColumn({ name: uniqueName('Formula', columnNames), type: 'source' }), insertAt }) },
		{ label: 'Find email', icon: <Mail />, onSelect: () => overlays.setEditor({ insertAt, initialOp: defaultEmailFind(sheet.columns), initialName: uniqueName(OPERATIONS['email-enrichment'].columnName, columnNames) }) },
		{ label: 'Blank column', icon: <Columns3 />, onSelect: () => actions.addBlankColumn(insertAt) },
	];
	const addItems: MenuItem[] = [
		{ heading: 'Rows', label: '' },
		{ label: 'Add row', icon: <Plus />, onSelect: () => void addEmptyRow(sheetId, selection.insertAfterRowId).catch(report('Could not add row.')) },
		{ label: 'Import CSV rows', icon: <Upload />, onSelect: () => { overlays.setImportAfterRowId(selection.insertAfterRowId); overlays.setImportOpen(true); } },
		{ separator: true, label: '' },
		{ heading: 'Columns', label: '' },
		...addColumnItems(selection.insertColumnAt),
	];
	const columnMenuItems = (column: Column): MenuItem[] => {
		const index = sheet.columns.findIndex((entry) => entry.id === column.id);
		const sorted = (dir: Sort['dir']) => view.sort?.columnId === column.id && view.sort.dir === dir;
		return [
			...(column.type === 'enriched' ? [
				{ label: 'Edit AI column', icon: <Pencil />, onSelect: () => overlays.setEditor({ column }) },
				{ label: 'Run unfinished cells', icon: <Play />, onSelect: () => runCells(rows, [column], 'unfinished') },
				{ label: rows.length === allRows.length ? 'Re-run all cells' : `Re-run ${plural(rows.length, 'visible cell')}`, icon: <RefreshCw />, onSelect: () => runCells(rows, [column], 'all') },				...(routedJob(column.op) ? [{ label: 'Routing…', icon: <Route />, onSelect: () => overlays.setRouting({ column, anchor: overlays.columnMenu?.anchor ?? new DOMRect(200, 120, 0, 0) }) }] : []),
				...((fields) => fields.length ? [{ label: `Unpack ${fields.map((field) => field.name).join(', ')} · $0`, icon: <PackageOpen />, onSelect: () => void commands.unpackColumn(column, allRows).then((added) => added && announceUnpack(added), report('Could not unpack this column')) }] : [])(unpackableFields(column, allRows)),
				{ label: 'Clear cells', icon: <Eraser />, onSelect: () => overlays.setConfirm({ title: `Clear “${column.name}”?`, description: 'Every value in this column is removed. Its instructions stay.', label: 'Clear', danger: true, action: () => commands.clearColumn(column.id) }) },
				{ separator: true, label: '' },
			] : []),
			{ label: 'Field format', icon: <FileText />, onSelect: () => overlays.setFormatColumn(column) },
			{ label: 'Rename', icon: <Pencil />, onSelect: () => overlays.setRenamingColumnId(column.id) },
			{ separator: true, label: '' },
			{ label: 'Sort A → Z', icon: <ArrowUp />, checked: sorted('asc'), onSelect: () => view.sortBy(column.id, 'asc') },
			{ label: 'Sort Z → A', icon: <ArrowDown />, checked: sorted('desc'), onSelect: () => view.sortBy(column.id, 'desc') },
			{ label: 'Filter by this column', icon: <Filter />, onSelect: () => { onFilter(); view.setFilters([...view.filters, { id: Math.random().toString(36).slice(2, 10), columnId: column.id, op: 'contains', value: '' }]); } },
			{ separator: true, label: '' },
			{ label: 'Insert column left', icon: <MoveLeft />, items: addColumnItems(index) },
			{ label: 'Insert column right', icon: <MoveRight />, items: addColumnItems(index + 1) },
			{ label: 'Hide column', icon: <EyeOff />, onSelect: () => void updateColumn(sheetId, column.id, { hidden: true }).catch(report('Could not hide column')) },
			{ separator: true, label: '' },
			{ label: 'Delete column', icon: <Trash2 />, danger: true, onSelect: () => overlays.setConfirm({ title: `Delete “${column.name}”?`, description: deleteColumnNotice(sheet.columns, column), label: 'Delete column', danger: true, action: () => commands.deleteColumn(column.id) }) },
		];
	};
	const rowMenuItems = (row: Row): MenuItem[] => {
		const targets = selection.selected.has(row.id) ? selection.selectedRows : [row];
		const label = targets.length > 1 ? `${targets.length} rows` : 'row';
		return [
			{ label: `Run unfinished cells in ${label}`, icon: <Play />, disabled: enrichedColumns.length === 0, onSelect: () => runCells(targets, enrichedColumns, 'unfinished') },
			{ label: `Re-run ${label}`, icon: <RefreshCw />, disabled: enrichedColumns.length === 0, onSelect: () => runCells(targets, enrichedColumns, 'all') },
			{ separator: true, label: '' },
			{ label: `Delete ${label}`, icon: <Trash2 />, danger: true, onSelect: () => actions.confirmDeleteRows(targets) },
		];
	};
	const cellMenuItems = (cell: ActiveCell): MenuItem[] => {
		const row = rowById.get(cell.rowId);
		return [{
			label: 'Write formula with AI', icon: <Sparkles />,
			disabled: commands.isPending(cell.rowId, cell.columnId),
			onSelect: () => actions.openCellFormulaBuilder(cell, row?.cells[cell.columnId]?.f ?? ''),
		}, { separator: true, label: '' }, ...(row ? rowMenuItems(row) : [])];
	};
	return { addItems, addColumnItems, columnMenuItems, rowMenuItems, cellMenuItems };
}

export type SheetMenuItems = ReturnType<typeof useSheetMenus>;
