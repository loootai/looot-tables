'use client';

import { Button } from '@/components/ui/button';
import { updateSheet } from '@/lib/db';
import { populateRunner } from '@/lib/populate-runner';
import { createSheetCommands, type SheetCommands } from '@/lib/sheet-commands';
import type { Row, Sheet } from '@/lib/types';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormulaRangeProvider } from './formula-range-context';
import { HaltedBanner } from './halted-banner';
import { SheetFormulaBar, SheetGridArea } from './sheet-page-grid';
import { SheetDialogs, SheetMenus } from './sheet-page-overlays';
import { SheetToolbar } from './sheet-toolbar';
import { RunBar } from './run-bar';
import { AgentPanel } from './agent-panel';
import { useSettings } from '@/components/app/settings-context';
import { updateSheetSpend } from '@/lib/api';
import { useSheetActions } from './use-sheet-actions';
import { useSheetData, useSheetRows } from './use-sheet-data';
import { useSheetHistory } from './use-sheet-history';
import { useSheetMenus } from './use-sheet-menus';
import { useSheetOverlays } from './use-sheet-overlays';
import { useSheetSelection } from './use-sheet-selection';
import { useSheetView } from './use-sheet-view';

export function SheetPage({ sheetId }: { sheetId: string }) {
	return (
		<Suspense fallback={<SheetSkeleton />}>
			<FormulaRangeProvider><SheetView sheetId={sheetId} /></FormulaRangeProvider>
		</Suspense>
	);
}

function SheetSkeleton() {
	return (
		<div className="flex h-full flex-col gap-3 p-4">
			<div className="skeleton h-10 w-1/3" />
			<div className="skeleton flex-1" />
		</div>
	);
}

function SheetView({ sheetId }: { sheetId: string }) {
	const commands = useMemo(() => createSheetCommands(sheetId), [sheetId]);
	const { sheet, allRows, failure, retry } = useSheetData(sheetId, commands);
	if (failure?.status === 'error') return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
			<p role="alert" className="text-body text-fg">Couldn&apos;t load this sheet. {failure.message}</p>
			<Button onClick={retry}>Retry</Button>
			<Link href="/app" className="text-body-sm text-brand hover:underline">Back to sheets</Link>
		</div>
	);
	if (failure?.status === 'missing') return (
		<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
			<p className="text-body text-fg">This sheet doesn&apos;t exist in this workspace.</p>
			<Link href="/app" className="text-body-sm text-brand hover:underline">Back to sheets</Link>
		</div>
	);
	if (!sheet || allRows === undefined) return <SheetSkeleton />;
	return <SheetWorkspace sheetId={sheetId} sheet={sheet} allRows={allRows} commands={commands} />;
}

function SheetWorkspace({ sheetId, sheet, allRows, commands }: { sheetId: string; sheet: Sheet; allRows: Row[]; commands: SheetCommands }) {
	const [search, setSearch] = useState('');
	const [filterOpenRequest, setFilterOpenRequest] = useState(0);
	const view = useSheetView(sheet);
	const content = useSheetRows({ sheetId, sheet, allRows, commands, search, view });
	const { rows, runStatus, populate, enrichedColumns } = content;
	const history = useSheetHistory(sheetId);
	const selection = useSheetSelection(sheet, rows, content.rowById);
	const overlays = useSheetOverlays();
	const actions = useSheetActions({ sheet, commands, content, selection, overlays, view });
	const openFilter = () => setFilterOpenRequest((value) => value + 1);
	const menus = useSheetMenus({ sheetId, sheet, allRows, commands, content, selection, overlays, actions, view, onFilter: openFilter });
	const findButtonRef = useRef<HTMLButtonElement>(null);
	const onLeave = useLeaveGuard(runStatus.pending > 0 || populate.running);
	useDocumentTitle(sheet.name);
	const { runCells, report } = actions;
	const halt = runStatus.halt;
	const openFind = () => actions.requireKeys() && overlays.setPopulateOpen(true);
	const agent = useAgentToggle();
	const { providerReady, openKeys } = useSettings();

	return (
		<div className="flex h-full min-h-0 min-w-0 gap-3 p-2 max-md:p-0 md:p-3">
			<div className="glass-frame sheet-pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden max-md:rounded-none max-md:shadow-none">
				<SheetToolbar
					sheet={sheet}
					allRows={allRows}
					shownRows={rows.length}
					selectedRows={selection.selectedRows.length}
					search={search}
					onSearch={setSearch}
					filters={view.filters}
					onFiltersChange={view.setFilters}
					filterRequest={filterOpenRequest}
					onOpenFilter={openFilter}
					history={history}
					runs={{
						status: runStatus,
						unfinished: content.unfinished,
						outdated: content.outdated,
						failed: content.failed,
						canRun: enrichedColumns.length > 0,
						onRunUnfinished: () => runCells(rows, enrichedColumns, 'unfinished'),
						onRerunOutdated: () => runCells(rows, enrichedColumns, 'outdated'),
						onRerunVisible: () => runCells(rows, enrichedColumns, 'all'),
						onRetryFailed: () => actions.request(commands.planRetry(content.progressRows ?? [], enrichedColumns, { ready: actions.providerReady })),
						onStop: () => void commands.stop(),
					}}
					finding={{ running: populate.running, stopping: populate.phase === 'stopping', revealing: content.findingRows, added: populate.added, status: populate.status, onFind: openFind, onStop: () => populateRunner.stop(sheetId) }}
					findButtonRef={findButtonRef}
					addItems={menus.addItems}
					onShowColumns={(ids) => void updateSheet(sheetId, (current) => {
						const shown = new Set(ids);
						return { columns: current.columns.map((column) => shown.has(column.id) ? { ...column, hidden: false } : column) };
					}).catch(report('Could not show columns'))}
					onExport={actions.exportSheet}
					selection={{ onRun: (mode) => runCells(selection.selectedRows, enrichedColumns, mode), onDelete: () => actions.confirmDeleteRows(selection.selectedRows), onClear: () => selection.setSelected(new Set()) }}
					onRename={(name) => updateSheet(sheetId, { name })}
					onMobileRename={() => overlays.setRenamingSheet(true)}
					agent={{ open: agent.open, onToggle: agent.toggle }}
					banner={halt && <HaltedBanner halt={halt} waiting={runStatus.queued} onRetry={() => void (halt.reason === 'column_halted' && halt.columnId ? updateSheetSpend(sheetId, { resumeColumn: halt.columnId }) : Promise.resolve()).then(() => commands.retryHalted()).catch(report('Could not resume'))} onDismiss={() => void commands.dismissHalt().catch(report('Could not stop these cells'))} onLeave={onLeave} />}
				/>
				<SheetFormulaBar sheet={sheet} content={content} selection={selection} commands={commands} onSave={actions.editCell} />
				<SheetGridArea sheetId={sheetId} sheet={sheet} allRows={allRows} commands={commands} content={content} selection={selection} overlays={overlays} actions={actions} view={view} halt={halt} onFind={openFind} onLeave={onLeave} />
				{enrichedColumns.length > 0 && <RunBar sheet={sheet} allRows={allRows} columns={enrichedColumns} runs={{
					status: runStatus, unfinished: content.unfinished, outdated: content.outdated, failed: content.failed, shownRows: rows.length,
					plan: () => commands.plan(rows, enrichedColumns, 'unfinished', { ready: actions.providerReady, grid: content.grid, sheetColumns: sheet.columns }),
					onRunUnfinished: () => runCells(rows, enrichedColumns, 'unfinished'),
					onRerunOutdated: () => runCells(rows, enrichedColumns, 'outdated'),
					onRerunVisible: () => runCells(rows, enrichedColumns, 'all'),
					onRetryFailed: () => actions.request(commands.planRetry(content.progressRows ?? [], enrichedColumns, { ready: actions.providerReady })),
					onStop: () => void commands.stop(),
				}} />}
			</div>
			{agent.open && <AgentPanel sheetId={sheetId} onClose={agent.close} keyReady={providerReady('anthropic') || providerReady('openai')} onOpenKeys={openKeys} />}

			<SheetMenus overlays={overlays} menus={menus} onSaveRouting={(column, op) => commands.editColumn(column.id, { op })} />
			<SheetDialogs sheetId={sheetId} sheet={sheet} allRows={allRows} commands={commands} content={content} activeIndex={selection.activeIndex} overlays={overlays} actions={actions} onActivate={selection.setActive} findButtonRef={findButtonRef} />
		</div>
	);
}

/** The agent panel's visibility, toggled by its toolbar button and ⌘/Ctrl+K, remembered per browser. */
function useAgentToggle() {
	// The workspace renders only once the sheet has loaded in the browser, so storage is readable here.
	const [open, setOpen] = useState(() => {
		try { return typeof window !== 'undefined' && window.localStorage.getItem(AGENT_OPEN) === '1' && window.matchMedia('(width >= 768px)').matches; } catch { return false; }
	});
	const set = useCallback((next: boolean | ((value: boolean) => boolean)) => setOpen((value) => {
		const result = typeof next === 'function' ? next(value) : next;
		try { window.localStorage.setItem(AGENT_OPEN, result ? '1' : '0'); } catch { /* storage unavailable */ }
		return result;
	}), []);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); set((value) => !value); }
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [set]);
	return { open, toggle: () => set((value) => !value), close: () => set(false) };
}
const AGENT_OPEN = 'looot-tables.agent.open';

/** Queued cells and Find rows live in this tab: closing it drops them, so ask first. Returns the call for leaving on purpose (reconnecting). */
function useLeaveGuard(working: boolean) {
	const leaving = useRef(false);
	useEffect(() => {
		if (!working) return;
		const guard = (event: BeforeUnloadEvent) => {
			if (leaving.current) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', guard);
		return () => window.removeEventListener('beforeunload', guard);
	}, [working]);
	return () => { leaving.current = true; };
}

function useDocumentTitle(sheetName: string) {
	useEffect(() => {
		if (!sheetName) return;
		const previous = document.title;
		document.title = `${sheetName} · looot tables`;
		return () => { document.title = previous; };
	}, [sheetName]);
}
