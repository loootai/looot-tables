import { exportValue } from './cell-admission';
import { safeFilename, toCsv } from './csv';
import type { Column, Row, Sheet } from './types';
import { toXlsx } from './xlsx';

export type ExportFormat = 'csv' | 'xlsx' | 'json';

/** What an export covers, said up front: the view (search, filters, selection) or every row; hidden columns never. */
export function exportSummary({ rows, total, selected, hiddenColumns }: { rows: number; total: number; selected: number; hiddenColumns: number }) {
	const scope = selected ? `Exporting ${selected.toLocaleString()} selected ${selected === 1 ? 'row' : 'rows'}`
		: rows === total ? `Exporting all ${total.toLocaleString()} ${total === 1 ? 'row' : 'rows'}`
		: `Exporting ${rows.toLocaleString()} of ${total.toLocaleString()} rows`;
	return hiddenColumns ? `${scope} · ${hiddenColumns} hidden ${hiddenColumns === 1 ? 'column' : 'columns'} excluded` : scope;
}

/** Each enriched column followed by its confidence and sources, as plain columns any writer can handle. */
function withMeta(columns: Column[], rows: Row[]) {
	const visible = columns.filter((column) => !column.hidden);
	const enriched = visible.filter((column) => column.type === 'enriched');
	const confidenceId = (column: Column) => `${column.id}:confidence`, sourcesId = (column: Column) => `${column.id}:sources`;
	return {
		columns: visible.flatMap((column) => column.type === 'enriched' ? [column, { ...column, id: confidenceId(column), name: `${column.name} (confidence)` }, { ...column, id: sourcesId(column), name: `${column.name} (sources)` }] : [column]),
		rows: rows.map((row) => ({ ...row, cells: { ...row.cells, ...Object.fromEntries(enriched.flatMap((column) => {
			const cell = row.cells[column.id];
			const meta = cell?.s === 'error' ? undefined : cell?.m;
			return [
				[confidenceId(column), { v: meta?.probability ?? meta?.confidence ?? null, s: 'done' as const, t: 0 }],
				[sourcesId(column), { v: meta?.sources?.length ? meta.sources : null, s: 'done' as const, t: 0 }],
			];
		})) } })),
	};
}

export function exportFile(sheet: Pick<Sheet, 'name' | 'columns'>, rows: Row[], format: ExportFormat, includeMeta: boolean): { blob: Blob; filename: string } {
	const filename = `${safeFilename(sheet.name)}.${format}`;
	if (format === 'csv') return { filename, blob: new Blob([toCsv(sheet.columns, rows, { includeMeta })], { type: 'text/csv;charset=utf-8' }) };
	const data = includeMeta ? withMeta(sheet.columns, rows) : { columns: sheet.columns.filter((column) => !column.hidden), rows };
	if (format === 'xlsx') return { filename, blob: toXlsx(sheet.name, data.columns, data.rows) };
	const records = data.rows.map((row) => Object.fromEntries(data.columns.map((column) => [column.name, exportValue(column, row.cells[column.id])])));
	return { filename, blob: new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }) };
}
