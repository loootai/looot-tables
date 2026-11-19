import type { CellValue } from './types';

/** Provider placeholders represent a missing answer, never literal cell content. */
export function enrichmentValue(value: CellValue | undefined): CellValue {
	if (value == null) return null;
	if (typeof value === 'string' && /^(?:[-–—]|null)?$/i.test(value.trim())) return null;
	return value;
}
