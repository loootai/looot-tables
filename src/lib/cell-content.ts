import type { Cell } from './types';

/** JSON with object keys sorted by code unit: server JSONB and schema parsing reorder keys without changing content.
    Saved input fingerprints hash this text, so the order must never change (not localeCompare). */
export function canonicalJson(value: unknown): string | undefined {
	return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
		: item);
}

/** What a person edits: the formula of a formula cell (its result is derived), otherwise the content without its timestamp. */
export const cellContent = (cell?: Cell) => cell?.f ? { f: cell.f } : cell ? { ...cell, t: undefined } : undefined;

/** Edit-conflict token: changes only when the editable content changes, not on key order, timestamps or recalculation. */
export const cellEditToken = (cell?: Cell) => canonicalJson(cellContent(cell) ?? null);
