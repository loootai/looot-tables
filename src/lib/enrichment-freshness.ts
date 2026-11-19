import { canonicalJson } from './cell-content';
import { findColumn, opDependencies, parsePromptReference, promptReferenceCells, readsRowContext, rewriteOp, sameName, type CellReference } from './references';
import { formatValue, inputValue, promptRowRecord, referenceText } from './template';
import type { Cell, CellValue, Column, ColumnOp, Row, Sheet } from './types';

/* What a run reads, and whether a saved result still answers it. A run's inputs are defined once (`runInputs`): its
   fingerprint and the cells it waits on both come from them. */

const BLANK = { v: null, s: 'idle', t: 0 } as const;
const FINGERPRINT = 'v2:';
const positions = new WeakMap<readonly Row[], Map<string, number>>();

/** A row's position in `rows`, in constant time after the first lookup on each array. */
export function rowIndex(rows: readonly Row[], rowId: string): number {
	let index = positions.get(rows), position = index?.get(rowId);
	// The array may have changed since it was indexed.
	if (!index || (position === undefined ? index.size !== rows.length : rows[position]?.id !== rowId)) {
		positions.set(rows, index = new Map(rows.map((row, i) => [row.id, i])));
		position = index.get(rowId);
	}
	return position ?? -1;
}

const blankRow = (row: Row, blank?: string): Row => blank === undefined ? row : { ...row, cells: { ...row.cells, [blank]: BLANK } };

/** The record an operation receives for `rows[index]`: every column by name, and each cell reference's text. `blank` is
    the column the run writes: its own previous value is never sent. */
export function inputRecord(columns: readonly Column[], rows: readonly Row[], index: number, op: ColumnOp, blank?: string): Record<string, CellValue> {
	return promptRowRecord(blankRow(rows[index], blank), rows, columns, opDependencies(op), index);
}

/* ───────────── Inputs ───────────── */

/** Cells a run reads under one key. `text`: a cell reference, read as its cells' text like the record. */
interface Input { key: string; cells: Array<{ row: Row; column: Column }>; text: boolean }

/** A reference as what it reads rather than how it is written: a column's ID, or a cell range by its columns' IDs, so
    renaming or moving a column changes neither. */
function referenceKey(text: string, columns: readonly Column[]): string {
	const named = findColumn(columns, text);
	if (named) return named.id;
	const reference = parsePromptReference(text);
	if (!reference) return text;
	const end = ({ column, row, fixedColumn, fixedRow }: CellReference['start']) => `${fixedColumn ? '$' : ''}[${columns[column]?.id ?? column}]${fixedRow ? '$' : ''}${row + 1}`;
	return `${end(reference.start)}:${end(reference.end)}`;
}

/** The operation with each reference written as what it reads: a rename or move leaves it unchanged, an edit does not. */
export const ruleOf = (op: ColumnOp, columns: readonly Column[]): ColumnOp => rewriteOp(op, (text) => referenceKey(text, columns));

function referenceInputs(columns: readonly Column[], rows: readonly Row[], index: number, op: ColumnOp): Input[] {
	return opDependencies(op).map((text) => ({ key: referenceKey(text, columns), cells: promptReferenceCells(text, index, rows, columns), text: !findColumn(columns, text) }));
}

/** What a run of `op` for `rows[index]` reads: each reference's cells, and for an operation that reads its row, every
    source cell of the row that holds no formula. An AI answer or a formula result is an input only when referenced: a
    whole-row run still receives it, but it neither outdates the result nor holds it back, so AI columns reading their
    row never outdate each other, nor through a formula that reads one of them. */
function runInputs(columns: readonly Column[], rows: readonly Row[], index: number, op: ColumnOp): Input[] {
	const inputs = referenceInputs(columns, rows, index, op);
	if (!readsRowContext(op)) return inputs;
	const keys = new Set(inputs.map((input) => input.key)), row = rows[index];
	for (const column of columns) if (column.type === 'source' && !keys.has(column.id) && !row.cells[column.id]?.f) inputs.push({ key: column.id, cells: [{ row, column }], text: false });
	return inputs;
}

/** The AI cells a run waits on, in reference order: its inputs that other AI columns compute. Only references reach
    them; a whole-row run's other inputs are source cells. */
export function dependencyCells(columns: readonly Column[], rows: readonly Row[], index: number, op: ColumnOp): Array<{ row: Row; column: Column }> {
	return referenceInputs(columns, rows, index, op).flatMap((input) => input.cells).filter((cell) => cell.column.type === 'enriched');
}

/** Everything a run reads, keyed by what it reads rather than by name: the operation, and each input's value. Empty
    inputs are left out, as the model never sees them. `blank` as for `inputRecord`. Saved results carry its
    fingerprint, so its shape and key order must never change. */
export function inputVersion(columns: readonly Column[], rows: readonly Row[], index: number, op: ColumnOp, blank?: string): string {
	const row = blankRow(rows[index], blank);
	const inputs: Record<string, CellValue> = {};
	for (const { key, cells, text } of runInputs(columns, rows, index, op)) {
		const value = text ? referenceText(cells, row) : inputValue(row.cells[cells[0].column.id], cells[0].column);
		if (formatValue(value) !== '') inputs[key] = value;
	}
	return canonicalJson({ op: ruleOf(op, columns), inputs })!;
}

// Compact change detection only; this fingerprint is not an authentication primitive.
function digest(version: string): string {
	let first = 0xdeadbeef, second = 0x41c6ce57;
	for (let i = 0; i < version.length; i++) {
		const code = version.charCodeAt(i);
		first = Math.imul(first ^ code, 2654435761);
		second = Math.imul(second ^ code, 1597334677);
	}
	first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
	second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
	return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

/** The fingerprint a result is saved with. Fingerprints saved before inputs were keyed by column ID start `v1:`. */
export const inputFingerprint = (version: string) => `${FINGERPRINT}${digest(version)}`;
export const isLegacyFingerprint = (fingerprint: string | undefined) => Boolean(fingerprint?.startsWith('v1:'));

/** What `v1:` fingerprints hash: the operation as written, and the record's referenced entries by column name (all of
    them when the operation reads its row). Never change it. */
function legacyVersion(op: ColumnOp, record: Record<string, CellValue>, wholeRow = false): string {
	const references = opDependencies(op);
	const usesRowContext = wholeRow || readsRowContext(op);
	const entries = Object.entries(record).filter(([name]) => usesRowContext || references.some((ref) => sameName(ref, name)));
	return canonicalJson({ op, record: Object.fromEntries(entries) })!;
}

/** Whether a `v1:` fingerprint still matches the row's `record`. A whole-row one covered every column, so columns added
    after `savedAt` are also left out unless they hold a new input (a source value), and AI answers it does not reference
    that `row` settled after `savedAt` are tried as the blanks they were; results saved before an operation stopped
    reading its row carry a whole-row one. */
function legacyCurrent(fingerprint: string, savedAt: number, op: ColumnOp, columns: readonly Column[], record: Record<string, CellValue>, row: Row): boolean {
	const references = opDependencies(op);
	const added = new Set(columns.filter((column) => column.createdAt > savedAt && (column.type === 'enriched' || formatValue(record[column.name]) === '')).map((column) => column.name));
	const later = columns.filter((column) => column.type === 'enriched' && column.name in record && record[column.name] !== null && row.cells[column.id]?.t > savedAt && !references.some((ref) => sameName(ref, column.name)));
	const records = added.size ? [record, Object.fromEntries(Object.entries(record).filter(([name]) => !added.has(name)))] : [record];
	if (later.length) records.push(...records.map((entry) => ({ ...entry, ...Object.fromEntries(later.filter((column) => column.name in entry).map((column) => [column.name, null])) })));
	const versions = (entry: Record<string, CellValue>) => readsRowContext(op) ? [legacyVersion(op, entry)] : [legacyVersion(op, entry), legacyVersion(op, entry, true)];
	return records.some((entry) => versions(entry).some((version) => fingerprint === `v1:${digest(version)}`));
}

/** Whether a done result answers another rule or other inputs than `rows[index]` gives now. `current` holds the run's
    version and record when the caller has them. */
export function outdatedResult(cell: Cell | undefined, columns: readonly Column[], rows: readonly Row[], index: number, op: ColumnOp, columnId: string, current?: { readonly version: string; readonly record: Record<string, CellValue> }): boolean {
	if (cell?.s !== 'done' || cell.f) return false;
	const fingerprint = cell.m?.inputFingerprint;
	if (fingerprint?.startsWith(FINGERPRINT)) return fingerprint !== inputFingerprint(current?.version ?? inputVersion(columns, rows, index, op, columnId));
	if (fingerprint) return !legacyCurrent(fingerprint, cell.t, op, columns, current?.record ?? inputRecord(columns, rows, index, op, columnId), rows[index]);
	return referenceInputs(columns, rows, index, op).some((input) => input.cells.some((dep) => dep.row.cells[dep.column.id]?.t > cell.t));
}

/** Whether a cell holds an outdated result. Rows must be in sheet order. */
export function enrichmentIsOutdated(sheet: Sheet, orderedRows: readonly Row[], row: Row, columnId: string): boolean {
	const column = sheet.columns.find((entry) => entry.id === columnId);
	if (column?.type !== 'enriched' || !column.op) return false;
	const index = rowIndex(orderedRows, row.id);
	return index >= 0 && outdatedResult(row.cells[columnId], sheet.columns, orderedRows, index, column.op, columnId);
}

/** The grid's name for `enrichmentIsOutdated`. */
export const enrichmentIsStale = enrichmentIsOutdated;
