import { findColumn, nameKey, parsePromptReference, promptReferenceCells, substituteReferences } from './references';
import type { Cell, CellValue, Column, Row } from './types';

export function formatValue(value: CellValue | undefined): string {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.join(', ');
	if (typeof value === 'boolean') return String(value);
	return String(value);
}

/** Replace {{Column}} tokens with the row's values. Unknown columns become empty strings. */
export function renderTemplate(template: string, row: Record<string, CellValue>): string {
	const lookup = new Map<string, CellValue>();
	for (const [name, value] of Object.entries(row)) lookup.set(nameKey(name), value);
	return substituteReferences(template, (name) => formatValue(lookup.get(nameKey(name)))).trim();
}

/** The row as "Column: value" lines, for prompts and Jev state. */
export function describeRow(row: Record<string, CellValue>, only?: string[]): string {
	const entries = Object.entries(row).filter(([name, value]) => (only ? only.some((n) => n.toLowerCase() === name.toLowerCase()) : true) && formatValue(value) !== '');
	return entries.map(([name, value]) => `${name}: ${formatValue(value)}`).join('\n');
}

/** What a run reads from a cell: a source column's value, or an AI column's settled answer. */
export const inputValue = (cell: Cell | undefined, column: Column): CellValue => cell?.s === 'done' || column.type === 'source' ? cell?.v ?? null : null;

/** Row cells keyed by column name (what the server receives). */
export function rowToRecord(row: Row, columns: readonly Column[]): Record<string, CellValue> {
	const record: Record<string, CellValue> = {};
	for (const column of columns) record[column.name] = inputValue(row.cells[column.id], column);
	return record;
}

/** A cell reference's cells as text: tabs separate columns, newlines separate rows, and blank cells keep their place.
    `row`'s own cells are read from `row`, which may be an edited copy. */
export function referenceText(cells: ReadonlyArray<{ row: Row; column: Column }>, row: Row): string {
	let previousRow = '';
	return cells.map(({ row: source, column }, index) => {
		const separator = index === 0 ? '' : source.id === previousRow ? '\t' : '\n';
		previousRow = source.id;
		return separator + formatValue(inputValue((source.id === row.id ? row : source).cells[column.id], column));
	}).join('');
}

/** The row record sent to the server's template renderer, plus the sheet values each cell reference reads. `row`'s own
    cells are read from `row` even where `rows` holds an older copy, so callers can pass an edited row without copying `rows`. */
export function promptRowRecord(row: Row, rows: readonly Row[], columns: readonly Column[], references: readonly string[], rowIndex = rows.findIndex((candidate) => candidate.id === row.id)) {
	const record = rowToRecord(row, columns);
	for (const text of references) {
		if (!findColumn(columns, text) && parsePromptReference(text)) record[text] = referenceText(promptReferenceCells(text, rowIndex, rows, columns), row);
	}
	return record;
}

/** Normalise a domain-ish string: strips protocol, path, and www. */
export function toDomain(value: string): string {
	let text = value.trim().toLowerCase();
	if (!text) return '';
	text = text.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
	text = text.split(/[/?#]/)[0];
	return text.replace(/:\d+$/, '');
}

export function toUrl(value: string): string | null {
	const text = value.trim();
	if (!text) return null;
	if (/^https?:\/\//i.test(text)) return text;
	if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(text)) return `https://${text}`;
	return null;
}

export function coerceOutput(raw: unknown, output: string): CellValue {
	if (raw === null || raw === undefined) return null;
	switch (output) {
		case 'number': {
			if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
			const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
			if (!/\d/.test(cleaned)) return null;
			const n = Number(cleaned);
			return Number.isFinite(n) ? n : null;
		}
		case 'boolean': {
			if (typeof raw === 'boolean') return raw;
			const s = String(raw).trim().toLowerCase();
			if (['true', '1'].includes(s)) return true;
			if (['false', '0'].includes(s)) return false;
			return null;
		}
		case 'list':
			if (Array.isArray(raw)) return raw.map(String);
			return String(raw)
				.split(/[,\n;]/)
				.map((s) => s.trim())
				.filter(Boolean);
		default:
			if (Array.isArray(raw)) return raw.map(String).join(', ');
			if (typeof raw === 'object') return JSON.stringify(raw);
			return String(raw);
	}
}
