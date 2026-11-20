import { formatValue } from './template';
import type { Column, Filter, FilterOp, Row, Sort } from './types';

export const FILTER_OPS: Array<{ value: FilterOp; label: string; needsValue: boolean }> = [
	{ value: 'contains', label: 'contains', needsValue: true },
	{ value: 'not_contains', label: 'does not contain', needsValue: true },
	{ value: 'equals', label: 'is', needsValue: true },
	{ value: 'not_equals', label: 'is not', needsValue: true },
	{ value: 'true', label: 'is true', needsValue: false },
	{ value: 'false', label: 'is false', needsValue: false },
	{ value: 'gt', label: 'greater than', needsValue: true },
	{ value: 'lt', label: 'less than', needsValue: true },
	{ value: 'empty', label: 'is empty', needsValue: false },
	{ value: 'not_empty', label: 'is not empty', needsValue: false },
	{ value: 'error', label: 'has an error', needsValue: false },
];

export function isActiveFilter(filter: Filter): boolean {
	return FILTER_OPS.find((op) => op.value === filter.op)?.needsValue === false || (filter.value ?? '') !== '';
}

function matches(row: Row, filter: Filter): boolean {
	const cell = row.cells[filter.columnId];
	const value = cell?.v;
	const text = formatValue(value).toLowerCase();
	const needle = (filter.value ?? '').toLowerCase();
	switch (filter.op) {
		case 'contains':
			return text.includes(needle);
		case 'not_contains':
			return !text.includes(needle);
		case 'equals':
			return text === needle;
		case 'not_equals':
			return text !== needle;
		case 'true':
			return value === true || text === 'true';
		case 'false':
			return value === false || text === 'false';
		case 'gt':
			return text.trim() !== '' && Number.isFinite(Number(value)) && Number(value) > Number(filter.value);
		case 'lt':
			return text.trim() !== '' && Number.isFinite(Number(value)) && Number(value) < Number(filter.value);
		case 'empty':
			return text === '' && cell?.s !== 'error';
		case 'not_empty':
			return text !== '';
		case 'error':
			return cell?.s === 'error';
	}
}

export function applyFilters(rows: Row[], filters: Filter[], search: string, columns: Column[]): Row[] {
	const active = filters.filter(isActiveFilter);
	const query = search.trim().toLowerCase();
	const visibleColumns = columns.filter((column) => !column.hidden);
	return rows.filter((row) => {
		if (!active.every((filter) => matches(row, filter))) return false;
		if (!query) return true;
		return visibleColumns.some((column) => formatValue(row.cells[column.id]?.v).toLowerCase().includes(query));
	});
}

/** The one sort policy. A header click (no `dir`) cycles a column ascending, descending, then off; a menu's direction
    sorts by it, and choosing the direction already in effect clears it. */
export function nextSort(current: Sort | null, columnId: string, dir?: Sort['dir']): Sort | null {
	const same = current?.columnId === columnId;
	if (dir) return same && current.dir === dir ? null : { columnId, dir };
	return !same ? { columnId, dir: 'asc' } : current.dir === 'asc' ? { columnId, dir: 'desc' } : null;
}

export function applySort(rows: Row[], sort: Sort | null): Row[] {
	if (!sort) return rows;
	const dir = sort.dir === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const av = a.cells[sort.columnId]?.v;
		const bv = b.cells[sort.columnId]?.v;
		const aEmpty = av === null || av === undefined || av === '';
		const bEmpty = bv === null || bv === undefined || bv === '';
		if (aEmpty && bEmpty) return a.order - b.order;
		if (aEmpty) return 1;
		if (bEmpty) return -1;
		if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
		if (typeof av === 'boolean' && typeof bv === 'boolean') return (Number(av) - Number(bv)) * dir;
		const an = Number(av);
		const bn = Number(bv);
		if (!Number.isNaN(an) && !Number.isNaN(bn) && formatValue(av).trim() !== '' && formatValue(bv).trim() !== '') return (an - bn) * dir;
		return formatValue(av).localeCompare(formatValue(bv), undefined, { numeric: true, sensitivity: 'base' }) * dir;
	});
}
