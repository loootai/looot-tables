import 'server-only';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { z } from 'zod';
import { admittedCell, exportValue } from '../cell-admission';
import { csvToRecords, parseCsv, toCsv } from '../csv';
import { applyFilters, applySort } from '../filters';
import { foundRowKey } from '../found-rows';
import type { Cell, CellValue, Column, Filter, Row } from '../types';
import { MAX_ROWS, WorkspaceError } from '../workspace';
import { isPrivateAddress } from './credentials';
import type { SheetTools } from './sheet-tools';
import type { SHEET_TOOLS } from './tool-specs';

/* Reading rows as values, importing CSV, removing duplicates and exporting: the sheet operations agents need that are
   not single-cell edits. All of them are free. */

const MAX_IMPORT_BYTES = 2_000_000;
const MAX_EXPORT_CHARS = 1_000_000;

const asFilters = (filters: Array<Omit<Filter, 'id'>>): Filter[] => filters.map((filter, index) => ({ ...filter, id: `f${index}` }));

/** A row as an agent reads it: column name → value, plus the state of cells that are not plain values. */
export function rowValues(row: Row, columns: readonly Column[]) {
	const values: Record<string, CellValue> = {};
	const states: Record<string, string> = {};
	for (const column of columns) {
		const cell = row.cells[column.id];
		values[column.name] = cell?.s === 'error' ? null : exportValue(column, cell);
		if (cell?.s === 'error') states[column.name] = `error: ${cell.e ?? 'failed'}`;
		else if (cell?.s === 'running' || cell?.s === 'queued') states[column.name] = cell.s;
		else if (column.type === 'enriched' && (!cell || cell.s === 'idle')) states[column.name] = 'not run';
	}
	return { id: row.id, values, ...(Object.keys(states).length ? { states } : {}) };
}

export async function queryRows(tools: SheetTools, args: z.infer<typeof SHEET_TOOLS.query_rows.schema>) {
	const { sheet, rows } = await tools.readSnapshot(args.sheetId);
	for (const filter of args.filters) if (!sheet.columns.some((column) => column.id === filter.columnId)) throw new WorkspaceError(`No column with id ${filter.columnId}.`, 404);
	const matched = applySort(applyFilters(rows, asFilters(args.filters), args.search, sheet.columns), args.sort);
	const columns = sheet.columns.filter((column) => args.columnIds ? args.columnIds.includes(column.id) : !column.hidden);
	const page = matched.slice(args.offset, args.offset + args.limit);
	return { sheetId: sheet.id, revision: sheet.revision, total: rows.length, matched: matched.length, columns: columns.map(({ id, name, type }) => ({ id, name, type })), rows: page.map((row) => rowValues(row, columns)), nextOffset: args.offset + page.length < matched.length ? args.offset + page.length : null };
}

/** A public https CSV, at most 2 MB. Private and loopback hosts are refused, by name and by address. */
async function fetchCsv(raw: string): Promise<string> {
	const url = new URL(raw);
	if (url.protocol !== 'https:' || url.username || url.password) throw new WorkspaceError('The CSV URL must be a public https address without credentials.', 400);
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
	if (!addresses.length || host === 'localhost' || host.endsWith('.localhost') || addresses.some((entry) => isPrivateAddress(entry.address))) throw new WorkspaceError('The CSV URL must point at a public host.', 400);
	const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { accept: 'text/csv,text/plain,*/*' } }).catch(() => null);
	if (!response?.ok || !response.body) throw new WorkspaceError(`Could not download the CSV${response ? ` (${response.status})` : ''}.`, 400);
	if (Number(response.headers.get('content-length') ?? 0) > MAX_IMPORT_BYTES) throw new WorkspaceError('The CSV is larger than 2 MB.', 413);
	const reader = response.body.getReader(), chunks: Uint8Array[] = [];
	let size = 0;
	for (let part = await reader.read(); !part.done; part = await reader.read()) {
		size += part.value.byteLength;
		if (size > MAX_IMPORT_BYTES) { await reader.cancel(); throw new WorkspaceError('The CSV is larger than 2 MB.', 413); }
		chunks.push(part.value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function importRows(tools: SheetTools, args: z.infer<typeof SHEET_TOOLS.import_rows.schema>) {
	if (!args.csv === !args.url) throw new WorkspaceError('Pass either csv (the text) or url (a public https CSV).', 400);
	const text = args.csv ?? await fetchCsv(args.url!);
	const { headers, records } = csvToRecords(parseCsv(text));
	if (!headers.length || !records.length) throw new WorkspaceError('The CSV has no rows under its header line.', 400);
	const snapshot = await tools.editableSnapshot(args.sheetId, args.revision);
	if (snapshot.rows.length + records.length > MAX_ROWS) throw new WorkspaceError(`This sheet has ${snapshot.rows.length} rows and holds at most ${MAX_ROWS}; the CSV has ${records.length}. Import fewer rows.`, 422);
	const columns = [...snapshot.sheet.columns];
	const target = new Map<string, Column>();
	const created: string[] = [], ignored: string[] = [];
	for (const header of headers) {
		const mapped = args.columnMap?.[header];
		const column = mapped ? columns.find((entry) => entry.id === mapped) : columns.find((entry) => entry.name.trim().toLowerCase() === header.trim().toLowerCase());
		if (mapped && !column) throw new WorkspaceError(`columnMap sends “${header}” to ${mapped}, which is not a column.`, 404);
		if (column) { target.set(header, column); continue; }
		if (!args.createColumns) { ignored.push(header); continue; }
		const added = tools.newColumn(header, columns);
		columns.push(added);
		target.set(header, added);
		created.push(header);
	}
	const now = Date.now();
	let order = Math.max(-1, ...snapshot.rows.map((row) => row.order));
	const rows: Row[] = records.map((record) => ({
		id: tools.newRowId(), sheetId: snapshot.sheet.id, order: ++order, createdAt: now,
		cells: Object.fromEntries([...target].flatMap(([header, column]) => {
			const value = record[header];
			return value === null || value === undefined ? [] : [[column.id, admittedCell(column, { v: value, s: 'done', t: now }, 'import')]];
		})),
	}));
	const saved = await tools.saveGrid(snapshot, { columns, rows });
	const errors = rows.reduce((sum, row) => sum + Object.values(row.cells).filter((cell: Cell) => cell.s === 'error').length, 0);
	return { imported: rows.length, revision: saved.revision, newColumns: created, ignoredHeaders: ignored, cellsThatDoNotFit: errors, rowIds: rows.slice(0, 20).map((row) => row.id) };
}

export async function dedupeRows(tools: SheetTools, args: z.infer<typeof SHEET_TOOLS.dedupe_rows.schema>) {
	const snapshot = await tools.editableSnapshot(args.sheetId, args.revision);
	for (const columnId of args.columnIds) if (!snapshot.sheet.columns.some((column) => column.id === columnId)) throw new WorkspaceError(`No column with id ${columnId}.`, 404);
	const ordered = args.keep === 'first' ? snapshot.rows : [...snapshot.rows].reverse();
	const kept = new Map<string, string>(), duplicates: Array<{ rowId: string; duplicateOf: string }> = [];
	for (const row of ordered) {
		const parts = args.columnIds.map((columnId) => foundRowKey(row.cells[columnId]?.v));
		if (parts.every((part) => !part)) continue;
		const key = JSON.stringify(parts);
		const first = kept.get(key);
		if (first) duplicates.push({ rowId: row.id, duplicateOf: first });
		else kept.set(key, row.id);
	}
	if (args.dryRun || !duplicates.length) return { dryRun: args.dryRun, duplicates: duplicates.length, examples: duplicates.slice(0, 20), next: duplicates.length && args.dryRun ? 'Call again with dryRun false to delete them.' : undefined };
	const saved = await tools.saveGrid(snapshot, { rows: [], deleted: duplicates.map((entry) => entry.rowId) });
	return { dryRun: false, deleted: duplicates.length, revision: saved.revision, examples: duplicates.slice(0, 20) };
}

export async function exportSheet(tools: SheetTools, args: z.infer<typeof SHEET_TOOLS.export_sheet.schema>) {
	const { sheet, rows } = await tools.readSnapshot(args.sheetId);
	const chosen = applyFilters(rows, asFilters(args.filters), '', sheet.columns);
	const visible = sheet.columns.filter((column) => !column.hidden);
	const record = (row: Row) => {
		const { values } = rowValues(row, visible);
		if (!args.includeMeta) return values;
		for (const column of visible.filter((entry) => entry.type === 'enriched')) {
			const meta = row.cells[column.id]?.s === 'done' ? row.cells[column.id]?.m : undefined;
			values[`${column.name} (confidence)`] = meta?.probability ?? meta?.confidence ?? null;
			values[`${column.name} (sources)`] = meta?.sources?.length ? meta.sources : null;
		}
		return values;
	};
	let content = args.format === 'csv' ? toCsv(sheet.columns, chosen, { includeMeta: args.includeMeta }).replace(/^\uFEFF/, '') : JSON.stringify(chosen.map(record), null, 2);
	const truncated = content.length > MAX_EXPORT_CHARS;
	if (truncated) content = content.slice(0, MAX_EXPORT_CHARS);
	return { sheetId: sheet.id, name: sheet.name, format: args.format, rows: chosen.length, truncated, content };
}
