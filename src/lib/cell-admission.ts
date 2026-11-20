import { isTypedFormat, typedColumnValue } from './column-format';
import { enrichmentValue } from './enrichment-value';
import type { Cell, CellValue, Column, ColumnFormat, Row } from './types';

/* How a value from any source becomes a stored cell for a column. A typed format (category, currency, percent, unit,
   checkbox, website, webpage) is a promise about every settled cell in the column: a done or idle cell holds a value
   of that type. Each source keeps the promise its own way when a value does not fit:

   - edit:       the user typed it, so the edit is refused with a message.
   - agent:      an MCP write is refused with a message naming the value; the caller reports it per cell.
   - import:     the user's data is kept: the cell holds the text as an error, to fix or to fit a different format.
   - find-rows:  a found value that does not fit is dropped; the row is still added.
   - enrichment: the result becomes a failed cell explaining why. The run is finished, so nothing pauses or reruns.
   - formula:    the result becomes a formula error, keeping the formula.

   Pending and failed cells hold no value of their own and are stored as given; a formula is admitted when it
   calculates (source 'formula'). Admitting an admitted cell returns it unchanged. */

export type CellSource = 'edit' | 'import' | 'find-rows' | 'enrichment' | 'formula' | 'agent';
export type AdmissionColumn = Pick<Column, 'format' | 'currency' | 'unit' | 'categoryOptions'> & Partial<Pick<Column, 'id' | 'name' | 'type' | 'op'>>;
export type Admission = { ok: true; cell: Cell } | { ok: false; error: string };

const NOUNS: Partial<Record<ColumnFormat, string>> = {
	category: 'one of the column’s categories', currency: 'an amount', percent: 'a percentage', unit: 'a number',
	checkbox: 'true or false', boolean: 'true or false', website: 'a website', webpage: 'a web page address',
};

const exempt = (cell: Cell, source: CellSource) => cell.s === 'running' || cell.s === 'queued' || cell.s === 'error' || (cell.f !== undefined && source !== 'formula');
// Provider placeholders mean "no answer". Templates and email drafts produce literal text.
const reportsAnswers = (column: AdmissionColumn) => Boolean(column.op && column.op.kind !== 'template' && column.op.kind !== 'email-draft');

function parse(column: AdmissionColumn, value: CellValue): { value: CellValue } | { reason: string } {
	try { return { value: typedColumnValue(value, column) }; }
	catch (error) { return { reason: error instanceof Error ? error.message : 'Invalid value.' }; }
}

function quoted(value: CellValue) {
	const text = Array.isArray(value) ? value.join(', ') : String(value);
	return `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;
}

export function admitCell(column: AdmissionColumn, cell: Cell, source: CellSource): Admission {
	if (exempt(cell, source)) return { ok: true, cell };
	const raw = source === 'enrichment' && reportsAnswers(column) ? enrichmentValue(cell.v) : cell.v;
	const parsed = parse(column, raw);
	if ('value' in parsed) return { ok: true, cell: parsed.value === cell.v ? cell : { ...cell, v: parsed.value, ...(column.format === 'category' ? { s: 'done' as const } : {}) } };
	const what = `${quoted(raw)} is not ${NOUNS[column.format!] ?? 'a valid value'}`;
	switch (source) {
		case 'edit': return { ok: false, error: parsed.reason };
		case 'agent': return { ok: false, error: `${what}.${column.format === 'category' ? ` Use one of: ${column.categoryOptions?.join(', ')}.` : ''}` };
		case 'import': return { ok: true, cell: { v: raw, s: 'error', e: `${what}. Edit it, or change the column’s format.`, t: cell.t } };
		case 'find-rows': return admitCell(column, { v: null, s: 'idle', t: cell.t }, source);
		case 'enrichment': return { ok: true, cell: { v: null, s: 'error', e: `The answer ${what}, which this column’s format requires. Change the format or the instructions, then run it again.`, ...(cell.m ? { m: cell.m } : {}), t: cell.t } };
		case 'formula': return { ok: true, cell: { ...cell, v: null, s: 'error', e: `The result ${what}.` } };
	}
}

/** admitCell for callers that surface a refusal as an error. Sources other than edit and agent never throw. */
export function admittedCell(column: AdmissionColumn, cell: Cell, source: CellSource): Cell {
	const admission = admitCell(column, cell, source);
	if (!admission.ok) throw new Error(admission.error);
	return admission.cell;
}

/** A format guessed from a header gives way to the data: when an imported value does not fit, the column is text. */
export function fitGuessedFormat<T extends AdmissionColumn>(column: T, values: Iterable<CellValue | undefined>): T {
	if (!isTypedFormat(column)) return column;
	for (const value of values) if (value !== undefined && 'reason' in parse(column, value)) return { ...column, format: 'text' };
	return column;
}

/* ───────────────────── Admitting a whole grid change ───────────────────── */

type Grid = { columns: readonly Column[]; rows: readonly Row[] };
const formatRules = (column: Column) => JSON.stringify([column.format, column.categoryOptions, column.unit]);

/** Typed columns that are new or whose format rules changed: every one of their cells must be checked again. */
export function redefinedColumns(before: readonly Column[], after: readonly Column[]): Set<string> {
	const previous = new Map(before.map((column) => [column.id, column]));
	return new Set(after.filter((column) => isTypedFormat(column) && (!previous.has(column.id) || formatRules(previous.get(column.id)!) !== formatRules(column))).map((column) => column.id));
}

// Admission reads only a cell's value, status and formula; metadata and timestamps alone do not make it a new write.
const sameValue = (a: Cell, b: Cell | undefined) => b !== undefined && a.s === b.s && a.f === b.f && (a.v === b.v || Array.isArray(a.v) && JSON.stringify(a.v) === JSON.stringify(b.v));

/** An imported value kept as text in an error cell (see 'import'): a format change gives it another chance. */
const flaggedImport = (column: Column, cell: Cell) => column.type === 'source' && cell.s === 'error' && cell.v !== null && cell.f === undefined;

/** What exports write for a cell: failed enrichments are blank, but flagged imported text is the user's data and is kept. */
export const exportValue = (column: Column, cell: Cell | undefined): CellValue => !cell ? null : cell.s !== 'error' || flaggedImport(column, cell) ? cell.v ?? null : null;

/** Each typed cell a change wrote, and every cell of a redefined column (a missing category cell counts as empty). */
function* touchedCells(before: Grid, after: Grid) {
	const redefined = redefinedColumns(before.columns, after.columns);
	const previous = new Map(before.rows.map((row) => [row.id, row]));
	const typed = after.columns.filter(isTypedFormat);
	for (const row of after.rows) {
		const old = previous.get(row.id);
		for (const column of typed) {
			const recheck = redefined.has(column.id);
			const cell = row.cells[column.id] ?? (column.format === 'category' && (recheck || !old) ? { v: null, s: 'idle' as const, t: Date.now() } : undefined);
			if (cell && (recheck || !sameValue(cell, old?.cells[column.id]))) yield { row, column, cell, recheck };
		}
	}
}

/** Admit what a change wrote, in place: changed cells under `source`, and every cell of a redefined column. A value a
    new format cannot hold refuses the whole change, since rewriting existing values would lose them. */
export function admitChange(before: Grid, after: { columns: readonly Column[]; rows: Row[] }, source: CellSource) {
	for (const { row, column, cell, recheck } of touchedCells(before, after)) {
		const admission = !recheck ? admitCell(column, cell, source)
			: flaggedImport(column, cell) ? admitCell(column, { v: cell.v, s: 'done', t: cell.t }, 'import')
			: admitCell(column, cell, 'edit');
		if (!admission.ok) throw new Error(`“${column.name}”: ${admission.error}${recheck ? ' Existing values were kept.' : ''}`);
		if (admission.cell !== row.cells[column.id]) row.cells[column.id] = recheck ? { ...admission.cell, t: Math.max(Date.now(), cell.t + 1) } : admission.cell;
	}
}

/** Where a grid about to be stored breaks a typed column's format, as a message; null when it does not. Checks the
    cells that differ from `before`, and every cell of a redefined column. Values need to fit, not to be normalized. */
export function invalidCell(before: Grid, after: Grid): string | null {
	for (const { row, column, cell } of touchedCells(before, after)) {
		if (exempt(cell, 'edit')) continue;
		const parsed = parse(column, cell.v);
		if ('reason' in parsed) return `Row “${row.id}”, column “${column.name}”: ${quoted(cell.v)} does not fit the column’s format. ${parsed.reason}`;
	}
	return null;
}
