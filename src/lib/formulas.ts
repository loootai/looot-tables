import { Model, getTokens, quoteName, type Clipboard } from '@ironcalc/wasm';
import { columnAddress } from './formula-input';
import type { Cell, Column, Row } from './types';

export interface FormulaGrid { columns: Column[]; rows: Row[] }
export interface FormulaCopy { source: { rowId: string; columnId: string }; target: { rowId: string; columnId: string } }
export interface FormulaRequest { grid: FormulaGrid; next?: FormulaGrid; copies?: FormulaCopy[] }
export interface FormulaResult { rowId: string; columnId: string; cell: Cell }

function input(cell: Cell | undefined): string {
	if (cell?.f) return cell.f;
	if (cell?.s === 'error') return '#VALUE!';
	if (!cell || cell.v === null) return '';
	if (typeof cell.v === 'number') return String(cell.v);
	if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
	// Force strings to stay text, including strings starting with '=' from imports or enrichment.
	return `'${Array.isArray(cell.v) ? cell.v.join(', ') : cell.v}`;
}

/** The WASM module must be initialized before calling this (in a worker in the app). */
export function calculateFormulas({ grid, next, copies = [] }: FormulaRequest): FormulaResult[] {
	const model = new Model('LoootTables', 'en', 'UTC', 'en');
	try {
		model.pauseEvaluation();
		grid.rows.forEach((row, r) => grid.columns.forEach((column, c) => {
			const text = input(row.cells[column.id]);
			if (text) model.setUserInput(0, r + 1, c + 1, text);
		}));
		if (next) {
			// Let IronCalc rewrite references, including absolute references and ranges.
			const reconcile = (oldIds: string[], newIds: string[], axis: 'rows' | 'columns') => {
				const ids = [...oldIds];
				const wanted = new Set(newIds);
				for (let i = ids.length - 1; i >= 0; i--) if (!wanted.has(ids[i])) {
					trimRangeEdges(model, axis, i + 1, Math.max(grid.columns.length, next.columns.length), Math.max(grid.rows.length, next.rows.length));
					if (axis === 'rows') model.deleteRows(0, i + 1, 1);
					else model.deleteColumns(0, i + 1, 1);
					ids.splice(i, 1);
				}
				newIds.forEach((id, i) => {
					const from = ids.indexOf(id);
					if (from === -1) {
						if (axis === 'rows') model.insertRows(0, i + 1, 1);
						else model.insertColumns(0, i + 1, 1);
						ids.splice(i, 0, id);
					} else if (from !== i) {
						if (axis === 'rows') model.moveRows(0, from + 1, 1, i - from);
						else model.moveColumns(0, from + 1, 1, i - from);
						ids.splice(i, 0, ids.splice(from, 1)[0]);
					}
				});
			};
			reconcile(grid.rows.map((row) => row.id), next.rows.map((row) => row.id), 'rows');
			reconcile(grid.columns.map((column) => column.id), next.columns.map((column) => column.id), 'columns');
			// Apply edited/new inputs after moving the grid; unchanged formulas retain
			// the references IronCalc just rewrote for the structural change.
			const oldRows = new Map(grid.rows.map((row) => [row.id, row]));
			next.rows.forEach((row, r) => next.columns.forEach((column, c) => {
				const previous = oldRows.get(row.id)?.cells[column.id];
				const cell = row.cells[column.id];
				if (input(previous) !== input(cell)) model.setUserInput(0, r + 1, c + 1, input(cell));
			}));
		}
		const copied = new Set<string>();
		// Snapshot every source before writing any destination; fills can overlap.
		const rowPositions = new Map(grid.rows.map((row, index) => [row.id, index]));
		const columnPositions = new Map(grid.columns.map((column, index) => [column.id, index]));
		const clipCache = new Map<string, Clipboard>();
		const clips = copies.map((copy) => {
			const key = `${copy.source.rowId}:${copy.source.columnId}`;
			const cached = clipCache.get(key);
			if (cached) return { copy, clipboard: cached };
			const r = rowPositions.get(copy.source.rowId) ?? -1;
			const c = columnPositions.get(copy.source.columnId) ?? -1;
			if (r < 0 || c < 0 || !grid.rows[r].cells[copy.source.columnId]?.f) throw new Error('The fill source is no longer a formula.');
			model.setSelectedCell(r + 1, c + 1);
			model.setSelectedRange(r + 1, c + 1, r + 1, c + 1);
			const clipboard = model.copyToClipboard();
			clipCache.set(key, clipboard);
			return { copy, clipboard };
		});
		for (const { copy, clipboard } of clips) {
			const r = rowPositions.get(copy.target.rowId) ?? -1;
			const c = columnPositions.get(copy.target.columnId) ?? -1;
			if (r < 0 || c < 0) continue;
			model.setSelectedCell(r + 1, c + 1);
			model.pasteFromClipboard(0, clipboard.range, clipboard.data, false);
			copied.add(`${copy.target.rowId}:${copy.target.columnId}`);
		}
		const target = next ?? grid;
		model.resumeEvaluation();
		model.evaluate();
		// The WASM API exposes formatted values, not raw numeric results. Coercing
		// numbers to text in a separate sheet avoids rounding by the display formatter.
		const dataName = quoteName(model.getWorksheetsProperties()[0].name);
		model.newSheet();
		model.pauseEvaluation();
		target.rows.forEach((row, r) => target.columns.forEach((column, c) => {
			if (row.cells[column.id]?.f || copied.has(`${row.id}:${column.id}`)) model.setUserInput(1, r + 1, c + 1, `=${dataName}!${columnAddress(c)}${r + 1}&""`);
		}));
		model.resumeEvaluation();
		model.evaluate();
		const results: FormulaResult[] = [];
		target.rows.forEach((row, r) => target.columns.forEach((column, c) => {
			const cell = row.cells[column.id];
			if (!cell?.f && !copied.has(`${row.id}:${column.id}`)) return;
			const f = model.getCellContent(0, r + 1, c + 1);
			const value = model.getFormattedCellValue(1, r + 1, c + 1);
			const type = model.getCellType(0, r + 1, c + 1);
			const array = model.getCellArrayStructure(0, r + 1, c + 1) !== 'SingleCell';
			const error = type === 16 || type === 64 || array;
			results.push({ rowId: row.id, columnId: column.id, cell: {
				f, v: error ? null : type === 1 ? Number(value) : type === 4 ? value === 'TRUE' : value,
				s: error ? 'error' : 'done', e: error ? (type === 64 || array ? 'Array formulas are not supported in cells yet.' : value) : undefined, t: cell?.t ?? Date.now(),
			} });
		}));
		return results;
	} finally {
		model.free();
	}
}

/** Work around IronCalc 0.9.1 invalidating a range when just one endpoint is deleted. */
function trimRangeEdges(model: Model, axis: 'rows' | 'columns', deleted: number, width: number, height: number) {
	const coordinate = axis === 'rows' ? 'row' : 'column';
	for (let r = 1; r <= height; r++) for (let c = 1; c <= width; c++) {
		let formula = model.getCellContent(0, r, c);
		if (!formula.startsWith('=')) continue;
		let changed = false;
		for (const marked of getTokens(formula).reverse()) {
			if (typeof marked.token !== 'object' || !('Range' in marked.token)) continue;
			const range = marked.token.Range;
			if (range.sheet && range.sheet !== model.getWorksheetsProperties()[0].name) continue;
			const left = { ...range.left }, right = { ...range.right };
			const a = left[coordinate], b = right[coordinate];
			if (a === b || (a !== deleted && b !== deleted)) continue;
			if (a === deleted) left[coordinate] += Math.sign(b - a);
			if (b === deleted) right[coordinate] += Math.sign(a - b);
			const address = (ref: typeof left) => `${ref.absolute_column ? '$' : ''}${columnAddress(ref.column - 1)}${ref.absolute_row ? '$' : ''}${ref.row}`;
			const replacement = `${range.sheet ? `${quoteName(range.sheet)}!` : ''}${address(left)}:${address(right)}`;
			// Lexer offsets count Unicode characters; Array.from handles non-ASCII text.
			const chars = Array.from(formula);
			formula = chars.slice(0, marked.start).join('') + replacement + chars.slice(marked.end).join('');
			changed = true;
		}
		if (changed) model.setUserInput(0, r, c, formula);
	}
}
