import type { Dispatch, KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject, SetStateAction } from 'react';
import { cellFillCopies } from '@/lib/cell-fill';
import { cellRangeBounds, cellRangeReference, cellsInRange, type CellRange } from '@/lib/cell-range';
import { isCheckboxColumn } from '@/lib/column-format';
import type { FormulaCopy } from '@/lib/formulas';
import { organizationKind } from '@/lib/organization-logo';
import type { Column, Row } from '@/lib/types';
import type { FormulaRangeEditor } from './formula-range-context';

export const ROW_HEIGHT = 33;
export const HEADER_HEIGHT = 40;
export const INDEX_WIDTH = 48;

export interface ActiveCell {
	rowId: string;
	columnId: string;
}

type Bounds = NonNullable<ReturnType<typeof cellRangeBounds>>;

/** What the fill handle would copy: the selection's formulas in any direction, or one enrichment column down. */
export function fillState(range: CellRange | null, active: ActiveCell | null, rows: Row[], columns: Column[], rowIndex: Map<string, number>, rowIds: string[], columnIds: string[]) {
	const source = range ?? (active ? { anchor: active, focus: active } : null);
	const bounds = cellRangeBounds(source, rowIds, columnIds);
	const sources = cellsInRange(source, rows, columns);
	const formula = (address: ActiveCell) => rows[rowIndex.get(address.rowId) ?? -1]?.cells[address.columnId]?.f;
	const formulaFill = sources.length > 0 && sources.every(formula);
	const enrichmentFill = Boolean(bounds && bounds.left === bounds.right && columns[bounds.left]?.op && sources.every((address) => !formula(address)));
	return { source, bounds, formulaFill, enrichmentFill };
}

/** The cell id the focused grid announces, while that cell is rendered. */
export function activeDescendant(active: ActiveCell | null, columns: Column[], rendered: (rowId: string) => boolean) {
	if (!active || !columns.some((column) => column.id === active.columnId) || !rendered(active.rowId)) return undefined;
	return `grid-cell-${active.rowId}-${active.columnId}`;
}

export interface GridInteraction {
	scrollRef: RefObject<HTMLDivElement | null>;
	dragCleanup: RefObject<((cancel: boolean) => void) | null>;
	suppressClickUntil: RefObject<number>;
	lastWasReferencePick: RefObject<boolean>;
	rangeEditor: RefObject<FormulaRangeEditor | null>;
	rows: Row[];
	columns: Column[];
	sheetColumns: Column[];
	offsets: number[];
	rowIndex: Map<string, number>;
	rowNumbers: Map<string, number>;
	active: ActiveCell | null;
	range: CellRange | null;
	fill: { source: CellRange | null; bounds: Bounds | null; enrichmentFill: boolean };
	setNewColumnRow: Dispatch<SetStateAction<string | null>>;
	setFillPreview: Dispatch<SetStateAction<CellRange | null>>;
	setReferenceRange: Dispatch<SetStateAction<CellRange | null>>;
	setColumnDrag: Dispatch<SetStateAction<{ columnId: string; boundary: number } | null>>;
	onActivate: (cell: ActiveCell | null) => void;
	onOpenCell: (cell: ActiveCell) => void;
	onSelectRange: (range: CellRange | null) => void;
	onFillCells: (copies: FormulaCopy[]) => void;
	onMoveColumn: (columnId: string, toIndex: number) => void;
}

/** Selects, extends, fills or picks a formula reference from a pointer drag across cells. */
export function startCellDrag(grid: GridInteraction, cell: ActiveCell, event: ReactPointerEvent<HTMLElement>, fill = false) {
	const { rows, columns, offsets, rowIndex, active, range, rangeEditor, dragCleanup, onActivate, onOpenCell, onSelectRange } = grid;
	if (event.button !== 0 || event.ctrlKey || (event.target as HTMLElement).closest('[data-formula-editor], input[type=checkbox]')) return;
	const scroller = grid.scrollRef.current;
	if (!scroller) return;
	grid.setNewColumnRow(null);
	dragCleanup.current?.(true);
	// Let the browser own touch panning. Select only after a stationary tap,
	// so swiping through a sheet cannot start a range drag or move the viewport.
	if (event.pointerType === 'touch' && !fill) {
		if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
		const { clientX, clientY, pointerId } = event;
		const finish = () => {
			window.removeEventListener('pointerup', tap);
			window.removeEventListener('pointercancel', finish);
			window.removeEventListener('blur', finish);
			dragCleanup.current = null;
		};
		const tap = (up: PointerEvent) => {
			if (up.pointerId !== pointerId) return;
			finish();
			if (Math.hypot(up.clientX - clientX, up.clientY - clientY) > 10) return;
			if (active?.rowId === cell.rowId && active.columnId === cell.columnId) onOpenCell(cell);
			else onActivate(cell);
		};
		dragCleanup.current = finish;
		window.addEventListener('pointerup', tap);
		window.addEventListener('pointercancel', finish);
		window.addEventListener('blur', finish);
		return;
	}
	const session = fill ? null : rangeEditor.current?.beginReferencePick() ?? null;
	const source = fill ? grid.fill.source : null;
	const bounds = fill ? grid.fill.bounds : null;
	let destination = source;
	grid.lastWasReferencePick.current = Boolean(session);
	event.preventDefault();
	const previousRange = range, previousActive = active;
	const anchor = !session && event.shiftKey ? (range?.anchor ?? active ?? cell) : cell;
	const select = (focus: ActiveCell) => {
		const next = { anchor, focus };
		if (fill && bounds) {
			const r = rowIndex.get(focus.rowId) ?? bounds.bottom;
			const c = grid.fill.enrichmentFill ? bounds.right : columns.findIndex((column) => column.id === focus.columnId);
			destination = { anchor: { rowId: rows[Math.min(bounds.top, r)].id, columnId: columns[Math.min(bounds.left, c)].id }, focus: { rowId: rows[Math.max(bounds.bottom, r)].id, columnId: columns[Math.max(bounds.right, c)].id } };
			grid.setFillPreview(destination);
		} else if (session) {
			grid.setReferenceRange(next);
			session.update(cellRangeReference(next, rows, columns, grid.rowNumbers, grid.sheetColumns));
		} else onSelectRange(next);
	};
	if (!session && !fill) {
		if (document.activeElement instanceof HTMLElement && document.activeElement !== scroller) document.activeElement.blur();
		onActivate(anchor);
		scroller.focus({ preventScroll: true });
	}
	let pointerX = event.clientX, pointerY = event.clientY;
	const startX = pointerX, startY = pointerY, pointerId = event.pointerId;
	let moved = false, frame = 0;
	let last = cell;
	const atPointer = () => {
		const rect = scroller.getBoundingClientRect();
		const y = Math.max(HEADER_HEIGHT, Math.min(rect.height - 1, pointerY - rect.top)) + scroller.scrollTop - HEADER_HEIGHT;
		const x = Math.max(INDEX_WIDTH, Math.min(rect.width - 1, pointerX - rect.left)) + scroller.scrollLeft;
		const r = Math.max(0, Math.min(rows.length - 1, Math.floor(y / ROW_HEIGHT)));
		let c = columns.length - 1;
		for (let i = 0; i < columns.length; i++) if (x < offsets[i + 1]) { c = i; break; }
		if (!rows[r] || !columns[c]) return;
		const focus = { rowId: rows[r].id, columnId: columns[c].id };
		if (focus.rowId === last.rowId && focus.columnId === last.columnId) return;
		last = focus;
		select(focus);
	};
	const finish = (cancel: boolean) => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointercancel', onCancel);
		window.removeEventListener('blur', onCancel);
		window.removeEventListener('keydown', onKey, true);
		cancelAnimationFrame(frame);
		dragCleanup.current = null;
		if (scroller.hasPointerCapture(pointerId)) scroller.releasePointerCapture(pointerId);
		if (moved) grid.suppressClickUntil.current = performance.now() + 200;
		grid.setReferenceRange(null);
		grid.setFillPreview(null);
		if (fill && source && destination) {
			if (!cancel && moved) {
				const copies = cellFillCopies(source, destination, rows, columns);
				if (copies.length) { grid.onFillCells(copies); onSelectRange(destination); }
			}
		} else if (session) { if (cancel) session.cancel(); else session.finish(); }
		else if (cancel) { onActivate(previousActive); onSelectRange(previousRange); }
	};
	const onMove = (move: PointerEvent) => {
		if (move.pointerId !== pointerId) return;
		pointerX = move.clientX; pointerY = move.clientY;
		if (!moved && Math.hypot(pointerX - startX, pointerY - startY) >= 3) {
			moved = true;
			scroller.setPointerCapture(pointerId);
		}
		if (move.cancelable) move.preventDefault();
		if (moved) atPointer();
	};
	const onUp = (up: PointerEvent) => { if (up.pointerId === pointerId) finish(false); };
	const onCancel = () => finish(true);
	const onKey = (key: globalThis.KeyboardEvent) => {
		if (key.key !== 'Escape') return;
		key.preventDefault(); key.stopPropagation(); finish(true);
	};
	const scroll = () => {
		if (moved) {
			const rect = scroller.getBoundingClientRect();
			const velocity = (position: number, low: number, high: number) => position < low + 28 ? -Math.min(22, (low + 28 - position) / 2) : position > high - 28 ? Math.min(22, (position - high + 28) / 2) : 0;
			const beforeX = scroller.scrollLeft, beforeY = scroller.scrollTop;
			scroller.scrollLeft += velocity(pointerX, rect.left + INDEX_WIDTH, rect.right);
			scroller.scrollTop += velocity(pointerY, rect.top + HEADER_HEIGHT, rect.bottom);
			if (beforeX !== scroller.scrollLeft || beforeY !== scroller.scrollTop) atPointer();
		}
		frame = requestAnimationFrame(scroll);
	};
	dragCleanup.current = finish;
	window.addEventListener('pointermove', onMove, { passive: false });
	window.addEventListener('pointerup', onUp);
	window.addEventListener('pointercancel', onCancel);
	window.addEventListener('blur', onCancel);
	window.addEventListener('keydown', onKey, true);
	select(cell);
	frame = requestAnimationFrame(scroll);
}

/** Reorders a column by dragging its header, resolving the drop against the full order including hidden columns. */
export function startColumnDrag(grid: GridInteraction, columnId: string, event: ReactPointerEvent<HTMLButtonElement>) {
	const { columns, offsets, dragCleanup } = grid;
	if (event.button !== 0 || event.pointerType === 'touch' || columns.length < 2) return;
	const scroller = grid.scrollRef.current;
	if (!scroller) return;
	dragCleanup.current?.(true);
	const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
	let pointerX = startX, moved = false, boundary = 0, frame = 0;
	const update = () => {
		const rect = scroller.getBoundingClientRect();
		const x = Math.max(INDEX_WIDTH, Math.min(rect.width, pointerX - rect.left)) + scroller.scrollLeft;
		boundary = columns.findIndex((column, index) => x < offsets[index] + column.width / 2);
		if (boundary === -1) boundary = columns.length;
		grid.setColumnDrag((current) => current?.columnId === columnId && current.boundary === boundary ? current : { columnId, boundary });
	};
	const finish = (cancel: boolean) => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointercancel', onCancel);
		window.removeEventListener('blur', onCancel);
		window.removeEventListener('keydown', onKey, true);
		cancelAnimationFrame(frame);
		dragCleanup.current = null;
		if (scroller.hasPointerCapture(pointerId)) scroller.releasePointerCapture(pointerId);
		grid.setColumnDrag(null);
		if (!moved) return;
		grid.suppressClickUntil.current = performance.now() + 200;
		if (cancel) return;
		const sheetColumns = grid.sheetColumns;
		const from = sheetColumns.findIndex((column) => column.id === columnId);
		const before = boundary < columns.length
			? sheetColumns.findIndex((column) => column.id === columns[boundary].id)
			: sheetColumns.findIndex((column) => column.id === columns[columns.length - 1].id) + 1;
		const to = before > from ? before - 1 : before;
		if (to !== from) grid.onMoveColumn(columnId, to);
	};
	const onMove = (move: PointerEvent) => {
		if (move.pointerId !== pointerId) return;
		pointerX = move.clientX;
		if (!moved && Math.hypot(pointerX - startX, move.clientY - startY) >= 5) {
			moved = true;
			scroller.setPointerCapture(pointerId);
		}
		if (moved) { move.preventDefault(); update(); }
	};
	const onUp = (up: PointerEvent) => { if (up.pointerId === pointerId) finish(false); };
	const onCancel = () => finish(true);
	const onKey = (key: globalThis.KeyboardEvent) => {
		if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(true); }
	};
	const scroll = () => {
		if (moved) {
			const rect = scroller.getBoundingClientRect();
			const before = scroller.scrollLeft;
			if (pointerX < rect.left + INDEX_WIDTH + 28) scroller.scrollLeft -= 12;
			else if (pointerX > rect.right - 28) scroller.scrollLeft += 12;
			if (before !== scroller.scrollLeft) update();
		}
		frame = requestAnimationFrame(scroll);
	};
	dragCleanup.current = finish;
	window.addEventListener('pointermove', onMove, { passive: false });
	window.addEventListener('pointerup', onUp);
	window.addEventListener('pointercancel', onCancel);
	window.addEventListener('blur', onCancel);
	window.addEventListener('keydown', onKey, true);
	frame = requestAnimationFrame(scroll);
}

export interface GridKeys {
	editing: ActiveCell | null;
	active: ActiveCell | null;
	range: CellRange | null;
	rows: Row[];
	columns: Column[];
	rowIndex: Map<string, number>;
	startEditing: (cell: ActiveCell, seed?: string) => void;
	onActivate: (cell: ActiveCell | null) => void;
	onSelectRange: (range: CellRange | null) => void;
	onOpenCell: (cell: ActiveCell) => void;
	onEditCell: (rowId: string, columnId: string, value: string) => void;
	onClearCells: (cells: ActiveCell[]) => void;
}

function moveSelection({ active, range, rows, columns, rowIndex, onActivate, onSelectRange }: GridKeys, dRow: number, dCol: number, extend = false) {
	const target = extend ? range?.focus ?? active : active;
	if (!target) return;
	const r = rowIndex.get(target.rowId);
	const c = columns.findIndex((column) => column.id === target.columnId);
	if (r === undefined || c === -1) return;
	const nextRow = rows[Math.max(0, Math.min(rows.length - 1, r + dRow))];
	const nextColumn = columns[Math.max(0, Math.min(columns.length - 1, c + dCol))];
	if (nextRow && nextColumn) {
		const next = { rowId: nextRow.id, columnId: nextColumn.id };
		if (extend) onSelectRange({ anchor: range?.anchor ?? active ?? next, focus: next });
		else onActivate(next);
	}
}

/** Spreadsheet keys on the focused grid: arrows/Tab/Enter move, F2/typing edit, Space toggles or opens, Delete clears. */
export function gridKeyDown(grid: GridKeys, event: KeyboardEvent<HTMLDivElement>) {
	const { active, rows, columns } = grid;
	if (event.defaultPrevented) return;
	if (grid.editing) return;
	if (!active) return;
	const move = (dRow: number, dCol: number, extend = false) => moveSelection(grid, dRow, dCol, extend);
	const column = columns.find((entry) => entry.id === active.columnId);
	const cell = rows[grid.rowIndex.get(active.rowId) ?? -1]?.cells[active.columnId];
	const editable = column?.type === 'source' || Boolean(cell?.f) || Boolean(column && organizationKind(column) === 'company');
	switch (event.key) {
		case 'ArrowDown':
			event.preventDefault();
			move(event.metaKey ? rows.length : 1, 0, event.shiftKey);
			break;
		case 'ArrowUp':
			event.preventDefault();
			move(event.metaKey ? -rows.length : -1, 0, event.shiftKey);
			break;
		case 'ArrowRight':
			event.preventDefault();
			move(0, 1, event.shiftKey);
			break;
		case 'Tab':
			event.preventDefault();
			move(0, event.shiftKey && event.key === 'Tab' ? -1 : 1);
			break;
		case 'ArrowLeft':
			event.preventDefault();
			move(0, -1, event.shiftKey);
			break;
		case 'Enter':
			event.preventDefault();
			move(event.shiftKey ? -1 : 1, 0);
			break;
		case 'F2':
			event.preventDefault();
			if (editable) grid.startEditing(active);
			else grid.onOpenCell(active);
			break;
		case ' ':
			event.preventDefault();
			if (column && isCheckboxColumn(column) && !cell?.f) grid.onEditCell(active.rowId, active.columnId, cell?.v === true ? 'false' : 'true');
			else grid.onOpenCell(active);
			break;
		case 'Escape':
			grid.onActivate(null);
			break;
		case 'Backspace':
		case 'Delete':
			event.preventDefault();
			grid.onClearCells(cellsInRange(grid.range ?? { anchor: active, focus: active }, rows, columns));
			break;
		default:
			if ((editable || event.key === '=') && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
				event.preventDefault();
				grid.startEditing(active, event.key);
			}
	}
}
