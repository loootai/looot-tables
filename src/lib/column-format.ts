import { columnRole, type RoleColumn } from './column-roles';
import type { CellValue, Column } from './types';

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY'] as const;
export const FIELD_FORMATS = [
	['auto', 'Automatic'], ['category', 'Category'], ['document', 'Document'], ['email-draft', 'Email draft'], ['email', 'Email'], ['text', 'Text'], ['number', 'Number'],
	['year', 'Year'], ['currency', 'Currency'], ['percent', 'Percentage'], ['unit', 'Number with unit'],
	['checkbox', 'Checkbox'], ['website', 'Website'], ['webpage', 'Webpage'], ['url', 'URL'], ['date', 'Date'], ['list', 'List'],
] as const;

type FormatColumn = Pick<Column, 'format' | 'currency' | 'unit' | 'useGrouping' | 'decimalPlaces' | 'categoryOptions'> & Partial<Pick<Column, 'name'>>;
/** Saved boolean formats use the same checkbox UI. */
export function isCheckboxColumn(column: Pick<Column, 'format'>) {
	return column.format === 'checkbox' || column.format === 'boolean';
}

export function isTypedFormat(column: FormatColumn) {
	return ['category', 'currency', 'percent', 'unit', 'checkbox', 'boolean', 'website', 'webpage'].includes(column.format ?? '');
}

/** Parse display decorations without storing them in numeric/boolean values. */
export function typedColumnValue(value: CellValue, column: FormatColumn): CellValue {
	if (!isTypedFormat(column)) return value;
	if (value === null || typeof value === 'string' && !value.trim()) return column.format === 'category' ? column.categoryOptions?.[0] ?? null : null;
	if (column.format === 'category') {
		if (typeof value === 'string' && column.categoryOptions?.includes(value.trim())) return value.trim();
		throw new Error('Choose one of the configured categories.');
	}
	if (column.format === 'website' || column.format === 'webpage') {
		const url = typeof value === 'string' ? webColumnUrl(value) : null;
		if (!url) throw new Error('Enter a valid website or http(s) URL.');
		return column.format === 'website' ? url.hostname.replace(/^www\./, '') : /^https?:\/\//i.test(String(value).trim()) ? String(value).trim() : url.href;
	}
	if (isCheckboxColumn(column)) {
		if (typeof value === 'boolean') return value;
		if (value === 1 || typeof value === 'string' && /^(true|1)$/i.test(value.trim())) return true;
		if (value === 0 || typeof value === 'string' && /^(false|0)$/i.test(value.trim())) return false;
		throw new Error('Checkbox fields accept true or false.');
	}
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value !== 'string') throw new Error('This field requires a number.');
	let text = value.trim();
	let percent = false;
	if (column.format === 'currency') text = text.replace(/^(?:USD|EUR|GBP|CAD|AUD|INR|JPY)\s*/i, '').replace(/^[$€£₹¥]\s*/, '').replace(/\s*(?:USD|EUR|GBP|CAD|AUD|INR|JPY)$/i, '');
	if (column.format === 'unit' && column.unit && text.endsWith(column.unit)) text = text.slice(0, -column.unit.length).trim();
	if (column.format === 'percent' && text.endsWith('%')) { percent = true; text = text.slice(0, -1).trim(); }
	// Accept ordinary comma grouping, but reject malformed input such as 1,2.
	if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) text = text.replaceAll(',', '');
	if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) throw new Error('This field requires a number.');
	return Number(text) / (percent ? 100 : 1);
}

/** Recognize year fields in existing sheets without changing their stored values. */
export function isYearColumn(column: Pick<FormatColumn, 'name' | 'format'>): boolean {
	return column.format === 'year' || ((!column.format || column.format === 'number') && /^(?:(?:company[ _-]+)?(?:founded|established|incorporated)(?:[ _-]+year)?|year(?:[ _-]+(?:founded|established|incorporated))?)$/i.test(column.name?.trim() ?? ''));
}

// Constructing Intl formatters is costly and cells format on every render; options repeat per column, so reuse them.
const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(options: Intl.NumberFormatOptions) {
	const key = JSON.stringify(options);
	let format = numberFormats.get(key);
	if (!format) numberFormats.set(key, format = new Intl.NumberFormat('en-US', options));
	return format;
}

export function formatColumnNumber(value: number, column: FormatColumn): string {
	const year = isYearColumn(column);
	const options: Intl.NumberFormatOptions = { useGrouping: column.format === 'year' ? false : column.useGrouping ?? !year };
	if (column.format === 'currency') { options.style = 'currency'; options.currency = column.currency ?? 'USD'; }
	else if (column.format === 'percent') { options.style = 'percent'; options.maximumFractionDigits = 2; }
	else options.maximumFractionDigits = year ? 0 : 2;
	const decimals = column.format === 'year' ? 0 : column.decimalPlaces;
	if (decimals !== undefined) options.minimumFractionDigits = options.maximumFractionDigits = decimals;
	const number = numberFormat(options).format(value);
	return column.format === 'unit' && column.unit ? `${number} ${column.unit}` : number;
}

export function webColumnKind(column: RoleColumn): 'website' | 'webpage' | null {
	const role = columnRole(column);
	return role === 'website' || role === 'webpage' ? role : null;
}

export function webColumnUrl(value: string): URL | null {
	try {
		const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
		return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.hostname.includes('.') ? url : null;
	} catch { return null; }
}
