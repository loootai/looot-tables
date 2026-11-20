import type { Cell, CellValue, Column } from './types';

/** How a cell's 2px left edge reads: running, a verified hit, a weak or stale answer, a miss, or an error. Source cells
    and cells that never ran have none. */
export type CellState = 'running' | 'hit' | 'weak' | 'miss' | 'error' | 'stale';

const WEAK_STATUSES = new Set(['catch_all', 'risky', 'unknown']);
export const isBlankValue = (value: CellValue | undefined) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

export function cellState(cell: Cell | undefined, column: Pick<Column, 'type'>, stale = false): CellState | undefined {
	if (!cell) return undefined;
	if (cell.s === 'running' || cell.s === 'queued') return 'running';
	if (cell.s === 'error') return 'error';
	if (column.type !== 'enriched' || cell.s !== 'done' || cell.f) return undefined;
	if (stale) return 'stale';
	if (isBlankValue(cell.v)) return 'miss';
	const calls = cell.m?.looot ?? [];
	if (WEAK_STATUSES.has(cell.m?.verification ?? '') || calls.some((call) => call.outcome === 'weak')) return 'weak';
	return 'hit';
}

/** A column's money and fill, for its header sub-line and footer: what its cells cost, and how many came back filled. */
export interface ColumnStats { rows: number; settled: number; filled: number; running: number; costUsd: number }

export function columnStats(column: Column, rows: readonly { cells: Record<string, Cell> }[]): ColumnStats {
	const stats: ColumnStats = { rows: rows.length, settled: 0, filled: 0, running: 0, costUsd: 0 };
	for (const row of rows) {
		const cell = row.cells[column.id];
		if (!cell) continue;
		if (cell.s === 'running' || cell.s === 'queued') stats.running++;
		if (cell.s === 'done' || cell.s === 'error') stats.settled++;
		if (cell.s === 'done' && !isBlankValue(cell.v)) stats.filled++;
		stats.costUsd += cell.m?.costUsd ?? 0;
	}
	stats.costUsd = Math.round(stats.costUsd * 1e6) / 1e6;
	return stats;
}

/** "71%": filled cells out of settled ones; empty until something settled. */
export const fillPercent = (stats: Pick<ColumnStats, 'settled' | 'filled'>) => stats.settled ? `${Math.round((stats.filled / stats.settled) * 100)}%` : '';
