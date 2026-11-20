import rawFunctions from './formula-catalog/functions.json';

export interface FormulaFunction {
	tier: number;
	category: number;
	tags: string[];
	args: [name: string, type: string, description: string][];
	description: string;
	examples: string[];
}

const functions = rawFunctions as unknown as Record<string, FormulaFunction>;
export const formulaFunctionNames = Object.keys(functions).map((name) => name.toUpperCase()).sort();
export function formulaFunction(name: string): FormulaFunction | undefined { return functions[name.toLowerCase()]; }
export function argumentLabel(name: string): string {
	return name === '...' ? '…' : name.endsWith('*') ? `[${name.slice(0, -1)}]` : name;
}
export function activeArgument(info: FormulaFunction, index: number): number {
	if (!info.args.length) return -1;
	return Math.min(index, info.args.length - 1);
}
