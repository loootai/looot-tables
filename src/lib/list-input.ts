/** One editable row of a list field. Rows keep their raw text; only saved values are trimmed. */
export interface ListRow { id: string; label: string; detail: string }
export interface ListItem { label: string; detail?: string }

export function toListRows(items: readonly ListItem[], makeId: () => string): ListRow[] {
	return items.map((item) => ({ id: makeId(), label: item.label, detail: item.detail ?? '' }));
}

/** Values to save: trimmed, with blank rows dropped. Never fed back into the inputs, so nothing typed is lost. */
export function fromListRows(rows: readonly ListRow[]): ListItem[] {
	return rows.map((row) => ({ label: row.label.trim(), detail: row.detail.trim() || undefined })).filter((item) => item.label);
}

/** A multi-line paste becomes one row per line ("Label: detail" when `withDetail`); a single line pastes normally. */
export function parseListLines(text: string, withDetail: boolean): ListItem[] | null {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length < 2) return null;
	return lines.map((line) => {
		const colon = withDetail ? line.indexOf(':') : -1;
		return colon < 0 ? { label: line } : { label: line.slice(0, colon).trim(), detail: line.slice(colon + 1).trim() || undefined };
	});
}

/** "linkedin.com, crunchbase.com" → unique, trimmed entries. */
export function parseCommaList(text: string): string[] {
	return [...new Set(text.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean))];
}

/** Commit a number field: blank or invalid input falls back; everything else is clamped (and rounded for integers). */
export function clampNumber(raw: string, { min, max, fallback, integer = false }: { min: number; max: number; fallback: number; integer?: boolean }): number {
	const value = raw.trim() === '' ? Number.NaN : Number(raw);
	if (!Number.isFinite(value)) return fallback;
	const clamped = Math.min(max, Math.max(min, value));
	return integer ? Math.round(clamped) : clamped;
}
