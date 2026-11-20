import { isDocumentColumn } from './document';
import { admittedCell, type AdmissionColumn } from './cell-admission';
import { isTypedFormat } from './column-format';
import { formatValue } from './template';
import type { Cell, CellValue } from './types';

export function columnAddress(index: number): string {
	let result = '';
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
	return result;
}

export function cellInput(cell: Cell | undefined): string {
	if (cell?.f) return cell.f;
	const value = formatValue(cell?.v);
	return value.startsWith('=') || value.startsWith("'") ? `'${value}` : value;
}

/** Only explicit user edits opt into formulas; imported and enriched text stays literal. A typed column refuses a
    value it cannot hold by throwing the reason. */
export function cellFromInput(input: string, column: AdmissionColumn): Cell {
	const text = input.trim();
	const base = { s: 'done' as const, t: Date.now() };
	const edit = (v: CellValue, as = column) => admittedCell(as, { ...base, v }, 'edit');
	if (!text) return admittedCell(column, { v: null, s: 'idle', t: base.t }, 'edit');
	if (column.format === 'category' && input.startsWith("'")) return edit(input.slice(1));
	if (text.startsWith('=')) return { ...base, f: text, v: null };
	if (column.format === 'category') return edit(input);
	if (text.toLowerCase() === 'null') return { ...base, v: null };
	if (isTypedFormat(column)) return edit(input);
	if (input.startsWith("'")) return { ...base, v: input.slice(1) };
	if (isDocumentColumn(column)) return { ...base, v: input };
	// A check column holds booleans whatever its format.
	if (column.op?.kind === 'check') return edit(input, { format: 'checkbox' });
	const numeric = parseNumericInput(text);
	if ((column.format === 'number' || column.format === 'year') && Number.isFinite(Number(text))) return { ...base, v: Number(text) };
	if (!column.format && numeric !== undefined) return { ...base, v: numeric };
	return { ...base, v: input };
}

/** Preserve leading-zero identifiers and integers that cannot be represented exactly. */
export function parseNumericInput(text: string): number | undefined {
	if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d*)?(?:e[+-]?\d+)?$|^[+-]?\.\d+(?:e[+-]?\d+)?$/i.test(text)) return undefined;
	const number = Number(text);
	return Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number)) ? number : undefined;
}
