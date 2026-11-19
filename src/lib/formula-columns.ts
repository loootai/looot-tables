import { columnAddress } from './formula-input';
import type { Column } from './types';

export interface FormulaColumnReference { from: number; to: number; name: string; column: number }

/** Named column references are row-relative. Quoted strings and A1 references stay literal. */
export function formulaColumnReferences(text: string, columns: Pick<Column, 'name'>[], strict = false): FormulaColumnReference[] {
	const names = new Map(columns.map((column, index) => [column.name.toLowerCase(), index]));
	const references: FormulaColumnReference[] = [];
	const pattern = /"(?:[^"]|"")*"|'(?:[^']|'')*'|\{\{\s*([^{}]+?)\s*\}\}|[\p{L}_][\p{L}\p{N}_.]*/gu;
	for (const match of text.matchAll(pattern)) {
		const token = match[0];
		if (token.startsWith('"') || token.startsWith("'")) continue;
		const explicit = match[1] !== undefined;
		const name = (match[1] ?? token).trim();
		if (!explicit && (/^[A-Z]+[1-9]\d*$/i.test(name) || /^(TRUE|FALSE)$/i.test(name) || /^\s*[(!]/.test(text.slice(match.index! + token.length)) || /[\p{L}\p{N}_.$!]/u.test(text[match.index! - 1] ?? ''))) continue;
		const column = names.get(name.toLowerCase());
		if (column === undefined) { if (strict && explicit) throw new Error(`Unknown column: ${name}`); continue; }
		references.push({ from: match.index!, to: match.index! + token.length, name: columns[column].name, column });
	}
	return references;
}

export function resolveColumnFormula(text: string, columns: Pick<Column, 'name'>[], row: number): string {
	let formula = text;
	for (const reference of formulaColumnReferences(text, columns, true).reverse()) formula = formula.slice(0, reference.from) + `${columnAddress(reference.column)}${row + 1}` + formula.slice(reference.to);
	return formula;
}
