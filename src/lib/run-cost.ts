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

/* ───────────── Money guards shared by the browser and the server ───────────── */

/** A new column runs this many rows first. */
export const TRY_ROWS = 5;
/** A column stops after this many misses or errors in a row; the server refuses its next cells until it is resumed. */
export const HALT_AFTER_MISSES = 20;
/** Every sheet starts with this spend cap. The server refuses a cell that would take the sheet past it. */
export const DEFAULT_SHEET_CAP_USD = 5;
/** A fallback route may try about this many providers; the per-cell cap leaves room for them. */
const ROUTE_HEADROOM = 3;
/** Batchable columns of at least this many cells run through looot's rows batch instead of one request per cell. */
export const BATCH_MIN_CELLS = 10;
/** looot's rows batch takes at most this many rows per call. */
export const BATCH_MAX_ROWS = 500;

const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** The most one cell may spend on looot: sent as fallback.maxCostUsd and enforced again by the server's spend guard. */
export function cellCapUsd(op: RunOp): number {
	const typical = costPerCell(op);
	return typical > 0 ? roundUsd(Math.max(0.001, typical * ROUTE_HEADROOM)) : 0;
}

/** The looot job a column runs through the rows batch, or null when it runs one request per cell. */
export function batchJob(op: RunOp): 'people.email.find' | 'people.email.verify' | 'people.phone.find' | 'company.enrich' | null {
	switch (op?.kind) {
		case 'email-enrichment': return 'people.email.find';
		case 'email-verify': return 'people.email.verify';
		case 'phone-find': return 'people.phone.find';
		case 'company': return 'company.enrich';
		default: return null;
	}
}

/** What the server says a run may cost before it starts. `maxUsd` is the most it can spend; `typicalUsd` the usual. */
export interface RunQuote {
	cells: number;
	perCellMaxUsd: number;
	maxUsd: number;
	typicalUsd: number;
	/** looot: the rows batch quote (quoteOnly). estimate: the catalog price times the per-cell cap. */
	source: 'looot' | 'estimate';
	/** The sheet's cap and what it has spent and holds, when the run belongs to a sheet. */
	sheet?: { capUsd: number; spentUsd: number; heldUsd: number };
}

/** "Run 25 rows · up to $0.11": the Run button's label for a quote. */
export function quoteLabel(quote: Pick<RunQuote, 'cells' | 'maxUsd'>, unit = 'row'): string {
	const base = `Run ${count(quote.cells, unit)}`;
	return quote.maxUsd > 0 ? `${base} · up to ${formatUsd(quote.maxUsd)}` : base;
}

/** The confirmation rule against a server quote: above $0.50 or 50 cells. */
export const quoteAsksFirst = (quote: Pick<RunQuote, 'cells' | 'maxUsd'>) => quote.cells > CONFIRM_CELLS || quote.maxUsd > CONFIRM_USD;
