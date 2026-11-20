/** Locate the reference slot under a formula's selection without interpreting quoted text. */
export function formulaReferenceTarget(text: string, from: number, to = from): { from: number; to: number } | null {
	if (!text.startsWith('=')) return null;
	let depth = 0, quote = '';
	for (let i = 1; i < from; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) { if (text[i + 1] === quote) i++; else quote = ''; }
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(') depth++;
		else if (ch === ')') depth--;
	}
	if (quote) return null;
	if (from !== to) {
		if (depth <= 0 || /[()"',;]/.test(text.slice(from, to))) return null;
		return { from, to };
	}
	// Replace an existing reference rather than appending to it on successive picks.
	const references = /\$?[A-Za-z]{1,3}\$?[1-9]\d*(?::\$?[A-Za-z]{0,3}\$?\d*)?/g;
	for (const match of text.matchAll(references)) {
		const start = match.index, end = start + match[0].length;
		if (from < start || from > end || /[A-Za-z0-9_.!]/.test(text[start - 1] ?? '') || /[A-Za-z0-9_(]/.test(text[end] ?? '')) continue;
		return { from: start, to: end };
	}
	const before = text.slice(0, from).trimEnd(), after = text.slice(to).trimStart();
	if (!/[=(,;+\-*/^&<>:]$/.test(before) || (after && !/^[),;+\-*/^&<>=]/.test(after))) return null;
	return depth > 0 || /[=+\-*/^&<>]$/.test(before) ? { from, to } : null;
}
