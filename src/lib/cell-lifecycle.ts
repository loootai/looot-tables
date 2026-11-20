import type { Cell, CellMeta, CellValue } from './types';

export const STALE_ENRICHMENT_MESSAGE = 'Inputs or instructions changed during enrichment. Run this cell again.';
export const INTERRUPTED_ENRICHMENT_MESSAGE = 'This run timed out or was interrupted. Run this cell again.';

export const isPendingCell = (cell?: Cell) => cell?.s === 'queued' || cell?.s === 'running';

export type CellEvent =
	| { type: 'start'; owner?: string }
	| { type: 'succeed'; v: CellValue; m?: CellMeta }
	| { type: 'fail'; e: string; m?: CellMeta }
	| { type: 'stale' }
	| { type: 'cancel' }
	| { type: 'expire' };

/** The value a pending cell had before it started. A completed lookup with no answer still has metadata, so it stays done. */
function settled(cell: Cell, at: number): Cell {
	return { v: cell.v, ...(cell.m ? { m: cell.m } : {}), s: cell.v !== null || cell.m ? 'done' : 'idle', t: at };
}

/** A failure keeps the result its run started from (a failure's own metadata is not one), so a failed or stale re-run
    never erases a value; otherwise it records the failure's metadata. */
function failed(cell: Cell, e: string, m: CellMeta | undefined, at: number): Cell {
	if (cell.v !== null || (cell.m && cell.s !== 'error')) return { v: cell.v, ...(cell.m ? { m: cell.m } : {}), s: 'error', e, t: at };
	return { v: null, s: 'error', e, ...(m ? { m } : {}), t: at };
}

/** The only place an enrichment changes a cell's status. A pending cell keeps its last settled value and metadata,
    so stopping or superseding a run restores them exactly. A running cell names its owner (a browser tab or an MCP
    request), so others know it is not theirs. */
export function cellTransition(cell: Cell | undefined, event: CellEvent, at = Date.now()): Cell {
	const current: Cell = cell ?? { v: null, s: 'idle', t: 0 };
	switch (event.type) {
		case 'start': {
			// A failure's metadata describes the failure, not a value worth restoring.
			const keep = isPendingCell(current) || current.s !== 'error' || current.v !== null;
			return { v: keep ? current.v : null, ...(keep && current.m ? { m: current.m } : {}), s: 'running', ...(event.owner ? { owner: event.owner } : {}), t: at };
		}
		case 'succeed': return { v: event.v, s: 'done', ...(event.m ? { m: event.m } : {}), t: at };
		case 'fail': return failed(current, event.e, event.m, at);
		case 'stale': return failed(current, STALE_ENRICHMENT_MESSAGE, undefined, at);
		case 'cancel': return isPendingCell(current) ? settled(current, at) : current;
		case 'expire': return isPendingCell(current) ? failed(current, INTERRUPTED_ENRICHMENT_MESSAGE, undefined, at) : current;
	}
}
