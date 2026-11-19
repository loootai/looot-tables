import { costPerCell as operationCost } from './operations';
import { formatUsd } from './endpoint-map';
import type { ColumnOp, FormulaSuggestion } from './types';

/** Runs larger than either limit ask before starting. A column on any looot endpoint always asks: its price is the
    reason to look before spending. */
export const CONFIRM_CELLS = 50;
export const CONFIRM_USD = 0.5;

type RunOp = ColumnOp | FormulaSuggestion | null | undefined;

/** Rough looot cost per cell in USD. Formulas run locally. */
export function costPerCell(op: RunOp): number {
	return op && op.kind !== 'formula' ? operationCost(op) : 0;
}

export interface RunEstimate { cells: number; usdPerCell: number; usd: number; confirm: boolean; message: string }

const count = (value: number, unit: string) => `${value.toLocaleString('en-US')} ${unit}${value === 1 ? '' : 's'}`;

/** The one confirmation rule for bulk runs, given how many cells each column runs. */
export function estimateCells(columns: ReadonlyArray<{ cells: number; op: RunOp }>): RunEstimate {
	const counted = columns.map(({ cells, op }) => ({ cells: Math.max(0, Math.floor(cells)), op }));
	const cells = counted.reduce((sum, column) => sum + column.cells, 0);
	const usd = Math.round(counted.reduce((sum, column) => sum + column.cells * costPerCell(column.op), 0) * 1e6) / 1e6;
	const usdPerCell = cells ? usd / cells : 0;
	const priced = counted.some(({ cells: n, op }) => n > 0 && op?.kind === 'looot');
	return {
		cells,
		usdPerCell,
		usd,
		confirm: cells > CONFIRM_CELLS || usd > CONFIRM_USD || (priced && cells > 0),
		message: usd ? `~${count(cells, 'cell')} × ~${formatUsd(usdPerCell)} ≈ ${formatUsd(usd)}` : `~${count(cells, 'cell')}`,
	};
}

/** Whether a run asks before starting. `seen` is an estimate already shown (and accepted, if it asked): a run no bigger
    in cells or cost doesn't ask again. */
export function asksFirst(estimate: RunEstimate, seen?: RunEstimate): boolean {
	return estimate.confirm && !(seen && estimate.cells <= seen.cells && estimate.usd <= seen.usd);
}
