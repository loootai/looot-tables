import type { Cell, CellValue, Column, Row } from './types';

/* One lookup, many columns. A company (or any looot job) cell keeps the whole answer it came with: the provider's body
   in `companyIntel.data`, looot's own field map in each run's `normalized`. Unpacking reads those stored answers into
   sibling source columns, so it costs $0 and never runs anything again. */

export interface UnpackField { name: string; paths: readonly string[]; format?: Column['format'] }

/** The sibling columns a company answer usually fills. */
export const UNPACK_FIELDS: readonly UnpackField[] = [
	{ name: 'Industry', paths: ['industry', 'industries', 'about.industry', 'category'] },
	{ name: 'Headcount', paths: ['employees', 'employee_count', 'headcount', 'company_size', 'size', 'totalemployees'], format: 'number' },
	{ name: 'HQ', paths: ['hq', 'headquarters.city.name', 'city', 'hq_city', 'location'] },
	{ name: 'Funding', paths: ['funding_total', 'total_funding', 'funding.total', 'funding_total_usd'], format: 'currency' },
	{ name: 'Stage', paths: ['funding_stage', 'stage', 'last_funding_type', 'funding.stage'] },
	{ name: 'Founded', paths: ['founded', 'founded_year', 'year_founded'], format: 'year' },
];

function pick(data: Record<string, unknown>, path: string): unknown {
	let value: unknown = data;
	for (const part of path.split('.')) {
		if (!value || typeof value !== 'object') return undefined;
		value = (value as Record<string, unknown>)[part];
	}
	return value;
}

/** Everything a settled cell stored about its answer, flattened into one record (looot's field map wins). */
export function storedAnswer(cell: Cell | undefined): Record<string, unknown> | null {
	if (!cell || cell.s !== 'done') return null;
	const fromIntel = cell.m?.companyIntel?.data;
	const intel = fromIntel && typeof fromIntel === 'object' ? ((fromIntel as { data?: unknown }).data && typeof (fromIntel as { data?: unknown }).data === 'object' ? (fromIntel as { data: Record<string, unknown> }).data : fromIntel) : {};
	const normalized = Object.assign({}, ...(cell.m?.looot ?? []).filter((call) => call.outcome === 'hit' || call.outcome === 'weak').map((call) => call.normalized ?? {}));
	const merged = { ...intel, ...normalized };
	return Object.keys(merged).length ? merged : null;
}

function valueOf(data: Record<string, unknown>, field: UnpackField): CellValue {
	for (const path of field.paths) {
		const value = pick(data, path);
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
		if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string')) return (value as string[]).slice(0, 10).join(', ');
	}
	if (field.name === 'HQ') {
		const city = pick(data, 'city'), country = pick(data, 'country');
		if (typeof city === 'string' && typeof country === 'string') return `${city}, ${country}`;
	}
	return null;
}

/** The fields this column's stored answers can fill, for the menu: only those at least one row has. */
export function unpackableFields(column: Column, rows: readonly Row[]): UnpackField[] {
	const answers = rows.map((row) => storedAnswer(row.cells[column.id])).filter((data): data is Record<string, unknown> => data !== null);
	return UNPACK_FIELDS.filter((field) => field.name !== column.name && answers.some((data) => valueOf(data, field) !== null));
}

/** New source columns for `fields`, filled from each row's stored answer. Nothing here makes a request. */
export function unpackColumns(column: Column, rows: readonly Row[], fields: readonly UnpackField[], make: (field: UnpackField) => Column, now = Date.now()): { columns: Column[]; cells: Array<{ rowId: string; columnId: string; cell: Cell }> } {
	const columns = fields.map(make);
	const cells: Array<{ rowId: string; columnId: string; cell: Cell }> = [];
	for (const row of rows) {
		const data = storedAnswer(row.cells[column.id]);
		if (!data) continue;
		fields.forEach((field, index) => {
			const value = valueOf(data, field);
			if (value !== null) cells.push({ rowId: row.id, columnId: columns[index].id, cell: { v: value, s: 'done', t: now, m: { reasoning: `Unpacked from ${column.name} at no cost: no new looot run.` } } });
		});
	}
	return { columns, cells };
}
