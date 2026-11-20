import { roleColumns } from './column-roles';
import { logoDomain } from './organization-logo';
import { renderTemplate, rowToRecord } from './template';
import type { Cell, Column, Row } from './types';

function saved(cell: Cell | undefined) {
	return Boolean(cell && cell.s !== 'running' && cell.s !== 'queued' && cell.s !== 'error' && cell.v !== null && cell.v !== undefined && cell.v !== '' && (!Array.isArray(cell.v) || cell.v.length));
}

/** Remove missing fields from saved API profiles, preserving meaningful zero/false values. */
export function populatedDetails(value: unknown): unknown {
	if (value === null || value === undefined || value === '') return undefined;
	if (Array.isArray(value)) {
		const items = value.map(populatedDetails).filter((item) => item !== undefined);
		return items.length ? items : undefined;
	}
	if (typeof value === 'object') {
		const fields = Object.entries(value).map(([key, item]) => [key, populatedDetails(item)] as const).filter(([, item]) => item !== undefined);
		return fields.length ? Object.fromEntries(fields) : undefined;
	}
	return value;
}

/** Local saved data only: this module deliberately has no request/cache-miss lookup path. */
export function companyPreview(row: Row, column: Column, columns: Column[]) {
	const cell = row.cells[column.id];
	const record = rowToRecord(row, columns);
	const explicit = cell?.m?.organization?.name === cell?.v ? logoDomain(cell?.m?.organization?.domain) : null;
	const operationInput = column.op?.kind === 'company' ? renderTemplate(column.op.domain, record).trim() : null;
	const ownSnapshot = cell?.m?.companyIntel;
	const operationDomain = operationInput ? logoDomain(operationInput) ?? (ownSnapshot?.input === operationInput ? logoDomain(ownSnapshot.domain) : null) : null;
	// A shared domain column is ambiguous when a row has more than one company.
	const domainColumn = roleColumns(columns, 'website');
	const domainCell = domainColumn.length === 1 ? row.cells[domainColumn[0].id] : undefined;
	const rowDomain = roleColumns(columns, 'company').length === 1 && saved(domainCell) && typeof domainCell?.v === 'string' ? logoDomain(domainCell.v) : null;
	const domain = explicit ?? operationDomain ?? (typeof cell?.v === 'string' ? logoDomain(cell.v) : null) ?? rowDomain;
	const profiles = new Map<string, { source: string; column: string; time: number; data: unknown }>();
	if (domain) for (const candidate of columns) {
		const result = row.cells[candidate.id];
		if (!result || result.s !== 'done') continue;
		const snapshot = result.m?.companyIntel;
		const currentInput = candidate.op?.kind === 'company' ? renderTemplate(candidate.op.domain, record).trim() : null;
		const currentDomain = currentInput ? logoDomain(currentInput) : null;
		// An edited input must not attach the previous company's profile to the new one.
		if (snapshot?.input && currentInput !== null && snapshot.input !== currentInput) continue;
		if (currentDomain && currentDomain !== domain) continue;
		let source: string, data: unknown;
		if (snapshot && logoDomain(snapshot.domain) === domain) {
			source = snapshot.source === 'brand' ? 'Company profile' : 'Company & funding';
			data = snapshot.data;
		} else if (!snapshot && candidate.op?.kind === 'company' && candidate.op.field.startsWith('funding_') && currentDomain === domain) {
			source = 'Company & funding';
			data = result.m?.raw;
		} else continue;
		data = populatedDetails(data);
		if (!data || typeof data !== 'object') continue;
		if (!profiles.has(source) || profiles.get(source)!.time < result.t) profiles.set(source, { source, column: candidate.name, time: result.t, data });
	}
	const fields = columns.filter((candidate) => candidate.id !== column.id && saved(row.cells[candidate.id])).map((candidate) => ({ column: candidate, cell: row.cells[candidate.id] }));
	return { domain, profiles: [...profiles.values()], fields };
}
