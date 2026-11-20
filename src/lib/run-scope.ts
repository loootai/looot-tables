export type RunCount = 1 | 5 | 10 | 100 | 'all' | 'column';
export interface RunScope { count: number; scope: 'cell' | 'below' | 'column' }
export interface RunScopeOption { value: RunCount; label: string }

export function parseRunCount(saved: string | null | undefined): RunCount {
	if (saved === 'all' || saved === 'column') return saved;
	if (saved === '5' || saved === '10' || saved === '100') return Number(saved) as 5 | 10 | 100;
	return 1;
}

/**
 * Labels name real rows. `remainingRows` counts from the starting row to the end of the visible rows;
 * `startRow` is that row's number when the caller knows it (otherwise it reads "this row").
 */
export function runScopeChoice(saved: RunCount, remainingRows: number, totalRows: number, startRow?: number) {
	const available = Math.max(1, remainingRows);
	const one = startRow ? `Run on row ${startRow}` : 'Run on this row';
	const rows = (count: number) => `Run on ${count.toLocaleString('en-US')} rows${startRow && startRow > 1 ? ` from row ${startRow}` : ''}`;
	const all = `Run on all ${totalRows.toLocaleString('en-US')} rows`;
	// "The rest" from row 1 with nothing hidden is the whole column; show it once.
	const restIsAll = available >= totalRows;
	let effective: RunCount = saved === 'column' ? 'column' : available === 1 ? 1 : saved === 'all' || saved >= available ? 'all' : saved;
	if (effective === 'all' && restIsAll) effective = 'column';
	if (totalRows <= 1) effective = 1;
	const count = effective === 'column' ? totalRows : effective === 'all' ? available : effective;
	const scope: RunScope = { count, scope: effective === 'column' ? 'column' : effective === 1 ? 'cell' : 'below' };
	const label = effective === 1 ? one : effective === 'column' ? all : effective === 5 ? `Try ${count} rows` : rows(count);
	const options: RunScopeOption[] = [
		{ value: 1, label: one },
		...(available > 5 ? [{ value: 5 as const, label: 'Try 5 rows' }] : []),
		...([10, 100] as const).filter((n) => n < available).map((value) => ({ value, label: rows(value) })),
		...(available > 1 && !restIsAll ? [{ value: 'all' as const, label: rows(available) }] : []),
		{ value: 'column', label: all },
	];
	return { scope, label, options, selected: effective };
}
