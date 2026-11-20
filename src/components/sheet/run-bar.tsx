'use client';

import clsx from 'clsx';
import { ChevronDown, Play, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { FloatingMenu, type MenuItem } from '@/components/ui/menu';
import { sheetSpend, updateSheetSpend, type SheetSpend } from '@/lib/api';
import { formatUsd } from '@/lib/endpoint-map';
import { isBlankValue } from '@/lib/cell-state';
import { quoteLabel, type RunQuote } from '@/lib/run-cost';
import { quotePlan } from '@/lib/run-quote';
import { runner } from '@/lib/runner';
import type { RunPlan, SheetRunStatus } from '@/lib/sheet-commands';
import type { Column, Row, Sheet } from '@/lib/types';
import { plural } from './sheet-page-utils';

export interface RunBarRuns {
	status: SheetRunStatus;
	unfinished: number;
	outdated: number;
	failed: number;
	shownRows: number;
	/** The plan "Run" would start, so its price can be quoted before the click. */
	plan: () => RunPlan | null;
	onRunUnfinished: () => void;
	onRerunOutdated: () => void;
	onRerunVisible: () => void;
	onRetryFailed: () => void;
	onStop: () => void;
}

/** What the sheet's AI cells cost and how many came back filled, for cells settled since `since`. */
function tally(rows: readonly Row[], columns: readonly Column[], since = 0) {
	let settled = 0, filled = 0, costUsd = 0;
	for (const row of rows) for (const column of columns) {
		const cell = row.cells[column.id];
		if (!cell || cell.t < since || (cell.s !== 'done' && cell.s !== 'error')) continue;
		settled++;
		if (cell.s === 'done' && !isBlankValue(cell.v)) filled++;
		costUsd += cell.m?.costUsd ?? 0;
	}
	return { settled, filled, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}

const percent = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : '–';

/** The sheet's money at a glance and the one Run button: "Enriching 412/1,000 · $0.83 of $1.90 quoted · 71% found". The
    Run button carries the server's quote ("Run 25 rows · up to $0.11"); the cap is the server's, not a UI hint. */
export function RunBar({ sheet, allRows, columns, runs }: { sheet: Sheet; allRows: readonly Row[]; columns: readonly Column[]; runs: RunBarRuns }) {
	const snapshot = useSyncExternalStore(runner.subscribe.bind(runner), () => runner.getSnapshot(), () => runner.getSnapshot());
	const pending = runs.status.pending;
	const [spend, setSpend] = useState<SheetSpend | null>(null);
	const [quote, setQuote] = useState<RunQuote | null>(null);
	const [started, setStarted] = useState<{ at: number; total: number; quotedUsd: number | null } | null>(null);
	const [menu, setMenu] = useState<DOMRect | null>(null);
	const [capEditor, setCapEditor] = useState<DOMRect | null>(null);
	const capInput = useRef<HTMLInputElement>(null);

	// A run started anywhere (a column menu, a cell) is counted from when it was first seen.
	if (pending > 0 && !started) setStarted({ at: Date.now() - 1000, total: pending, quotedUsd: null });	if (pending > 0 && started && pending > started.total) setStarted({ ...started, total: pending });
	if (pending === 0 && started && started.total > 0 && !runs.status.halt) setStarted(null);

	useEffect(() => {
		if (pending > 0) return;
		let live = true;
		sheetSpend(sheet.id).then((value) => { if (live) setSpend(value); }, () => {});
		return () => { live = false; };
	}, [sheet.id, pending]);

	const planKey = `${runs.unfinished}:${columns.map((column) => column.id + JSON.stringify(column.op)).join('|')}`;
	useEffect(() => {
		if (pending > 0) return;
		const plan = runs.plan();
		if (!plan || plan.kind !== 'run') return;
		const controller = new AbortController();
		const timer = setTimeout(() => { quotePlan(plan, sheet.id, controller.signal).then(setQuote, () => {}); }, 350);
		return () => { clearTimeout(timer); controller.abort(); };
		// eslint-disable-next-line react-hooks/exhaustive-deps -- re-quote when what Run would run changes, not on every render
	}, [planKey, pending, sheet.id]);

	const batches = snapshot.batches[sheet.id];
	const sinceStart = useMemo(() => started ? tally(allRows, columns, started.at) : null, [allRows, columns, started]);
	const total = useMemo(() => tally(allRows, columns), [allRows, columns]);
	const shownQuote = runs.unfinished > 0 && quote ? quote : null;
	// Every cell settled: a quiet outline button that says so, instead of a green button that looks broken while disabled.
	const settled = !runs.status.halt && runs.unfinished === 0 && !shownQuote;
	const runLabel = shownQuote ? quoteLabel(shownQuote, 'cell') : runs.unfinished ? `Run ${plural(runs.unfinished, 'cell')}` : 'Nothing to run';

	let meter: React.ReactNode;
	if (pending > 0 && started && sinceStart) {
		const done = Math.min(started.total, sinceStart.settled);
		meter = <><span className="font-medium text-fg">Enriching</span> <span className="num">{done.toLocaleString()}/{started.total.toLocaleString()}</span> · <span className="num">{formatUsd(sinceStart.costUsd)}</span>{started.quotedUsd !== null ? <> of <span className="num">{formatUsd(started.quotedUsd)}</span> quoted</> : ' so far'} · <span className="num">{percent(sinceStart.filled, sinceStart.settled)}</span> found</>;
	} else if (total.settled) {
		// One spend figure: the server's ledger (what the cap counts, re-runs included) once it has loaded, else the cells' own cost.
		const spentUsd = spend ? spend.spentUsd : total.costUsd;
		meter = <><span className="font-medium text-fg">Spent <span className="num">{formatUsd(spentUsd)}</span></span> on this sheet · <span className="num">{percent(total.filled, total.settled)}</span> found</>;
	} else {
		meter = <>No looot runs yet. Every run bills your own looot balance.</>;
	}
	const capShare = spend && spend.capUsd > 0 ? Math.min(1, spend.spentUsd / spend.capUsd) : 0;
	const progress = pending > 0 && started && sinceStart ? Math.min(1, sinceStart.settled / Math.max(1, started.total)) : 0;
	const items: MenuItem[] = [
		{ label: runs.unfinished ? `Run ${plural(runs.unfinished, 'unfinished cell')}` : 'Run unfinished cells', icon: <Play />, disabled: runs.unfinished === 0, onSelect: () => start(runs.onRunUnfinished) },
		...(runs.outdated > 0 ? [{ label: `Re-run ${plural(runs.outdated, 'outdated cell')}`, icon: <RefreshCw />, onSelect: () => start(runs.onRerunOutdated) }] : []),
		{ label: `Re-run ${plural(runs.shownRows, 'visible row')}`, icon: <RefreshCw />, disabled: runs.shownRows === 0, onSelect: () => start(runs.onRerunVisible) },
		...(runs.failed > 0 ? [{ label: `Retry ${plural(runs.failed, 'failed cell')}`, icon: <RotateCcw />, onSelect: () => start(runs.onRetryFailed) }] : []),
	];
	function start(action: () => void) {
		setStarted({ at: Date.now(), total: 0, quotedUsd: shownQuote?.maxUsd ?? null });
		action();
	}
	const batchNote = batches && Object.values(batches).some((entry) => entry.settled < entry.total) ? Object.values(batches).reduce((sum, entry) => sum + entry.total - entry.settled, 0) : 0;

	return (
		<div role="region" aria-label="Run and spend" className="relative flex shrink-0 items-center gap-3 border-t border-line bg-surface px-3 py-2 max-md:flex-wrap max-md:gap-2">
			<span aria-hidden className="meter-tick absolute top-[-1px] left-0 h-[2px] bg-brand" style={{ width: `${Math.round(progress * 100)}%` }} />
			<p role="status" data-run-meter className="min-w-0 flex-1 truncate text-caption text-fg-muted max-md:basis-full">
				{meter}{batchNote > 0 && <span className="text-fg-subtle"> · <span className="num">{batchNote}</span> in a looot batch</span>}
			</p>
			{spend && <button type="button" data-spend-cap onClick={(event) => setCapEditor(capEditor ? null : event.currentTarget.getBoundingClientRect())} className="inline-flex h-7 shrink-0 items-center gap-2 rounded-md border border-line px-2 text-caption text-fg-muted transition-colors hover:border-line-strong hover:bg-canvas hover:text-fg" title={`${formatUsd(spend.spentUsd)} of ${formatUsd(spend.capUsd)} used. The server refuses any cell that would take this sheet past its cap.`} aria-label={`Spend cap ${formatUsd(spend.capUsd)}, ${formatUsd(spend.spentUsd)} used. Edit cap`}>
				Cap <span className="num text-fg">{formatUsd(spend.capUsd)}</span>
				<span aria-hidden className="relative h-1 w-10 overflow-hidden rounded-full bg-line"><span className={clsx('absolute inset-y-0 left-0 rounded-full', capShare > 0.8 ? 'bg-warning' : 'bg-brand')} style={{ width: `${Math.max(capShare > 0 ? 6 : 0, Math.round(capShare * 100))}%` }} /></span>
			</button>}
			<span className="ml-auto flex shrink-0 items-center gap-0.5">
				{pending > 0 ? (
					<Button size="sm" variant="primary" onClick={runs.onStop} aria-label={`Stop ${plural(pending, 'cell')}`}><Square strokeWidth={1.5} /> Stop</Button>
				) : <>
					<Button size="sm" variant={settled ? 'outline' : 'brand'} data-run-button disabled={Boolean(runs.status.halt) || runs.unfinished === 0} onClick={() => start(runs.onRunUnfinished)} className={clsx('rounded-r-none', 'num-label')} title={runs.status.halt ? 'Paused: resume or stop from the banner' : undefined}>
						<Play strokeWidth={1.75} /> <span className="tabular">{runLabel}</span>
					</Button>
					<Button size="sm" variant={settled ? 'outline' : 'brand'} aria-label="More ways to run" aria-haspopup="menu" aria-expanded={menu !== null} disabled={Boolean(runs.status.halt)} onClick={(event) => setMenu(menu ? null : event.currentTarget.getBoundingClientRect())} className={clsx('w-8 rounded-l-none px-0', settled ? '-ml-px' : 'border-l border-brand-fg/20')}><ChevronDown className="size-3.5" /></Button>
				</>}
			</span>
			{menu && <FloatingMenu anchor={menu} align="right" width="w-64" items={items} onClose={() => setMenu(null)} />}
			{capEditor && spend && <FloatingMenu anchor={capEditor} role="dialog" label="Sheet spend cap" align="right" width="w-72" onClose={() => setCapEditor(null)}>
				<form className="flex flex-col gap-2 p-3" onSubmit={(event) => {
					event.preventDefault();
					const value = Number(capInput.current?.value);
					if (!Number.isFinite(value) || value < 0) return;
					void updateSheetSpend(sheet.id, { capUsd: value }).then((next) => { setSpend(next); setCapEditor(null); }, () => {});
				}}>
					<label className="text-caption text-fg-muted" htmlFor="sheet-cap">Spend cap for this sheet (USD)</label>
					<input ref={capInput} id="sheet-cap" type="number" min={0} step={0.5} defaultValue={spend.capUsd} className="num h-8 rounded-md border border-line bg-surface px-2 text-fg outline-none focus:border-brand" />
					<p className="text-caption text-fg-subtle">Spent <span className="num">{formatUsd(spend.spentUsd)}</span>, held for running cells <span className="num">{formatUsd(spend.heldUsd)}</span>. The server checks this before every cell.</p>
					<Button size="xs" variant="brand" type="submit">Save cap</Button>
				</form>
			</FloatingMenu>}
		</div>
	);
}
