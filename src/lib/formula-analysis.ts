import { getTokens, type Model } from '@ironcalc/wasm';

export interface FormulaToken {
	from: number;
	to: number;
	kind: 'function' | 'number' | 'string' | 'boolean' | 'operator' | 'punctuation' | 'error' | 'reference';
	color?: number;
}
export interface FormulaAnalysis {
	tokens: FormulaToken[];
	completion: { from: number; prefix: string } | null;
	call: { name: string; argument: number } | null;
}
export interface FormulaAnalysisRequest { text: string; cursor: number }

export const emptyFormulaAnalysis = (): FormulaAnalysis => ({ tokens: [], completion: null, call: null });

/** IronCalc uses Unicode scalar offsets, while CodeMirror and DOM selections use UTF-16. */
export function scalarToUtf16(text: string, offset: number): number {
	return Array.from(text).slice(0, offset).join('').length;
}

export function analyzeFormula(model: Model, { text, cursor }: FormulaAnalysisRequest): FormulaAnalysis {
	const result = emptyFormulaAnalysis();
	if (!text.startsWith('=')) return result;
	const context = model.getFormulaCompletion(0, 1, 1, text, Array.from(text.slice(0, cursor)).length);
	for (const token of context.expecting) {
		if (typeof token !== 'object') continue;
		if ('FunctionName' in token) result.completion = { prefix: token.FunctionName.toUpperCase(), from: scalarToUtf16(text, context.replace_from + 1) };
		if ('Argument' in token) result.call = { name: token.Argument[0].toUpperCase(), argument: token.Argument[1] - 1 };
	}
	const references = new Map<string, number>();
	for (const marked of getTokens(text)) {
		const from = scalarToUtf16(text, marked.start), to = scalarToUtf16(text, marked.end);
		if (to <= from) continue;
		const token = marked.token;
		let kind: FormulaToken['kind'] | undefined;
		let color: number | undefined;
		if (typeof token === 'object') {
			if ('Reference' in token || 'Range' in token) {
				kind = 'reference';
				const reference = text.slice(from, to).replace(/\$/g, '').toUpperCase();
				if (!references.has(reference)) references.set(reference, references.size % 6);
				color = references.get(reference);
			} else if ('Number' in token) kind = 'number';
			else if ('String' in token) kind = 'string';
			else if ('Boolean' in token) kind = 'boolean';
			else if ('Error' in token) kind = 'error';
			else if ('Ident' in token) { if (text.slice(to).trimStart().startsWith('(')) kind = 'function'; }
			else kind = 'operator';
		} else if (token === 'Illegal') kind = 'error';
		else if (token === 'EOF') continue;
		else kind = /Parenthesis|Comma|Semicolon|Bracket|Brace/.test(token) ? 'punctuation' : 'operator';
		if (kind) result.tokens.push({ from, to, kind, ...(color === undefined ? {} : { color }) });
	}
	return result;
}
