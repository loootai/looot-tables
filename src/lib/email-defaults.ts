import type { Column, ColumnOp } from './types';
import { roleColumn, type ColumnRole } from './column-roles';

/** A work email column pre-filled from the sheet: person, company, website and profile columns, found by role. */
export function defaultEmailFind(columns: Column[]): Extract<ColumnOp, { kind: 'email-enrichment' }> {
	const ref = (role: ColumnRole) => { const column = roleColumn(columns, role); return column ? `{{${column.name}}}` : ''; };
	return { kind: 'email-enrichment', name: ref('person') || [ref('first-name'), ref('last-name')].filter(Boolean).join(' '), company: ref('company'), domain: ref('website'), profileUrl: ref('profile'), prefer: 'balanced', verify: true };
}
