import { instructionText, operation } from './operations';
import type { Column, ColumnOp, PageSource, Row } from './types';

/* The `{{…}}` reference grammar. A reference names a column ({{Company}}) or an A1-style cell or range ({{B1}},
   {{$A$1:B3}}). Cell references are filled down from sheet row 1: their row moves with each row unless locked with $,
   and their column is a position in the sheet, rewritten whenever columns are inserted, moved or deleted. */

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** What a cell reference becomes once every column it pointed at is deleted. */
export const BROKEN_REFERENCE = '#REF!';

/* ───────────── Names: trimmed and case-insensitive everywhere, so a reference matches exactly one column ───────────── */

export const nameKey = (name: string) => name.trim().toLowerCase();
export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);
export const findColumn = <C extends { name: string }>(columns: readonly C[], name: string) => columns.find((column) => sameName(column.name, name));
export const nameTaken = (name: string, columns: readonly Pick<Column, 'id' | 'name'>[], exceptId?: string) => columns.some((column) => column.id !== exceptId && sameName(column.name, name));

/** "Name", then "Name 2", "Name 3"… */
export function uniqueName(name: string, taken: readonly string[]): string {
	const base = name.trim();
	const keys = new Set(taken.map(nameKey));
	if (!keys.has(nameKey(base))) return base;
	let index = 2;
	while (keys.has(nameKey(`${base} ${index}`))) index += 1;
	return `${base} ${index}`;
}

/* ───────────── Text ───────────── */

/** Every token with its position, for editors. */
export function referenceTokens(text: string): Array<{ name: string; from: number; to: number }> {
	return [...text.matchAll(TOKEN)].map((match) => ({ name: match[1].trim(), from: match.index, to: match.index + match[0].length }));
}

export function textReferences(text: string): string[] {
	return [...new Set(referenceTokens(text).map((token) => token.name))];
}

/** Replace every token with plain text. */
export function substituteReferences(text: string, value: (name: string) => string): string {
	return text.replace(TOKEN, (_token, name: string) => value(name.trim()));
}

/** Replace the tokens `next` renames; null keeps a token as written. */
function rewriteText(text: string, next: (name: string) => string | null): string {
	return text.replace(TOKEN, (token, name: string) => {
		const renamed = next(name.trim());
		return renamed === null ? token : `{{${renamed}}}`;
	});
}

/* ───────────── Cell references ───────────── */

interface Endpoint { column: number; row: number; fixedColumn: boolean; fixedRow: boolean }
export interface CellReference { start: Endpoint; end: Endpoint }

export function parsePromptReference(text: string): CellReference | null {
	const parts = text.trim().split(':');
	if (parts.length > 2) return null;
	const endpoints = parts.map((part): Endpoint | null => {
		const match = /^(\$?)([a-z]{1,3})(\$?)([1-9]\d*)$/i.exec(part);
		if (!match) return null;
		let column = 0;
		for (const letter of match[2].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
		const row = Number(match[4]);
		return column <= 16384 && row <= 1048576 ? { column: column - 1, row: row - 1, fixedColumn: match[1] === '$', fixedRow: match[3] === '$' } : null;
	});
	return endpoints[0] && endpoints.every(Boolean) ? { start: endpoints[0], end: endpoints[1] ?? endpoints[0] } : null;
}

function columnLetters(index: number): string {
	let letters = '';
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
	return letters;
}

/** The cells a reference reads for the row at `rowIndex`. Rows must be in stable sheet order, independent of sorting and filtering. */
export function promptReferenceCells(text: string, rowIndex: number, rows: readonly Row[], columns: readonly Column[]): Array<{ row: Row; column: Column }> {
	const named = findColumn(columns, text);
	if (named) return rows[rowIndex] ? [{ row: rows[rowIndex], column: named }] : [];
	const reference = parsePromptReference(text);
	if (!reference) return [];
	const { start, end } = reference;
	const firstRow = start.row + (start.fixedRow ? 0 : rowIndex);
	const lastRow = end.row + (end.fixedRow ? 0 : rowIndex);
	const cells: Array<{ row: Row; column: Column }> = [];
	for (let r = Math.max(0, Math.min(firstRow, lastRow)); r <= Math.min(rows.length - 1, Math.max(firstRow, lastRow)); r++) {
		for (let c = Math.min(start.column, end.column); c <= Math.min(columns.length - 1, Math.max(start.column, end.column)); c++) {
			cells.push({ row: rows[r], column: columns[c] });
		}
	}
	return cells;
}

/** Cell references may read other rows; named references read only their own. */
export const readsOtherRows = (references: readonly string[], columns: readonly Column[]) => references.some((text) => !findColumn(columns, text) && parsePromptReference(text) !== null);

/* ───────────── Operations ───────────── */

const isPage = (value: unknown): value is PageSource => typeof value === 'object' && value !== null && 'type' in value;

/** Each reference field's value, rewritten. Returns `op` itself when nothing changed. */
export function rewriteOp(op: ColumnOp, next: (name: string) => string | null): ColumnOp {
	const fields = op as unknown as Record<string, unknown>;
	let changed: Record<string, unknown> | undefined;
	for (const field of operation(op.kind).references) {
		const value = fields[field];
		const rewritten = typeof value === 'string' ? rewriteText(value, next) : !isPage(value) ? value
			: value.type === 'template' ? { ...value, template: rewriteText(value.template, next) } : { ...value, column: next(value.column.trim()) ?? value.column };
		if (JSON.stringify(rewritten) !== JSON.stringify(value)) (changed ??= { ...fields })[field] = rewritten;
	}
	return (changed ?? op) as ColumnOp;
}

/** Every reference an operation reads, in field order, so runs can wait for their inputs. */
export function opDependencies(op: ColumnOp): string[] {
	const fields = op as unknown as Record<string, unknown>;
	const names = new Set<string>();
	for (const field of operation(op.kind).references) {
		const value = fields[field];
		const found = typeof value === 'string' ? textReferences(value) : !isPage(value) ? [] : value.type === 'template' ? textReferences(value.template) : [value.column.trim()];
		for (const name of found) if (name) names.add(name);
	}
	return [...names];
}

/** Rewrite references to a renamed column, leaving question text and extraction labels intact. */
export function renameOpReferences(op: ColumnOp, oldName: string, newName: string): ColumnOp {
	return rewriteOp(op, (name) => sameName(name, oldName) ? newName : null);
}

/** Rewrite cell references after columns are inserted, moved or deleted, as spreadsheets rewrite formulas: each edge
    follows its column, a deleted range edge shrinks inward, and a reference left without columns becomes {{#REF!}}.
    Operations being inserted are read as written against `before` too. */
export function shiftReferences(op: ColumnOp, before: readonly Column[], after: readonly Column[]): ColumnOp {
	const positions = new Map(after.map((column, index) => [column.id, index]));
	// Positions past the last column behave like columns after it.
	const position = (index: number) => index < before.length ? positions.get(before[index].id) ?? -1 : index + after.length - before.length;
	return rewriteOp(op, (text) => {
		const reference = findColumn(before, text) ? null : parsePromptReference(text);
		if (!reference) return null;
		const { start, end } = reference;
		const survivor = (from: number, to: number) => {
			for (let index = from; ; index += Math.sign(to - from)) {
				const moved = position(index);
				if (moved >= 0 || index === to) return moved;
			}
		};
		const first = survivor(start.column, end.column), last = survivor(end.column, start.column);
		if (first < 0 || last < 0) return BROKEN_REFERENCE;
		if (first === start.column && last === end.column) return null;
		const address = (endpoint: Endpoint, column: number) => `${endpoint.fixedColumn ? '$' : ''}${columnLetters(column)}${endpoint.fixedRow ? '$' : ''}${endpoint.row + 1}`;
		return text.includes(':') ? `${address(start, first)}:${address(end, last)}` : address(start, first);
	});
}

/** `after`, with every operation's cell references rewritten for the new column layout. */
export function shiftColumnReferences(before: readonly Column[], after: Column[]): Column[] {
	if (before.length === after.length && before.every((column, index) => column.id === after[index].id)) return after;
	return after.map((column) => {
		const op = column.op && shiftReferences(column.op, before, after);
		return op === column.op ? column : { ...column, op };
	});
}

/** References that resolve to no column: a deleted or misspelled name, {{#REF!}}, or cells past the last column.
    A range reaching past the last column still reads the columns it covers. */
export function danglingReferences(op: ColumnOp, columns: readonly Column[]): string[] {
	return opDependencies(op).filter((text) => {
		if (findColumn(columns, text)) return false;
		const reference = parsePromptReference(text);
		return !reference || Math.min(reference.start.column, reference.end.column) >= columns.length;
	});
}

/** Other columns whose operations read `columnId`, by name or through a cell reference. */
export function referenceDependents(columns: readonly Column[], columnId: string): Column[] {
	const index = columns.findIndex((column) => column.id === columnId);
	if (index < 0) return [];
	return columns.filter((column) => column.id !== columnId && column.op && opDependencies(column.op).some((text) => {
		const named = findColumn(columns, text);
		if (named) return named.id === columnId;
		const reference = parsePromptReference(text);
		return reference !== null && Math.min(reference.start.column, reference.end.column) <= index && index <= Math.max(reference.start.column, reference.end.column);
	}));
}

/** Whether a run reads the whole row, not just its references. */
export function readsRowContext(op: ColumnOp): boolean {
	const context = operation(op.kind).rowContext(op);
	return context === 'row' || context === 'row-unless-referenced' && !textReferences(instructionText(op)).length;
}
