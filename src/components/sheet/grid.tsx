'use client';

import { enrichmentIsStale } from '@/lib/enrichment-freshness';
import { categoryColor, categoryColorStyle } from '@/lib/category-colors';

import { isDocumentColumn } from '@/lib/document';
import { isEmailColumn } from '@/lib/email-draft';

import { isCheckboxColumn } from '@/lib/column-format';
import type { FormulaCopy } from '@/lib/formulas';
import { cellInput, columnAddress } from '@/lib/formula-input';
import { cellEditToken } from '@/lib/cell-content';
import { cellRangeBounds, cellRangeTsv, type CellRange } from '@/lib/cell-range';
import type { EntityField } from '@/lib/entity-fields';
import type { Column, Row, Sheet, Sort } from '@/lib/types';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Check, ChevronDown, MoreHorizontal, Play, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, memo, useCallback, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Select } from '@/components/ui/select';
import { CellView } from './cell-view';
import { DatePicker } from '@/components/ui/date-picker';
import { RowArrival } from './row-loading';
import { CompanyEditor } from './company-editor';
import { organizationKind } from '@/lib/organization-logo';
import type { CompanySuggestion } from '@/lib/company-search';
import type { Collaborator } from '@/lib/collaboration';
import { ConfirmDialog } from '@/components/ui/dialog';
import { formatValue } from '@/lib/template';
import { FormulaEditor } from './formula-editor';
import { useFormulaRangeEditor } from './formula-range-context';
import { activeDescendant, fillState, gridKeyDown, HEADER_HEIGHT, INDEX_WIDTH, ROW_HEIGHT, startCellDrag, startColumnDrag, type ActiveCell } from './grid-interactions';

export type { ActiveCell } from './grid-interactions';

const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 900;
const NO_COLLABORATORS: readonly Collaborator[] = [];

export interface GridProps {
	allRows?: Row[];
	collaborators?: readonly Collaborator[];
	cellDetailsOpen?: boolean;
	onRunCell?: (row: Row, column: Column) => void;
	loadingRows?: boolean;
	arrivalTimes?: ReadonlyMap<string, number>;
	sheet: Sheet;
	/** This viewer's sort, which the headers show. */
	sort: Sort | null;
	rows: Row[];
	rowNumbers: Map<string, number>;
	selected: Set<string>;
	onToggleRow: (rowId: string, shift: boolean) => void;
	onToggleAll: () => void;
	active: ActiveCell | null;
	range: CellRange | null;
	onSelectRange: (range: CellRange | null) => void;
	onFillCells: (copies: FormulaCopy[]) => void;
	onClearCells: (cells: ActiveCell[]) => void;
	onActivate: (cell: ActiveCell | null) => void;
	onOpenCell: (cell: ActiveCell) => void;
	onEditCell: (rowId: string, columnId: string, value: string, company?: CompanySuggestion) => void;
	onColumnMenu: (column: Column, anchor: DOMRect) => void;
	renamingColumnId: string | null;
	onSortColumn: (columnId: string) => void;
	onRenameColumn: (columnId: string, name: string) => void;
	onCancelRenameColumn: () => void;
	onRowMenu: (row: Row, anchor: { x: number; y: number }) => void;
	onCellMenu: (cell: ActiveCell, anchor: { x: number; y: number }) => void;
	onAddEntityColumn?: (source: Column, fields: EntityField[]) => void;
	onAddColumn: (anchor: DOMRect) => void;
	onAddColumnValue: (rowId: string, value: string) => Promise<void>;
	onMoveColumn: (columnId: string, toIndex: number) => void;
	onResizeColumn: (columnId: string, width: number) => void;
	onAddRow: () => void;
	onFormulaBuilder?: (cell: ActiveCell, draft: string) => void;
}

type EditConflict = { rowId: string; columnId: string; draft: string; current: string; company?: CompanySuggestion };

/** A stable function that runs the latest render's handler, so memoized rows and headers keep their props. */
function useStableHandler<A extends unknown[], R>(handler: (...args: A) => R) {
	const latest = useRef(handler);
	// Insertion effects run before any layout effect, so focus changes during a commit already reach this render's handler.
	useInsertionEffect(() => { latest.current = handler; });
	return useCallback((...args: A) => latest.current(...args), []);
}

/** Visible columns, showing a dragged width until the sheet reports it. */
function useColumnPreview(sheetColumns: Column[]) {
	const [preview, setPreview] = useState<{ columnId: string; width: number } | null>(null);
	if (preview && sheetColumns.find((column) => column.id === preview.columnId)?.width === preview.width) setPreview(null);
	const columns = useMemo(() => sheetColumns.filter((column) => !column.hidden).map((column) => column.id === preview?.columnId ? { ...column, width: preview.width } : column), [sheetColumns, preview]);
	const previewResize = useCallback((columnId: string, width: number) => setPreview({ columnId, width }), []);
	return { columns, previewResize };
}

export function Grid({ allRows, collaborators = NO_COLLABORATORS, cellDetailsOpen = false, loadingRows = false, arrivalTimes, sheet, sort, rows, rowNumbers, selected, onToggleRow, onToggleAll, active, range, onSelectRange, onFillCells, onClearCells, onActivate, onOpenCell, onEditCell, onColumnMenu, renamingColumnId, onSortColumn, onRenameColumn, onCancelRenameColumn, onRowMenu, onCellMenu, onAddEntityColumn, onAddColumn, onAddColumnValue, onMoveColumn, onResizeColumn, onAddRow, onFormulaBuilder, onRunCell }: GridProps) {
	const referenceRows = useMemo(() => [...(allRows ?? rows)].sort((a, b) => a.order - b.order), [allRows, rows]);
	const rangeEditor = useFormulaRangeEditor();
	const [handoff, setHandoff] = useState({ loading: loadingRows, next: rows.length });
	if (handoff.loading !== loadingRows) setHandoff({ loading: loadingRows, next: rows.length });
	const startRowText = useCallback((slot: number) => setHandoff((current) => slot + 1 > current.next ? { ...current, next: slot + 1 } : current), []);

	const { columns, previewResize } = useColumnPreview(sheet.columns);
	const scrollRef = useRef<HTMLDivElement>(null);
	const followArrivals = useRef(false);
	const wasLoading = useRef(false);
	const [editing, setEditing] = useState<ActiveCell | null>(null);
	const [newColumnRow, setNewColumnRow] = useState<string | null>(null);
	if (newColumnRow && active) setNewColumnRow(null);
	const editingVersion = useRef<string | undefined>(undefined);
	const [editConflict, setEditConflict] = useState<EditConflict | null>(null);
	const [editSeed, setEditSeed] = useState<string | undefined>();
	const startEditing = (cell: ActiveCell, seed?: string) => { editingVersion.current = cellEditToken(rows.find((row) => row.id === cell.rowId)?.cells[cell.columnId]); setEditSeed(seed); setEditing(cell); };
	const [fillPreview, setFillPreview] = useState<CellRange | null>(null);
	const [referenceRange, setReferenceRange] = useState<CellRange | null>(null);
	const dragCleanup = useRef<((cancel: boolean) => void) | null>(null);
	const suppressClickUntil = useRef(0);
	const [columnDrag, setColumnDrag] = useState<{ columnId: string; boundary: number } | null>(null);
	const lastWasReferencePick = useRef(false);
	const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
	const collaboratorsByRow = useMemo(() => {
		const byRow = new Map<string, Collaborator[]>();
		for (const peer of collaborators) if (peer.row_id) byRow.set(peer.row_id, [...(byRow.get(peer.row_id) ?? []), peer]);
		return byRow;
	}, [collaborators]);

	const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
	const columnIds = useMemo(() => columns.map((column) => column.id), [columns]);
	const rangeBounds = useMemo(() => cellRangeBounds(fillPreview ?? referenceRange ?? range, rowIds, columnIds), [fillPreview, referenceRange, range, rowIds, columnIds]);
	const fill = fillState(range, active, rows, columns, rowIndex, rowIds, columnIds);
	const canFill = !editing && !referenceRange && !rangeEditor.current && (fill.formulaFill || fill.enrichmentFill);
	const fillHandle = canFill ? fill.bounds : null;
	const layoutKey = JSON.stringify([rowIds, columnIds]);
	useEffect(() => () => dragCleanup.current?.(true), [layoutKey]);
	const editingIndex = editing ? rowIndex.get(editing.rowId) : undefined;
	const rowCount = rows.length + (loadingRows ? 3 : 0);
	const virtualizer = useVirtualizer({ count: rowCount, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_HEIGHT, overscan: 12,
		rangeExtractor: (range) => {
			const indices = defaultRangeExtractor(range);
			return editingIndex === undefined || indices.includes(editingIndex) ? indices : [...indices, editingIndex].sort((a, b) => a - b);
		},
	});

	const offsets = useMemo(() => {
		const list: number[] = [];
		let x = INDEX_WIDTH;
		for (const column of columns) {
			list.push(x);
			x += column.width;
		}
		list.push(x);
		return list;
	}, [columns]);
	const totalWidth = offsets[offsets.length - 1] + 160;
	const lastRowNumber = useMemo(() => rows.reduce((max, row) => Math.max(max, rowNumbers.get(row.id) ?? 0), 0), [rows, rowNumbers]);
	useLayoutEffect(() => {
		const starting = loadingRows && !wasLoading.current;
		if (starting) followArrivals.current = true;
		wasLoading.current = loadingRows;
		const scroller = scrollRef.current;
		if (loadingRows && followArrivals.current && scroller) {
			const top = scroller.scrollHeight - scroller.clientHeight;
			if (starting || window.matchMedia('(prefers-reduced-motion: reduce)').matches) scroller.scrollTop = top;
			else scroller.scrollTo({ top, behavior: 'smooth' });
		}
	}, [loadingRows, rows.length]);

	const revealColumn = useCallback((columnId: string) => {
		const columnIndex = columns.findIndex((column) => column.id === columnId);
		const scroller = scrollRef.current;
		if (columnIndex >= 0 && scroller) {
			const left = offsets[columnIndex];
			const right = left + columns[columnIndex].width;
			if (left - INDEX_WIDTH < scroller.scrollLeft) scroller.scrollLeft = left - INDEX_WIDTH;
			else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right - scroller.clientWidth;
		}
	}, [columns, offsets]);

	// Opening details can hide an already selected column without changing selection.
	useLayoutEffect(() => {
		const scroller = scrollRef.current;
		if (!cellDetailsOpen || !active || !scroller) return;
		const reveal = () => revealColumn(active.columnId);
		reveal();
		const observer = new ResizeObserver(reveal);
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [cellDetailsOpen, active, revealColumn]);

	const lastScrollTarget = useRef<ActiveCell | null>(null);
	// Follow cell navigation, not row reordering or other sheet updates.
	useEffect(() => {
		const target = range?.focus ?? active;
		const previous = lastScrollTarget.current;
		lastScrollTarget.current = target;
		if (!target || dragCleanup.current || (previous?.rowId === target.rowId && previous.columnId === target.columnId)) return;
		const index = rowIndex.get(target.rowId);
		if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'auto' });
		revealColumn(target.columnId);
	}, [active, range, rowIndex, virtualizer, revealColumn]);

	const interaction = { scrollRef, dragCleanup, suppressClickUntil, lastWasReferencePick, rangeEditor, rows, columns, sheetColumns: sheet.columns, offsets, rowIndex, rowNumbers, active, range, fill, setNewColumnRow, setFillPreview, setReferenceRange, setColumnDrag, onActivate, onOpenCell, onSelectRange, onFillCells, onMoveColumn };
	const beginCellDrag = useStableHandler((cell: ActiveCell, event: ReactPointerEvent<HTMLElement>, fillDrag?: boolean) => startCellDrag(interaction, cell, event, fillDrag));
	const beginColumnDrag = useStableHandler((columnId: string, event: ReactPointerEvent<HTMLButtonElement>) => startColumnDrag(interaction, columnId, event));
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => gridKeyDown({ editing, active, range, rows, columns, rowIndex, startEditing, onActivate, onSelectRange, onOpenCell, onEditCell, onClearCells }, event);
	const focusGrid = () => scrollRef.current?.focus({ preventScroll: true });

	// Handlers shared by every row; they take the row so memoized rows keep stable props.
	const activateNewColumn = useStableHandler((rowId: string) => { setNewColumnRow(rowId); onActivate(null); onSelectRange(null); });
	const openFormulaBuilder = useStableHandler((cell: ActiveCell, draft: string) => { setEditing(null); onFormulaBuilder?.(cell, draft); });
	const openCell = useStableHandler((cell: ActiveCell) => { if (!lastWasReferencePick.current) onOpenCell(cell); });
	const startCellEdit = useStableHandler((cell: ActiveCell) => { if (!lastWasReferencePick.current) startEditing(cell); });
	const commitEdit = useStableHandler((row: Row, columnId: string, value: string, company?: CompanySuggestion, moveDown?: boolean) => {
		if (editing?.rowId === row.id && editing.columnId === columnId && editingVersion.current !== cellEditToken(row.cells[columnId])) setEditConflict({ rowId: row.id, columnId, draft: value, current: formatValue(row.cells[columnId]?.v), company });
		else {
			onEditCell(row.id, columnId, value, company);
			if (moveDown) onActivate({ rowId: rows[Math.min(rows.length - 1, rowIndex.get(row.id)! + 1)].id, columnId });
		}
		setEditing(null);
		focusGrid();
	});
	const cancelEdit = useStableHandler(() => { setEditing(null); focusGrid(); });
	const openCellMenu = useStableHandler((cell: ActiveCell, anchor: { x: number; y: number }) => {
		dragCleanup.current?.(true);
		setNewColumnRow(cell.columnId ? null : cell.rowId);
		onActivate(cell.columnId ? cell : null);
		onSelectRange(cell.columnId ? { anchor: cell, focus: cell } : null);
		onCellMenu(cell, anchor);
	});
	// Rows and headers are parts of the grid composite, so the focusable grid owns their context menus.
	const openContextMenu = (event: MouseEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		const header = target.closest<HTMLElement>('[data-column-header]');
		const column = columns.find((entry) => entry.id === header?.dataset.columnHeader);
		const row = rows[rowIndex.get(target.closest<HTMLElement>('[data-grid-row]')?.dataset.gridRow ?? '') ?? -1];
		if (header && column) onColumnMenu(column, header.getBoundingClientRect());
		else if (row) onRowMenu(row, { x: event.clientX, y: event.clientY });
		else return;
		event.preventDefault();
	};

	useEffect(() => {
		const onCopy = (event: ClipboardEvent) => {
			if (!active || editing) return;
			const target = event.target as HTMLElement | null;
			if (target && target.closest('input, textarea, [contenteditable="true"]')) return;
			if (document.activeElement !== scrollRef.current) return;
			event.preventDefault();
			event.clipboardData?.setData('text/plain', cellRangeTsv(range ?? { anchor: active, focus: active }, rows, columns));
		};
		document.addEventListener('copy', onCopy);
		return () => document.removeEventListener('copy', onCopy);
	}, [active, range, editing, rows, columns]);

	useEffect(() => {
		const prepare = (event: PointerEvent) => {
			if ((event.target as HTMLElement).closest('[data-formula-editor]')) return;
			const rect = scrollRef.current?.getBoundingClientRect();
			if (rect && event.clientX >= rect.left + INDEX_WIDTH && event.clientX < rect.right && event.clientY >= rect.top + HEADER_HEIGHT && event.clientY < rect.bottom) rangeEditor.current?.prepareReferencePick();
		};
		window.addEventListener('pointermove', prepare, true);
		return () => window.removeEventListener('pointermove', prepare, true);
	}, [rangeEditor]);

	const virtualItems = virtualizer.getVirtualItems();

	// A new pointer gesture must not inherit click suppression from the previous drag.
	return (
		<div ref={scrollRef} tabIndex={0} onPointerDownCapture={() => { suppressClickUntil.current = 0; }} onScroll={(event) => { if (loadingRows) { const node = event.currentTarget; followArrivals.current = node.scrollHeight - node.scrollTop - node.clientHeight < ROW_HEIGHT * 2; } }} onKeyDown={onKeyDown} onContextMenu={openContextMenu} onDragStart={(event) => event.preventDefault()} onClickCapture={(event) => { if (performance.now() < suppressClickUntil.current) { event.preventDefault(); event.stopPropagation(); suppressClickUntil.current = 0; } }} aria-multiselectable="true" aria-label="Sheet grid" role="grid" aria-activedescendant={activeDescendant(active, columns, (rowId) => virtualItems.some((item) => rows[item.index]?.id === rowId))} aria-busy={loadingRows} aria-rowcount={rowCount} aria-colcount={columns.length} className="scrollbar-thin relative min-h-0 min-w-0 flex-1 touch-auto select-none overflow-auto overscroll-contain bg-surface outline-none">
			<div style={{ width: totalWidth, height: HEADER_HEIGHT + virtualizer.getTotalSize() + ROW_HEIGHT + 24, position: 'relative' }}>
				<GridHeader sheet={sheet} sort={sort} columns={columns} offsets={offsets} totalWidth={totalWidth} rows={rows} selected={selected} columnDrag={columnDrag} renamingColumnId={renamingColumnId} onToggleAll={onToggleAll} onAddColumn={onAddColumn} onStartDrag={beginColumnDrag} onColumnMenu={onColumnMenu} onResizeColumn={onResizeColumn} onPreviewResize={previewResize} onSortColumn={onSortColumn} onRenameColumn={onRenameColumn} onCancelRenameColumn={onCancelRenameColumn} />

				{/* Rows */}
				{virtualItems.map((virtualRow) => {
					const row = rows[virtualRow.index];
					const arrivalAt = row ? arrivalTimes?.get(row.id) : undefined;
					if (!row || (arrivalAt !== undefined && active?.rowId !== row.id && !selected.has(row.id))) {
						const offset = virtualRow.index - handoff.next;
						return <ArrivalGridRow key={`arrival-${virtualRow.index}`} row={row} arrivalAt={arrivalAt} slot={virtualRow.index} offset={offset} onTextStart={startRowText} number={row ? rowNumbers.get(row.id) ?? virtualRow.index + 1 : lastRowNumber + virtualRow.index - rows.length + 1} columns={columns} top={HEADER_HEIGHT + virtualRow.start} totalWidth={totalWidth} onCellPointerDown={beginCellDrag} onAddEntityColumn={onAddEntityColumn} totalRows={rowNumbers.size} remainingRows={rows.length - virtualRow.index} />;
					}
					return (
						<GridRow
							sheet={sheet}
							referenceRows={referenceRows}
							collaborators={collaboratorsByRow.get(row.id) ?? NO_COLLABORATORS}
							onAddColumnValue={onAddColumnValue}
							newColumnSelected={newColumnRow === row.id}
							onActivateNewColumn={activateNewColumn}
							key={row.id}
							row={row}
							index={(rowNumbers.get(row.id) ?? virtualRow.index + 1) - 1}
							totalRows={rowNumbers.size} remainingRows={rows.length - virtualRow.index}
							editSeed={editSeed}
							top={HEADER_HEIGHT + virtualRow.start}
							columns={columns}
							offsets={offsets}
							totalWidth={totalWidth}
							selected={selected.has(row.id)}
							range={rangeBounds && virtualRow.index >= rangeBounds.top && virtualRow.index <= rangeBounds.bottom ? { left: rangeBounds.left, right: rangeBounds.right, top: virtualRow.index === rangeBounds.top, bottom: virtualRow.index === rangeBounds.bottom, reference: Boolean(referenceRange) } : null}
							onCellPointerDown={beginCellDrag}
							onFormulaBuilder={openFormulaBuilder}
							activeColumnId={active?.rowId === row.id ? active.columnId : null}
							editingColumnId={editing?.rowId === row.id ? editing.columnId : null}
							onToggle={onToggleRow}
							onOpenCell={openCell}
							onStartEdit={startCellEdit}
							onCommitEdit={commitEdit}
							onCancelEdit={cancelEdit}
							onAddEntityColumn={onAddEntityColumn}
							onCellMenu={openCellMenu}
							onRunCell={onRunCell}
						/>
					);
				})}


				{fillHandle && <FillHandle formula={fill.formulaFill} left={offsets[fillHandle.right + 1] - 5} top={HEADER_HEIGHT + (fillHandle.bottom + 1) * ROW_HEIGHT - 5} onPointerDown={(event) => { event.stopPropagation(); beginCellDrag({ rowId: rows[fillHandle.bottom].id, columnId: columns[fillHandle.right].id }, event, true); }} />}
				{editConflict && <EditConflictDialog conflict={editConflict} onClose={() => setEditConflict(null)} onKeep={() => { onEditCell(editConflict.rowId, editConflict.columnId, editConflict.draft, editConflict.company); setEditConflict(null); }} />}
				<AddRowFooter top={HEADER_HEIGHT + virtualizer.getTotalSize()} totalWidth={totalWidth} firstColumnWidth={columns[0]?.width} onAddRow={onAddRow} />
			</div>
		</div>
	);
}

function FillHandle({ formula, left, top, onPointerDown }: { formula: boolean; left: number; top: number; onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void }) {
	return <button
		type="button" aria-label={formula ? 'Drag to fill formulas' : 'Drag to run enrichment'}
		title={formula ? 'Drag to fill formulas in any direction' : 'Drag up or down to run enrichment'}
		onPointerDown={onPointerDown}
		onKeyDown={(event) => event.stopPropagation()}
		className="absolute z-[15] size-2.5 touch-none cursor-crosshair rounded-full border-2 border-surface bg-brand shadow-[0_0_0_1px_var(--color-brand)] focus-visible:outline-2 focus-visible:outline-brand"
		style={{ left, top }}
	/>;
}

function EditConflictDialog({ conflict, onClose, onKeep }: { conflict: EditConflict; onClose: () => void; onKeep: () => void }) {
	return <ConfirmDialog title="This cell changed while you were editing" description={<span className="flex flex-col gap-2"><span>Another edit was saved. Cancel keeps the current value; your draft is shown below so you can copy it.</span><span>Current: <span className="select-all">{conflict.current || '(empty)'}</span></span><span>Your edit: <span className="select-all whitespace-pre-wrap">{conflict.draft || '(empty)'}</span></span></span>} confirmLabel="Keep my edit" onClose={onClose} onConfirm={onKeep} />;
}

function AddRowFooter({ top, totalWidth, firstColumnWidth = 120, onAddRow }: { top: number; totalWidth: number; firstColumnWidth?: number; onAddRow: () => void }) {
	return (
		<div className="absolute left-0 flex" style={{ top, width: totalWidth, height: ROW_HEIGHT }}>
			<button type="button" onClick={onAddRow} className="sticky left-0 flex h-full items-center gap-1.5 px-3 text-caption text-fg-subtle transition-colors hover:text-fg" style={{ width: Math.max(160, INDEX_WIDTH + firstColumnWidth) }}>
				<Plus className="size-3.5" strokeWidth={1.75} /> Add row
			</button>
		</div>
	);
}

/* ───────────────────────────── Header ───────────────────────────── */

interface GridHeaderProps {
	sheet: Sheet;
	sort: Sort | null;
	columns: Column[];
	offsets: number[];
	totalWidth: number;
	rows: Row[];
	selected: Set<string>;
	columnDrag: { columnId: string; boundary: number } | null;
	renamingColumnId: string | null;
	onToggleAll: () => void;
	onAddColumn: (anchor: DOMRect) => void;
	onStartDrag: (columnId: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
	onColumnMenu: (column: Column, anchor: DOMRect) => void;
	onResizeColumn: (columnId: string, width: number) => void;
	onPreviewResize: (columnId: string, width: number) => void;
	onSortColumn: (columnId: string) => void;
	onRenameColumn: (columnId: string, name: string) => void;
	onCancelRenameColumn: () => void;
}

function GridHeader({ sheet, sort, columns, offsets, totalWidth, rows, selected, columnDrag, renamingColumnId, onToggleAll, onAddColumn, onStartDrag, onColumnMenu, onResizeColumn, onPreviewResize, onSortColumn, onRenameColumn, onCancelRenameColumn }: GridHeaderProps) {
	const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
	return (
		<div role="row" className="sticky top-0 z-20 flex bg-neutral-5" style={{ height: HEADER_HEIGHT, width: totalWidth }}>
			<div role="columnheader" className="sticky left-0 z-30 flex items-center justify-center border-r border-b border-line bg-neutral-5" style={{ width: INDEX_WIDTH, flexShrink: 0 }}>
				<button type="button" role="checkbox" aria-checked={allSelected} aria-label="Select all rows" onClick={onToggleAll} className={clsx('grid size-4 place-items-center rounded-[4px] border transition-colors', allSelected ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface text-transparent hover:border-fg-subtle')}>
					<Check className="size-3" strokeWidth={3} />
				</button>
			</div>
			{columnDrag && <div aria-hidden className="pointer-events-none absolute inset-y-0 z-40 w-0.5 bg-brand" style={{ left: offsets[columnDrag.boundary] - 1 }} />}
			{columns.map((column) => (
				<HeaderCell key={column.id} column={column} address={columnAddress(sheet.columns.findIndex((entry) => entry.id === column.id))} sort={sort?.columnId === column.id ? sort.dir : null} onStartDrag={onStartDrag} dragging={columnDrag?.columnId === column.id} onMenu={onColumnMenu} onResize={onResizeColumn} onPreviewResize={onPreviewResize} renaming={renamingColumnId === column.id} onSort={onSortColumn} onRename={onRenameColumn} onCancelRename={onCancelRenameColumn} />
			))}
			<div className="flex h-full items-center border-b border-line" style={{ width: 160, flexShrink: 0 }}>
				<button type="button" aria-haspopup="menu" onClick={(event) => onAddColumn(event.currentTarget.getBoundingClientRect())} className="flex h-full w-full items-center gap-1.5 px-3 text-caption text-fg-subtle transition-colors hover:bg-tint/[0.03] hover:text-fg">
					<Plus className="size-3.5" strokeWidth={1.75} /> Add column <ChevronDown className="ml-auto size-3" strokeWidth={1.75} />
				</button>
			</div>
		</div>
	);
}

const HeaderCell = memo(function HeaderCell({ column, address, sort, onStartDrag, dragging, onMenu, onResize, onPreviewResize, renaming, onSort, onRename, onCancelRename }: { column: Column; address: string; sort: 'asc' | 'desc' | null; onStartDrag: (columnId: string, event: ReactPointerEvent<HTMLButtonElement>) => void; dragging: boolean; onMenu: (column: Column, anchor: DOMRect) => void; onResize: (columnId: string, width: number) => void; onPreviewResize: (columnId: string, width: number) => void; renaming: boolean; onSort: (columnId: string) => void; onRename: (columnId: string, name: string) => void; onCancelRename: () => void }) {
	const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const startX = event.clientX;
		const startWidth = column.width;
		let width = startWidth;
		const onMove = (move: PointerEvent) => {
			width = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, startWidth + move.clientX - startX));
			onPreviewResize(column.id, width);
		};
		const onUp = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			if (width !== startWidth) onResize(column.id, width);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	};
	const width = column.width;
	return (
		<div role="columnheader" data-column-header={column.id} aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : 'none'} className="group/header relative flex h-full items-center border-r border-b border-line text-caption text-fg-muted" style={{ width, flexShrink: 0, opacity: dragging ? 0.5 : 1 }}>
			{renaming ? <div className="relative h-full min-w-0 flex-1"><InlineEditor initial={column.name} selectInitial label="Rename column" onCommit={(name) => onRename(column.id, name)} onCancel={onCancelRename} /></div> : <button type="button" onPointerDown={(event) => onStartDrag(column.id, event)} onClick={() => onSort(column.id)} className="touch-auto cursor-pointer flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 pr-1 text-left transition-colors hover:bg-tint/[0.03]" title="Click to cycle ascending, descending, and original row order; drag to rearrange; right-click for column options">
				<span className="text-fg-subtle tabular">{address}</span>
				<span className="truncate">{column.name}</span>
				{sort === 'asc' && <ArrowUp className="ml-auto size-3 shrink-0 text-brand" strokeWidth={2} />}
				{sort === 'desc' && <ArrowDown className="ml-auto size-3 shrink-0 text-brand" strokeWidth={2} />}
			</button>}
			<button type="button" aria-label={`Column menu for ${column.name}`} onClick={(event) => onMenu(column, event.currentTarget.getBoundingClientRect())} className={clsx('relative mr-0.5 grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-opacity group-hover/header:opacity-100 group-focus-within/header:opacity-100 hover:bg-tint/[0.06] hover:text-fg focus-visible:opacity-100', renaming || column.type === 'enriched' ? 'opacity-100' : 'opacity-100 md:opacity-0 [@media(hover:none)]:opacity-100')}>
				{column.type === 'enriched' && !renaming && <Sparkles aria-hidden="true" className="absolute size-3.5 text-brand group-hover/header:opacity-0 group-focus-within/header:opacity-0 [@media(hover:none)]:opacity-0" strokeWidth={1.75} />}
				<MoreHorizontal aria-hidden="true" className={clsx('size-3.5', column.type === 'enriched' && !renaming && 'opacity-0 group-hover/header:opacity-100 group-focus-within/header:opacity-100 [@media(hover:none)]:opacity-100')} strokeWidth={1.75} />
			</button>
			<div role="separator" tabIndex={-1} aria-label={`Resize ${column.name}`} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} onPointerDown={startResize} onDoubleClick={() => onResize(column.id, 220)} className="absolute top-0 -right-[3px] z-10 h-full w-[7px] touch-none cursor-col-resize select-none hover:bg-brand/40 active:bg-brand/60" />
		</div>
	);
});

/* ───────────────────────────── Row ───────────────────────────── */

const ArrivalGridRow = memo(function ArrivalGridRow({ row, arrivalAt, slot, offset, onTextStart, number, columns, top, totalWidth, onCellPointerDown, onAddEntityColumn, remainingRows, totalRows }: { totalRows: number; remainingRows: number; onAddEntityColumn?: GridProps['onAddEntityColumn']; row?: Row; arrivalAt?: number; slot: number; offset: number; onTextStart: (slot: number) => void; number: number; columns: Column[]; top: number; totalWidth: number; onCellPointerDown: (cell: ActiveCell, event: ReactPointerEvent<HTMLDivElement>) => void }) {
	return <div role="row" data-arrival-slot={slot} data-loading-frontier={offset === 0 ? 'head' : undefined} aria-selected={row ? false : undefined} aria-rowindex={number} aria-label={row ? undefined : `Finding row ${number}`} className="absolute left-0 flex border-b border-line-subtle" style={{ top, height: ROW_HEIGHT, width: totalWidth }}>
		<div role="rowheader" className="sticky left-0 z-10 flex items-center justify-center border-r border-line-subtle bg-surface text-caption text-fg-subtle tabular" style={{ width: INDEX_WIDTH, flexShrink: 0 }}>{number}</div>
		{columns.map((column, c) => {
			const loading = !row && offset >= 0 && (offset === 0 || c < 3 - offset);
			return <div key={column.id} role="gridcell" aria-label={loading ? `Loading ${column.name}` : undefined} aria-selected={row ? false : undefined} onPointerDown={row ? (event) => onCellPointerDown({ rowId: row.id, columnId: column.id }, event) : undefined} className="relative flex h-full min-w-0 items-center overflow-hidden border-r border-line-subtle px-3 text-body-sm text-fg" style={{ width: column.width, flexShrink: 0 }}>
				<RowArrival at={arrivalAt} column={c} slot={slot} loading={loading} onTextStart={onTextStart} expandDelay={!row && offset === 0 && c >= 3 ? 100 + (c - 3) * 45 : 0}>{row && <CellView cell={row.cells[column.id]} column={column} row={row} columns={columns} remainingRows={remainingRows} totalRows={totalRows} onAddEntityColumn={onAddEntityColumn} />}</RowArrival>
			</div>;
		})}
	</div>;
});

interface GridRowProps {
	sheet: Sheet;
	referenceRows: Row[];
	newColumnSelected: boolean;
	onActivateNewColumn: (rowId: string) => void;
	onAddColumnValue: GridProps['onAddColumnValue'];
	collaborators: readonly Collaborator[];
	onRunCell?: GridProps['onRunCell'];
	onFormulaBuilder: (cell: ActiveCell, draft: string) => void;
	totalRows: number;
	remainingRows: number;
	onAddEntityColumn?: GridProps['onAddEntityColumn'];
	row: Row;
	index: number;
	top: number;
	columns: Column[];
	offsets: number[];
	totalWidth: number;
	selected: boolean;
	range: { left: number; right: number; top: boolean; bottom: boolean; reference: boolean } | null;
	onCellPointerDown: (cell: ActiveCell, event: ReactPointerEvent<HTMLDivElement>) => void;
	activeColumnId: string | null;
	editingColumnId: string | null;
	editSeed?: string;
	onToggle: (rowId: string, shift: boolean) => void;
	onOpenCell: (cell: ActiveCell) => void;
	onStartEdit: (cell: ActiveCell) => void;
	onCommitEdit: (row: Row, columnId: string, value: string, company?: CompanySuggestion, moveDown?: boolean) => void;
	onCancelEdit: () => void;
	onCellMenu: (cell: ActiveCell, anchor: { x: number; y: number }) => void;
}

const GridRow = memo(function GridRow({ sheet, referenceRows, newColumnSelected, onActivateNewColumn, onAddColumnValue, collaborators, row, index, top, columns, totalWidth, selected, range, onCellPointerDown, activeColumnId, editingColumnId, editSeed, onToggle, onOpenCell, onStartEdit, onCommitEdit, onCancelEdit, onCellMenu, onAddEntityColumn, remainingRows, totalRows, onFormulaBuilder, onRunCell }: GridRowProps) {
	const lastTouch = useRef(-Infinity);
	const style: CSSProperties = { position: 'absolute', top, left: 0, width: totalWidth, height: ROW_HEIGHT };
	return (
		<div role="row" data-grid-row={row.id} aria-rowindex={index + 1} aria-selected={selected} className={clsx('group/row flex border-b border-line-subtle', selected ? 'bg-blue-10/50' : activeColumnId ? 'bg-brand/[0.03]' : 'hover:bg-neutral-5/70')} style={style}>
			<div role="rowheader" className={clsx('sticky left-0 z-10 flex items-center justify-center border-r border-line-subtle text-caption text-fg-subtle tabular', selected ? 'bg-[#f1f5fe]' : 'bg-surface group-hover/row:bg-[#fbfbfb]')} style={{ width: INDEX_WIDTH, flexShrink: 0 }}>
				<button type="button" role="checkbox" aria-checked={selected} aria-label={`Select row ${index + 1}`} onClick={(event) => onToggle(row.id, event.shiftKey)} className={clsx('grid size-4 place-items-center rounded-[4px] border transition-opacity [@media(pointer:coarse)]:size-7', selected ? 'border-brand bg-brand text-white' : 'border-line-strong bg-surface text-transparent opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100')}>
					<Check className="size-3" strokeWidth={3} />
				</button>
				{/* The number overlaps the checkbox even when transparent; never let it intercept selection. */}
				<span className={clsx('pointer-events-none absolute select-none transition-opacity', selected ? 'opacity-0' : 'group-hover/row:opacity-0 [@media(hover:none)]:hidden')}>{index + 1}</span>
			</div>
			{columns.map((column, columnIndex) => {
				const cell = row.cells[column.id];
				const stale = enrichmentIsStale(sheet, referenceRows, row, column.id);
				const viewers = collaborators.filter((peer) => peer.column_id === column.id);
				const isActive = activeColumnId === column.id;
				const isEditing = editingColumnId === column.id;
				const isRightAligned = !isCheckboxColumn(column) && (typeof cell?.v === 'number' || ['number', 'currency', 'percent', 'unit'].includes(column.format ?? ''));
				const inRange = Boolean(range && columnIndex >= range.left && columnIndex <= range.right);
				return (
					<div
						key={column.id}
						id={`grid-cell-${row.id}-${column.id}`}
						role="gridcell"
						aria-selected={isActive || inRange}
						data-range-selected={inRange ? 'true' : undefined}
						data-formula-range={inRange && range?.reference ? 'true' : undefined}
						onPointerDown={(event) => { if (event.pointerType === 'touch') lastTouch.current = performance.now(); onCellPointerDown({ rowId: row.id, columnId: column.id }, event); }}
						onContextMenu={(event) => {
							// Keep native text-editing actions while an inline editor is open.
							event.stopPropagation();
							if (isEditing) return;
							event.preventDefault();
							onCellMenu({ rowId: row.id, columnId: column.id }, { x: event.clientX, y: event.clientY });
						}}
						onClick={(event) => {
							if (isEditing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest('button, a, input, [data-formula-editor]')) return;
							if ((event.target as HTMLElement).closest('[data-organization-chip], [data-document-chip]')) onOpenCell({ rowId: row.id, columnId: column.id });
						}}
						onDoubleClick={(event) => {
							if (performance.now() - lastTouch.current < 1000) return;
							if (isEditing || (event.target as HTMLElement).closest('button, [data-organization-chip]')) return;
							if (isEmailColumn(column) || isDocumentColumn(column)) onOpenCell({ rowId: row.id, columnId: column.id });
							else if (column.format === 'category' || column.type === 'source' || cell?.f || organizationKind(column) === 'company') onStartEdit({ rowId: row.id, columnId: column.id });
							else onOpenCell({ rowId: row.id, columnId: column.id });
						}}
						className={clsx('group/cell relative flex h-full min-w-0 items-center border-r border-line-subtle px-3 text-body-sm text-fg', isActive && 'shadow-[inset_0_0_0_1.5px_var(--color-brand)]', inRange && (range?.reference ? 'bg-success-soft' : 'bg-blue-10/70'), cell?.s === 'error' && 'bg-danger-soft/40', stale && (isRightAligned ? 'pl-8' : 'pr-8'))}
						style={{ width: column.width, flexShrink: 0 }}
					>
						{viewers.length > 0 && <span data-collaborator-cell title={viewers.map((peer) => `${peer.name} selected this cell`).join(', ')} className="pointer-events-none absolute inset-0 z-[25] border-2" style={{ borderColor: viewers[0].color }}><span className="absolute -right-[2px] bottom-full mb-[2px] max-w-full truncate rounded-t-[4px] px-2 py-0.5 text-[11px] font-semibold leading-4 text-white" style={{ background: viewers[0].color }}>{viewers.map((peer) => peer.name).join(', ')}</span></span>}
						{inRange && range && <span aria-hidden className="pointer-events-none absolute inset-0 z-[1] border-solid" style={{ borderColor: range.reference ? 'var(--color-success)' : 'var(--color-brand)', borderTopWidth: range.top ? 2 : 0, borderBottomWidth: range.bottom ? 2 : 0, borderLeftWidth: columnIndex === range.left ? 2 : 0, borderRightWidth: columnIndex === range.right ? 2 : 0 }} />}
						{column.format === 'date' && !cell?.f && (!isEditing || editSeed === undefined) && !['running', 'queued', 'error'].includes(cell?.s ?? '') ? (
							<DatePicker dateFormat={column.dateFormat} label={`${column.name} date`} value={cell?.v == null || cell.v === '' ? column.categoryOptions?.[0] ?? '' : String(cell.v)} editing={isEditing} onChange={(value) => onCommitEdit(row, column.id, value)} onClose={onCancelEdit} />
						) : column.format === 'category' && !cell?.f && (!isEditing || !editSeed?.startsWith('=')) && !['running', 'queued', 'error'].includes(cell?.s ?? '') ? (
							<Select variant="pill" aria-label={`${column.name} category`} autoFocus={isEditing} value={cell?.v == null || cell.v === '' ? column.categoryOptions?.[0] ?? '' : String(cell.v)}
								onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
								onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && isEditing) { event.preventDefault(); onCancelEdit(); } }}
								onValueChange={(value) => onCommitEdit(row, column.id, `'${value}`)} onBlur={isEditing ? onCancelEdit : undefined}
								style={categoryColorStyle(categoryColor(column, String(cell?.v || column.categoryOptions?.[0] || '')))} className="hover:brightness-95">
								{column.categoryOptions?.map((option) => <option key={option} value={option}><span className="inline-flex max-w-full items-center rounded-full px-2 py-0.5" style={categoryColorStyle(categoryColor(column, option))}>{option}</span></option>)}
							</Select>
						) : isEditing ? organizationKind(column) === 'company' && !cell?.f && !editSeed?.startsWith('=') ? (
							<InlineCompanyEditor initial={editSeed ?? cellInput(cell)} selectInitial={editSeed === undefined} onCommit={(value, company, moveDown) => onCommitEdit(row, column.id, value, company, moveDown)} onCancel={onCancelEdit} />
						) : <InlineFormulaEditor onFormulaBuilder={(draft) => onFormulaBuilder({ rowId: row.id, columnId: column.id }, draft)} initial={editSeed ?? cellInput(cell)} selectInitial={editSeed === undefined} onCommit={(value, key) => onCommitEdit(row, column.id, value, undefined, key === 'Enter')} onCancel={onCancelEdit} /> : <CellView cell={cell} column={column} row={row} columns={columns} remainingRows={remainingRows} totalRows={totalRows} onAddEntityColumn={onAddEntityColumn} onToggleCheckbox={(value) => onCommitEdit(row, column.id, String(value))} />}
						{!isEditing && column.type === 'enriched' && column.op && !cell?.f && onRunCell && cell?.s !== 'queued' && cell?.s !== 'running' && <button
							type="button" aria-label={`${stale ? 'Refresh' : 'Run'} ${column.name} for row ${index + 1}`} title={stale ? 'Inputs changed. Refresh this cell.' : 'Run this cell'} data-stale-enrichment={stale || undefined}
							onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
							onClick={(event) => { event.stopPropagation(); onRunCell(row, column); }}
							className={clsx('absolute z-[2] grid size-6 place-items-center rounded bg-surface text-brand shadow-sm transition-opacity hover:bg-blue-10 group-hover/cell:opacity-100 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-brand', stale ? 'opacity-100' : isActive ? 'opacity-0 [@media(hover:none)]:opacity-100' : 'opacity-0', isRightAligned ? 'left-1' : 'right-1')}
						>{stale ? <RefreshCw className="size-3.5" strokeWidth={1.75} /> : <Play className="size-3" fill="currentColor" strokeWidth={1.5} />}</button>}
					</div>
				);
			})}
			<NewColumnCell rowId={row.id} rowNumber={index + 1} onSave={onAddColumnValue} selected={newColumnSelected} onActivate={() => onActivateNewColumn(row.id)} onMenu={(anchor) => onCellMenu({ rowId: row.id, columnId: '' }, anchor)} onFormula={(draft) => onFormulaBuilder({ rowId: row.id, columnId: '' }, draft)} />
		</div>
	);
});

function InlineCompanyEditor({ initial, selectInitial, onCommit, onCancel }: { initial: string; selectInitial: boolean; onCommit: (value: string, company?: CompanySuggestion, moveDown?: boolean) => void; onCancel: () => void }) {
	const [value, setValue] = useState(initial);
	const finished = useRef(false);
	const enter = useRef(false);
	const commit = (company?: CompanySuggestion) => { if (!finished.current) { finished.current = true; onCommit(company?.name ?? value, company, enter.current); } };
	return <div className="contents" onKeyDownCapture={(event) => { enter.current = event.key === 'Enter'; }}><CompanyEditor value={value} onChange={setValue} selectInitial={selectInitial} inline onSelect={commit} onCommit={() => commit()} onBlur={() => commit()} onCancel={() => { finished.current = true; onCancel(); }} /></div>;
}

function InlineFormulaEditor({ initial, selectInitial, onCommit, onCancel, onFormulaBuilder }: { initial: string; selectInitial: boolean; onCommit: (value: string, key?: 'Enter' | 'Tab') => void; onCancel: () => void; onFormulaBuilder: (draft: string) => void }) {
	const [value, setValue] = useState(initial);
	return <div onKeyDownCapture={(event) => { if (event.altKey && event.key === 'Enter' && value.trimStart().startsWith('=')) { event.preventDefault(); event.stopPropagation(); onFormulaBuilder(value); } }} className="absolute inset-0 z-10 flex items-center bg-surface shadow-[inset_0_0_0_1.5px_var(--color-brand)]">
		<FormulaEditor value={value} onChange={setValue} onCommit={onCommit} onBlur={onCommit} onCancel={onCancel} autoFocus selectInitial={selectInitial} label="Edit cell value or formula" className="min-w-0 flex-1 px-3" />
		{value.trimStart().startsWith('=') && <button type="button" tabIndex={-1} aria-keyshortcuts="Alt+Enter" aria-label="Write formula with AI" title="Write formula with AI (Alt+Enter)" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onMouseDown={(event) => event.preventDefault()} onClick={() => onFormulaBuilder(value)} className="mr-1 grid size-7 shrink-0 place-items-center rounded-md bg-brand/10 text-brand hover:bg-brand/20"><Sparkles className="size-3.5" /></button>}
	</div>;
}

function InlineEditor({ initial, selectInitial, label = 'Edit cell value or formula', onCommit, onCancel }: { initial: string; label?: string; selectInitial: boolean; onCommit: (value: string) => void; onCancel: () => void }) {
	const ref = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(initial);
	const finished = useRef(false);
	const commit = () => { if (!finished.current) { finished.current = true; onCommit(value); } };
	useLayoutEffect(() => {
		ref.current?.focus();
		if (selectInitial) ref.current?.select();
		else ref.current?.setSelectionRange(initial.length, initial.length);
	}, [initial, selectInitial]);
	return (
		<input
			ref={ref}
			aria-label={label}
			spellCheck={false}
			value={value}
			onChange={(event) => setValue(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
				if (event.key === 'Enter') {
					event.preventDefault();
					commit();
				} else if (event.key === 'Escape') {
					event.preventDefault();
					finished.current = true;
					onCancel();
				} else if (event.key === 'Tab') {
					event.preventDefault();
					commit();
				}
				event.stopPropagation();
			}}
			className="absolute inset-0 z-10 h-full w-full bg-surface px-3 text-body-sm text-fg shadow-[inset_0_0_0_1.5px_var(--color-brand)] outline-none"
		/>
	);
}

/** The trailing column is only materialized once a nonempty draft is committed. */
function NewColumnCell({ rowId, rowNumber, onSave, selected, onActivate, onMenu, onFormula }: { rowId: string; rowNumber: number; onSave: GridProps['onAddColumnValue']; selected: boolean; onActivate: () => void; onMenu: (anchor: { x: number; y: number }) => void; onFormula: (draft: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState('');
	const [saving, setSaving] = useState(false);
	const pending = useRef(false);
	const cancelled = useRef(false);
	const commit = async () => {
		if (pending.current || cancelled.current) return;
		if (!value.trim()) { setEditing(false); return; }
		pending.current = true;
		setSaving(true);
		try { await onSave(rowId, value); setValue(''); setEditing(false); }
		catch { /* Keep the draft available for retry; the page reports the error. */ }
		finally { pending.current = false; setSaving(false); }
	};
	return <div role="gridcell" aria-label={`New column, row ${rowNumber}`} aria-selected={selected} tabIndex={0}
		onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => {
			event.preventDefault(); event.stopPropagation();
			if (saving) return;
			cancelled.current = true; setEditing(false); onActivate();
			onMenu({ x: event.clientX, y: event.clientY });
		}}
		onClick={() => { onActivate(); cancelled.current = false; setEditing(true); }}
		onKeyDown={(event) => {
			event.stopPropagation();
			if (editing) return;
			if (event.key === 'Enter' || event.key === 'F2' || event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
				event.preventDefault(); onActivate(); cancelled.current = false;
				if (event.key.length === 1) setValue(event.key);
				setEditing(true);
			}
		}}
		className={clsx("relative flex h-full shrink-0 items-center border-r border-line-subtle px-3 text-body-sm hover:bg-neutral-5 focus-visible:outline-2 focus-visible:outline-brand", selected && "shadow-[inset_0_0_0_1.5px_var(--color-brand)]")} style={{ width: 160 }}>
		{editing && <input autoFocus aria-label={`Value for new column, row ${rowNumber}`} value={value} readOnly={saving} aria-busy={saving}
			onChange={(event) => setValue(event.target.value)} onBlur={() => void commit()}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.nativeEvent.isComposing || event.keyCode === 229) return;
				if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setValue(''); setEditing(false); }
				if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); void commit(); }
			}}
			className="absolute inset-0 w-full bg-surface pl-3 pr-9 text-body-sm outline-none shadow-[inset_0_0_0_1.5px_var(--color-brand)]" />}
		{selected && <button type="button" aria-label="Write formula with AI" title="Write formula with AI" disabled={saving}
			onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
			onClick={(event) => { event.stopPropagation(); cancelled.current = true; setEditing(false); onFormula(value.trimStart().startsWith('=') ? value : ''); }}
			className="absolute right-1 z-10 grid size-7 place-items-center rounded-md bg-surface text-brand hover:bg-blue-10"><Sparkles className="size-3.5" /></button>}
	</div>;
}
