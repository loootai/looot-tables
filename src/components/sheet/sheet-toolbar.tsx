'use client';

import { Button, IconButton } from '@/components/ui/button';
import { buttonClassName } from '@/components/ui/button-class';
import { FloatingMenu, MENU_LABEL, MENU_ROW, MENU_SEPARATOR, MenuButton, type MenuItem } from '@/components/ui/menu';
import { useToast } from '@/components/ui/toast';
import type { SheetRunStatus } from '@/lib/sheet-commands';
import { exportSummary, type ExportFormat } from '@/lib/sheet-export';
import type { SheetView } from '@/lib/sheet-view';
import type { Column, Row, Sheet } from '@/lib/types';
import clsx from 'clsx';
import { ArrowLeft, Check, ChevronDown, Download, Ellipsis, Eye, EyeOff, FileJson, FileSpreadsheet, FileText, Filter, Pencil, Play, Plus, Redo2, RefreshCw, RotateCcw, Search, Sparkles, Square, Trash2, Undo2, X } from 'lucide-react';
import Link from 'next/link';
import { type MouseEvent, type ReactNode, type RefObject, useRef, useState } from 'react';
import { NavigationButton } from '@/components/app/sidebar';
import { CollaborationBar } from './collaboration-bar';
import { FilterMenu } from './filter-bar';
import { plural } from './sheet-page-utils';

export interface SheetToolbarProps {
	sheet: Sheet;
	allRows: Row[];
	shownRows: number;
	selectedRows: number;
	search: string;
	onSearch: (value: string) => void;
	/** This viewer's filters (see sheet-view.ts). */
	filters: SheetView['filters'];
	onFiltersChange: (filters: SheetView['filters']) => void;
	filterRequest: number;
	onOpenFilter: () => void;
	history: { undo: boolean; redo: boolean; busy: boolean; navigate: (direction: 'undo' | 'redo') => void };
	/** `unfinished`: cells never run, failed or stopped. `outdated`: finished cells whose instructions or inputs changed
	    since they ran; they run only from their own menu item. */
	runs: { status: SheetRunStatus; unfinished: number; outdated: number; failed: number; canRun: boolean; onRunUnfinished: () => void; onRerunOutdated: () => void; onRerunVisible: () => void; onRetryFailed: () => void; onStop: () => void };
	finding: { running: boolean; stopping: boolean; revealing: boolean; added: number; status: string; onFind: () => void; onStop: () => void };
	/** The Find rows dialog collapses into this button. */
	findButtonRef: RefObject<HTMLButtonElement | null>;
	addItems: MenuItem[];
	onShowColumns: (columnIds: string[]) => void;
	onExport: (format: ExportFormat, options: { allRows: boolean; includeMeta: boolean }) => void;
	selection: { onRun: (mode: 'unfinished' | 'all') => void; onDelete: () => void; onClear: () => void };
	onRename: (name: string) => Promise<void>;
	onMobileRename: () => void;
	/** Shown under the actions, for a paused run. */
	banner?: ReactNode;
}

/** Inline rename on desktop; a dialog on touch-sized screens, where a focused input would cover the sheet. */
function SheetTitle({ name, onSave, onMobileRename }: { name: string; onSave: (name: string) => Promise<void>; onMobileRename: () => void }) {
	const { toast } = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const finished = useRef(false);
	async function commit() {
		if (finished.current || draft === null) return;
		finished.current = true;
		const trimmed = draft.trim();
		if (!trimmed || trimmed === name) { setDraft(null); return; }
		setSaving(true);
		try {
			await onSave(trimmed);
			setDraft(null);
		} catch (error) {
			finished.current = false;
			toast(error instanceof Error ? error.message : 'Could not rename sheet', 'error');
		} finally { setSaving(false); }
	}
	if (draft !== null) return <input
		aria-label="Sheet name"
		autoFocus
		onFocus={(event) => event.target.select()}
		value={draft}
		readOnly={saving}
		aria-busy={saving || undefined}
		onChange={(event) => setDraft(event.target.value)}
		onBlur={() => void commit()}
		onKeyDown={(event) => {
			event.stopPropagation();
			if (event.nativeEvent.isComposing || saving) return;
			if (event.key === 'Enter') { event.preventDefault(); void commit(); }
			if (event.key === 'Escape') { event.preventDefault(); finished.current = true; setDraft(null); }
		}}
		className="min-w-0 max-w-[36ch] rounded-lg bg-surface px-2 py-1 text-body font-medium text-fg outline-2 outline-brand max-md:flex-1"
		style={{ width: `${Math.max(8, draft.length + 2)}ch` }}
	/>;
	return <button type="button" onClick={() => {
		if (window.matchMedia('(width < 768px)').matches) { onMobileRename(); return; }
		finished.current = false;
		setDraft(name);
	}} className="min-w-0 max-w-[36ch] truncate rounded-lg px-2 py-1 text-left text-body font-medium text-fg hover:bg-tint/[0.04] max-md:flex-1" title="Rename sheet">{name}</button>;
}

/** A menu row that toggles without closing the menu. */
function MenuCheckbox({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
	return (
		<button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={() => onChange(!checked)} className={clsx(MENU_ROW, 'text-fg hover:bg-tint/[0.05]')}>
			<span aria-hidden className={clsx('grid size-4 shrink-0 place-items-center rounded border transition-colors', checked ? 'border-brand bg-brand text-brand-fg' : 'border-line-strong bg-surface')}>{checked && <Check className="!size-3 !text-brand-fg" strokeWidth={2.5} />}</span>
			<span className="min-w-0 flex-1">{children}</span>
		</button>
	);
}

/** Icon-only on phones; the label stays the accessible name. */
function SelectionButton({ label, text, disabled, expanded, onClick, children }: { label: string; text: string; disabled?: boolean; expanded?: boolean; onClick: (event: MouseEvent<HTMLButtonElement>) => void; children: ReactNode }) {
	return (
		<Button size="xs" variant="ghost" disabled={disabled} onClick={onClick} aria-label={label} aria-haspopup={expanded === undefined ? undefined : 'menu'} aria-expanded={expanded} className="text-fg hover:bg-blue-20 @max-3xl:min-w-11 @max-3xl:px-0 [&_svg]:stroke-[1.75]">
			{children}<span className="@max-3xl:hidden">{text}</span>
		</Button>
	);
}

/** States its scope first: an export silently matching the current search or filters would look like lost rows. */
function ExportMenu({ anchor, summary, subset, options, onOptions, onExport, onClose }: { anchor: DOMRect; summary: string; subset: boolean; options: { allRows: boolean; includeMeta: boolean }; onOptions: (options: { allRows: boolean; includeMeta: boolean }) => void; onExport: (format: ExportFormat) => void; onClose: () => void }) {
	const formats: MenuItem[] = [
		{ label: 'CSV', icon: <FileText />, onSelect: () => onExport('csv') },
		{ label: 'Excel (.xlsx)', icon: <FileSpreadsheet />, onSelect: () => onExport('xlsx') },
		{ label: 'JSON', icon: <FileJson />, onSelect: () => onExport('json') },
	];
	return (
		<FloatingMenu anchor={anchor} align="right" width="w-72" label="Export" items={formats} onClose={onClose}>
			<p aria-hidden className={clsx(MENU_LABEL, 'text-fg-muted')}>{summary}</p>
			<div role="group" aria-label={summary} className="flex flex-col gap-0.5">
				{subset && <MenuCheckbox checked={options.allRows} onChange={(allRows) => onOptions({ ...options, allRows })}>Export all rows</MenuCheckbox>}
				<MenuCheckbox checked={options.includeMeta} onChange={(includeMeta) => onOptions({ ...options, includeMeta })}>Include confidence &amp; sources</MenuCheckbox>
			</div>
			<hr className={MENU_SEPARATOR} />
		</FloatingMenu>
	);
}

function showColumnItems(hidden: Column[], onShowColumns: (columnIds: string[]) => void): MenuItem[] {
	return [
		...hidden.map<MenuItem>((column) => ({ label: `Show “${column.name}”`, icon: <Eye />, onSelect: () => onShowColumns([column.id]) })),
		...(hidden.length > 1 ? [{ separator: true, label: '' }, { label: 'Show all columns', icon: <Eye />, onSelect: () => onShowColumns(hidden.map((column) => column.id)) }] : []),
	];
}

/** The phone layout's overflow menu: everything the compact action row hides, failed cells first. */
function MoreMenu({ anchor, onClose, onOpenFilter, addItems, onExport, showItems, hiddenCount, onMobileRename, failed, onRetryFailed }: { anchor: DOMRect; onClose: () => void; onOpenFilter: () => void; addItems: MenuItem[]; onExport: () => void; showItems: MenuItem[]; hiddenCount: number; onMobileRename: () => void; failed: number; onRetryFailed: () => void }) {
	return <FloatingMenu anchor={anchor} align="right" width="w-60" label="More actions" onClose={onClose} items={[
		...(failed ? [{ label: `Retry ${plural(failed, 'failed cell')}`, icon: <RotateCcw />, danger: true, onSelect: onRetryFailed }, { separator: true, label: '' }] : []),
		{ label: 'Filter', icon: <Filter />, onSelect: onOpenFilter },
		{ label: 'Add', icon: <Plus />, items: addItems },
		{ label: 'Export', icon: <Download />, onSelect: onExport },
		...(hiddenCount ? [{ label: `${plural(hiddenCount, 'hidden column')}`, icon: <EyeOff />, items: showItems }] : []),
		{ separator: true, label: '' },
		{ label: 'Rename sheet', icon: <Pencil />, onSelect: onMobileRename },
	]} />;
}

/** Export options outlive the menu, so reopening it keeps the last choices. The scope counts what the export will contain. */
function useExportMenu({ total, shownRows, selectedRows, hiddenColumns, onExport }: { total: number; shownRows: number; selectedRows: number; hiddenColumns: number; onExport: SheetToolbarProps['onExport'] }) {
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const [options, setOptions] = useState({ allRows: false, includeMeta: false });
	const subset = selectedRows > 0 || shownRows !== total;
	const allRows = options.allRows && subset;
	const summary = exportSummary({ rows: allRows ? total : shownRows, total, selected: options.allRows ? 0 : selectedRows, hiddenColumns });
	const toggle = (next?: DOMRect) => setAnchor((current) => current ? null : next ?? null);
	const menu = anchor && <ExportMenu anchor={anchor} summary={summary} subset={subset} options={options} onOptions={setOptions} onClose={() => setAnchor(null)} onExport={(format) => onExport(format, { allRows, includeMeta: options.includeMeta })} />;
	return { open: anchor !== null, toggle, menu };
}

/** Failed cells offer a retry; a run in progress shows its counts. Both give way to the paused-run banner. */
function RunStatus({ status, failed, onRetryFailed }: { status: SheetRunStatus; failed: number; onRetryFailed: () => void }) {
	if (status.halt) return null;
	return <>
		{failed > 0 && (
			<button type="button" onClick={onRetryFailed} aria-label={`Retry ${plural(failed, 'failed cell')}`} className="inline-flex h-6 items-center gap-1 rounded-full bg-danger-soft px-2.5 text-caption whitespace-nowrap text-danger-strong tabular transition-colors hover:bg-danger-line/50 max-md:hidden">
				{failed.toLocaleString()} failed<span aria-hidden className="text-danger-strong/50">·</span>Retry
			</button>
		)}
		{status.pending > 0 && (
			<span role="status" className="inline-flex h-6 items-center gap-1.5 rounded-full bg-blue-10 px-2.5 text-caption whitespace-nowrap text-brand tabular max-md:hidden">
				<span className="spinner" />
				{status.running > 0 && `${status.running.toLocaleString()} enriching`}
				{status.running > 0 && status.queued > 0 && ' · '}
				{status.queued > 0 && `${status.queued.toLocaleString()} queued`}
			</span>
		)}
	</>;
}

function TitleRow({ sheet, total, shownRows, history, runs, finding, onRename, onMobileRename }: Pick<SheetToolbarProps, 'sheet' | 'shownRows' | 'history' | 'runs' | 'finding' | 'onRename' | 'onMobileRename'> & { total: number }) {
	return (
		<div className="flex min-w-0 items-center gap-1">
			<NavigationButton className="-ml-1.5" />
			<Link href="/app" aria-label="Back to sheets" className="grid size-8 shrink-0 place-items-center rounded-lg text-fg-subtle hover:bg-tint/[0.05] hover:text-fg max-md:size-11">
				<ArrowLeft className="size-4" strokeWidth={1.5} />
			</Link>
			<SheetTitle key={sheet.id} name={sheet.name} onSave={onRename} onMobileRename={onMobileRename} />
			<IconButton label="Undo" title="Undo (⌘/Ctrl+Z)" disabled={history.busy || !history.undo} onClick={() => history.navigate('undo')}><Undo2 /></IconButton>
			<IconButton label="Redo" title="Redo (⌘/Ctrl+Shift+Z)" disabled={history.busy || !history.redo} onClick={() => history.navigate('redo')}><Redo2 /></IconButton>
			<span className="ml-2 flex min-w-0 items-center gap-1 text-caption text-fg-subtle tabular @max-3xl:hidden">
				<span className="shrink-0">{plural(total, 'row')} · {plural(sheet.columns.length, 'column')}{shownRows !== total && ` · ${shownRows.toLocaleString()} shown`}</span>
				{finding.running && <span role="status" className="truncate">· {finding.status}</span>}
			</span>
			<div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
				<CollaborationBar />
				<RunStatus status={runs.status} failed={runs.failed} onRetryFailed={runs.onRetryFailed} />
			</div>
		</div>
	);
}

function SelectionActions({ selectedRows, canRun, selection, exportOpen, onExport }: { selectedRows: number; canRun: boolean; selection: SheetToolbarProps['selection']; exportOpen: boolean; onExport: (anchor: DOMRect) => void }) {
	return (
		<div role="toolbar" aria-label="Selected rows" className="flex h-8 min-w-0 items-center gap-0.5 rounded-lg bg-blue-10 pr-0.5 pl-3 max-md:h-11 @max-3xl:flex-1">
			<span className="mr-1.5 text-body-sm whitespace-nowrap text-fg tabular">{selectedRows.toLocaleString()} selected</span>
			<SelectionButton label="Run unfinished cells" text="Run" disabled={!canRun} onClick={() => selection.onRun('unfinished')}><Play /></SelectionButton>
			<SelectionButton label="Re-run selected rows" text="Re-run" disabled={!canRun} onClick={() => selection.onRun('all')}><RefreshCw /></SelectionButton>
			<SelectionButton label="Export selected rows" text="Export" expanded={exportOpen} onClick={(event) => onExport(event.currentTarget.getBoundingClientRect())}><Download /></SelectionButton>
			<SelectionButton label="Delete selected rows" text="Delete" onClick={selection.onDelete}><Trash2 /></SelectionButton>
			<IconButton size="sm" label="Clear selection" onClick={selection.onClear} className="ml-auto text-fg-muted hover:bg-blue-20 @3xl:ml-1"><X /></IconButton>
		</div>
	);
}

/** One button that starts finding rows, then stops it; the label carries the running count. */
function FindRowsButton({ finding, buttonRef }: { finding: SheetToolbarProps['finding']; buttonRef: RefObject<HTMLButtonElement | null> }) {
	const { running, stopping } = finding;
	return (
		<Button
			ref={buttonRef}
			size="sm"
			variant="ghost"
			aria-label={running && !stopping ? 'Stop finding rows' : undefined}
			disabled={stopping || !running && finding.revealing}
			onClick={running ? finding.onStop : finding.onFind}
			className={running ? 'bg-blue-10 text-brand hover:bg-blue-20 hover:text-brand' : undefined}
		>
			{running ? <Square className="!size-3 fill-current" strokeWidth={1.5} /> : <Sparkles strokeWidth={1.5} />}
			{stopping ? 'Stopping…' : running ? <span className="tabular">Finding<span className="@max-3xl:hidden"> rows</span> · {finding.added.toLocaleString()}</span> : 'Find rows'}
		</Button>
	);
}

/** Title row, then one row of actions. Selecting rows swaps the actions for selection actions in place, so the grid never moves.
    The action row compacts by its own width (a container query), so a tablet beside the sidebar gets the phone layout. */
export function SheetToolbar({ sheet, allRows, shownRows, selectedRows, search, onSearch, filters, onFiltersChange, filterRequest, onOpenFilter, history, runs, finding, findButtonRef, addItems, onShowColumns, onExport, selection, onRename, onMobileRename, banner }: SheetToolbarProps) {
	const [more, setMore] = useState<DOMRect | null>(null);
	const moreButton = useRef<HTMLButtonElement>(null);
	const total = allRows.length;
	const filtered = shownRows !== total;
	const hidden = sheet.columns.filter((column) => column.hidden);
	const exporter = useExportMenu({ total, shownRows, selectedRows, hiddenColumns: hidden.length, onExport });
	const showItems = showColumnItems(hidden, onShowColumns);
	// A paused run's banner already counts and retries its failures.
	const failedHere = runs.status.halt ? 0 : runs.failed;

	return (
		<div className="@container flex shrink-0 flex-col gap-2 px-3 pt-3 pb-2">
			<TitleRow sheet={sheet} total={total} shownRows={shownRows} history={history} runs={runs} finding={finding} onRename={onRename} onMobileRename={onMobileRename} />

			<div className="flex h-8 min-w-0 items-center gap-1.5 max-md:h-11">
				<label className={clsx('flex h-8 w-56 min-w-0 items-center gap-2 rounded-lg border border-transparent bg-neutral-5 px-2.5 transition-colors focus-within:border-brand focus-within:bg-surface hover:border-line max-md:h-11 @max-3xl:flex-1', selectedRows > 0 && '@max-3xl:hidden')}>
					<Search className="size-3.5 shrink-0 text-fg-subtle" strokeWidth={1.5} />
					<input type="search" value={search} onChange={(event) => onSearch(event.target.value)} onKeyDown={(event) => event.key === 'Escape' && onSearch('')} placeholder="Search" aria-label="Search rows" className="min-w-0 flex-1 bg-transparent text-body-sm outline-none placeholder:text-fg-subtle" />
					{filtered && <span className="shrink-0 text-caption text-fg-subtle tabular @3xl:hidden">{shownRows.toLocaleString()} of {total.toLocaleString()}</span>}
				</label>
				<FilterMenu key={sheet.id} openRequest={filterRequest} sheet={sheet} filters={filters} onChange={onFiltersChange} allRows={allRows} shownRows={shownRows} totalRows={total} triggerClassName="@max-3xl:hidden" />
				{hidden.length > 0 && (
					<MenuButton align="left" width="w-60" className={clsx(buttonClassName('ghost', 'sm'), '@max-3xl:hidden')} items={showItems} label={`${plural(hidden.length, 'hidden column')}: show`}>
						<EyeOff strokeWidth={1.5} /> {hidden.length} hidden
					</MenuButton>
				)}
				<div className="flex-1 @max-3xl:hidden" />
				{selectedRows > 0 ? <SelectionActions selectedRows={selectedRows} canRun={runs.canRun} selection={selection} exportOpen={exporter.open} onExport={exporter.toggle} /> : <>
					<FindRowsButton finding={finding} buttonRef={findButtonRef} />
					<MenuButton align="right" width="w-56" className={clsx(buttonClassName('ghost', 'sm'), '@max-3xl:hidden')} items={addItems}>
						<Plus strokeWidth={1.5} /> Add <ChevronDown className="!size-3.5 text-fg-subtle" strokeWidth={1.5} />
					</MenuButton>
					<Button size="sm" variant="ghost" aria-haspopup="menu" aria-expanded={exporter.open} className="@max-3xl:hidden" onClick={(event) => exporter.toggle(event.currentTarget.getBoundingClientRect())}>
						<Download strokeWidth={1.5} /> Export
					</Button><Button ref={moreButton} size="sm" variant="ghost" aria-label="More actions" title={failedHere ? plural(failedHere, 'failed cell') : undefined} aria-haspopup="menu" aria-expanded={more !== null} className="relative w-11 px-0 @3xl:hidden" onClick={(event) => setMore(more ? null : event.currentTarget.getBoundingClientRect())}>
						<Ellipsis />{failedHere > 0 && <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger" />}
					</Button>
				</>}
			</div>
			{banner}

			{exporter.menu}
			{more && <MoreMenu anchor={more} onClose={() => setMore(null)} onOpenFilter={onOpenFilter} addItems={addItems} onExport={() => exporter.toggle(moreButton.current?.getBoundingClientRect())} showItems={showItems} hiddenCount={hidden.length} onMobileRename={onMobileRename} failed={failedHere} onRetryFailed={runs.onRetryFailed} />}
		</div>
	);
}
