/** Object results are persisted as JSON strings; also accept structured values. */
export function detailValue(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (!text.startsWith('{') && !text.startsWith('[')) return value;
	try { return JSON.parse(text); } catch { return value; }
}

/** React keys for list items that have no id: their content, numbered when the same item repeats. */
export function keyedItems<T>(items: readonly T[]): { key: string; item: T; index: number }[] {
	const seen = new Map<string, number>();
	return items.map((item, index) => {
		const content = typeof item === 'string' ? `s:${item}` : `j:${JSON.stringify(item) ?? String(item)}`;
		const count = seen.get(content) ?? 0;
		seen.set(content, count + 1);
		return { key: count ? `${content}#${count}` : content, item, index };
	});
}
