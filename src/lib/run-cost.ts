import { creditsPerCell as operationCredits } from './operations';
import type { ColumnOp, FormulaSuggestion } from './types';

/** Runs larger than either limit ask before starting. */
export const CONFIRM_CELLS = 50;
export const CONFIRM_CREDITS = 100;

type RunOp = ColumnOp | FormulaSuggestion | null | undefined;

/** Rough Context.dev credits per cell. Formulas run locally. */
export function creditsPerCell(op: RunOp): number {
	return op && op.kind !== 'formula' ? operationCredits(op) : 0;
}

export interface RunEstimate { cells: number; creditsPerCell: number; credits: number; confirm: boolean; message: string }

const count = (value: number, unit: string) => `${value.toLocaleString('en-US')} ${unit}${value === 1 ? '' : 's'}`;

/** The one confirmation rule for bulk runs, given how many cells each column runs. */
export function estimateCells(columns: ReadonlyArray<{ cells: number; op: RunOp }>): RunEstimate {
	const counted = columns.map(({ cells, op }) => ({ cells: Math.max(0, Math.floor(cells)), op }));
	const cells = counted.reduce((sum, column) => sum + column.cells, 0);
	const credits = counted.reduce((sum, column) => sum + column.cells * creditsPerCell(column.op), 0);
	const perCell = credits ? Math.max(1, Math.round(credits / cells)) : 0;
	return {
		cells,
		creditsPerCell: perCell,
		credits,
		confirm: cells > CONFIRM_CELLS || credits > CONFIRM_CREDITS,
		message: credits ? `~${count(cells, 'cell')} × ~${count(perCell, 'credit')} ≈ ${count(credits, 'credit')}` : `~${count(cells, 'cell')}`,
	};
}

/** Whether a run asks before starting. `seen` is an estimate already shown (and accepted, if it asked): a run no bigger
    in cells or credits doesn't ask again. */
export function asksFirst(estimate: RunEstimate, seen?: RunEstimate): boolean {
	return estimate.confirm && !(seen && estimate.cells <= seen.cells && estimate.credits <= seen.credits);
}
