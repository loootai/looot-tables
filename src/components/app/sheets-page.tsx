'use client';

import { createSheet, db, deleteSheet, duplicateSheet, emptyCell, id, newColumn, sheetSync, updateSheet } from '@/lib/db';
import { verifyKeys } from '@/lib/api';
import { ENTITY_COLUMNS, type PopulateRequest, type Row, type Sheet } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, NameDialog } from '@/components/ui/dialog';
import { MenuButton } from '@/components/ui/menu';
import { useToast } from '@/components/ui/toast';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUpRight, Copy, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import Dexie from 'dexie';
import { useRouter } from 'next/navigation';
import { useRef, useState, useSyncExternalStore } from 'react';
import { PageColumn } from './page-header';
import { useSettings } from './settings-context';
import { ImportCsvDialog } from '@/components/sheet/import-csv-dialog';
import { FindRowsComposer, type FindRowsDraft } from '@/components/sheet/populate-dialog';
import { FailureFix, type ConnectionIssue } from '@/components/sheet/halted-banner';
import { populateRunner } from '@/lib/populate-runner';
import { sheetNameFromPrompt } from '@/lib/populate-limit';
import { trackEvent } from '@/lib/analytics';
import { MAX_SHEETS } from '@/lib/workspace';

// The sheet page still imports NameDialog from here.
export { NameDialog };

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
const subscribeClock = (onTick: () => void) => {
	const timer = setInterval(onTick, 15_000);
	return () => clearInterval(timer);
};
/** Client-only (no server snapshot), so relative times never mismatch hydration, and they stay current. */
const useNow = () => useSyncExternalStore(subscribeClock, currentMinute, () => null);

function relativeTime(timestamp: number, now: number): string {
	const minutes = Math.round((now - timestamp) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days} d ago`;
	return dateFormat.format(timestamp);
}

const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

export function SheetsPage() {
	const { selfHosted, hasKeys, openKeys } = useSettings();
	const router = useRouter();
	const { toast } = useToast();
	const now = useNow();
	const sheets = useLiveQuery(() => db.sheets.orderBy('updatedAt').reverse().toArray(), []);
	const summaries = useLiveQuery(async () => {
		const map: Record<string, { count: number; rows: Row[] }> = {};
		const sheets = await db.sheets.toArray();
		await Promise.all(sheets.map(async (sheet) => {
			const sheetId = sheet.id;
			if (sheet.cloudSummary && sheetSync(sheet) !== 'synced') { map[sheetId] = { count: sheet.cloudSummary.rowCount, rows: sheet.cloudSummary.rows }; return; }
			const [count, rows] = await Promise.all([
				db.rows.where('sheetId').equals(sheetId).count(),
				db.rows.where('[sheetId+order]').between([sheetId, Dexie.minKey], [sheetId, Dexie.maxKey]).limit(3).toArray(),
			]);
			map[sheetId] = { count, rows };
		}));
		return map;
	}, []);
	const [dialog, setDialog] = useState<null | 'new' | 'import'>(null);
	const [renaming, setRenaming] = useState<Sheet | null>(null);
	const [deleting, setDeleting] = useState<Sheet | null>(null);
	const count = sheets?.length ?? 0;
	const full = count >= MAX_SHEETS;

	/** One empty row to type into, created with the sheet. */
	async function createBlank() {
		try {
			const columns = [newColumn({ name: 'Name', type: 'source' }), newColumn({ name: 'Website', type: 'source', format: 'url' })];
			const sheetId = id();
			const sheet = await createSheet(undefined, columns, { id: sheetId, rows: [{ id: id(), sheetId, order: 0, createdAt: Date.now(), cells: Object.fromEntries(columns.map((column) => [column.id, emptyCell()])) }] });
			trackEvent('sheet_created', { source: 'blank' });
			router.push(`/app/sheets/${sheet.id}`);
		} catch (error) { toast(message(error, 'Could not create a sheet.'), 'error'); }
	}

	/** The sheet exists only once the user asks for rows. Discovery keeps streaming into it after navigation. */
	async function findRows(request: PopulateRequest) {
		const taken = new Set(sheets?.map((sheet) => sheet.name.toLowerCase()));
		const base = sheetNameFromPrompt(request.query) || { companies: 'Companies', people: 'People', websites: 'Websites' }[request.entity];
		let name = base;
		for (let suffix = 2; taken.has(name.toLowerCase()); suffix++) name = `${base} ${suffix}`;
		const columns = ENTITY_COLUMNS[request.entity].map((column) => newColumn({ name: column.name, type: 'source', width: column.width, format: column.format }));
		const sheet = await createSheet(name, columns, { populate: request });
		trackEvent('sheet_created', { source: request.entity });
		trackEvent('rows_requested', { kind: request.entity });
		void populateRunner.start(sheet, request, { handoff: true });
		router.push(`/app/sheets/${sheet.id}?find=1&entity=${request.entity}`);
	}

	const starts = { onFind: findRows, needsKeys: !hasKeys, onNeedKeys: openKeys, onImport: () => setDialog('import'), onBlank: () => { setDialog(null); void createBlank(); } };

	return (
		<PageColumn>
			<header className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
					<div className="flex min-w-0 items-baseline gap-3">
						<h1 className="text-h4 text-fg">Sheets</h1>
						{sheets !== undefined && <span className={`text-body-sm tabular-nums ${full ? 'text-warning' : 'text-fg-subtle'}`}><span aria-hidden>{count} / {MAX_SHEETS} sheets</span><span className="sr-only">{count} of {MAX_SHEETS} sheets used</span></span>}
					</div>
					{!!count && <Button variant="brand" size="sm" disabled={full} onClick={() => setDialog('new')} className="max-sm:min-h-11"><Plus strokeWidth={1.75} /> New sheet</Button>}
				</div>
				{full && <p className="text-body-sm text-fg-muted">Your workspace holds up to {MAX_SHEETS} sheets. Delete one to make room for another.</p>}
			</header>
			{sheets === undefined ? (
				<div className="grid gap-5 sm:grid-cols-2">
					{[0, 1, 2].map((index) => <div key={index} className="skeleton h-64 rounded-xl" />)}
				</div>
			) : sheets.length === 0 ? (
				<section aria-labelledby="sheets-empty-title" className="flex flex-col items-center gap-7 pt-6 pb-10 sm:pt-14">
					<div className="flex max-w-lg flex-col items-center gap-2.5 text-center">
						<span aria-hidden className="mb-1 grid size-11 place-items-center rounded-xl bg-blue-10 text-brand"><Sparkles className="size-5" strokeWidth={1.5} /></span>
						<h2 id="sheets-empty-title" className="text-h3 tracking-[-0.02em] text-fg">Start with the rows you want</h2>
						<p className="text-body text-fg-muted">Describe a list and an agent finds it on the web, row by row. Then add AI columns that answer questions about each row.</p>
					</div>
					<div className="w-full max-w-2xl"><NewSheet {...starts} /></div>
				</section>
			) : (
				<ul aria-label="Sheets" className="grid grid-cols-1 gap-5 sm:grid-cols-2">
					{sheets.map((sheet) => {
						const aiColumns = sheet.columns.filter((column) => column.type === 'enriched').length;
						return (
							<li key={sheet.id} className="group relative min-w-0 rounded-xl border border-line bg-surface shadow-[0_2px_3px_-2px_rgb(0_0_0/0.06)] transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-[0_8px_24px_-12px_rgb(0_0_0/0.15)] focus-within:border-line-strong">
								<a href={`/app/sheets/${sheet.id}`} onClick={(event) => { event.preventDefault(); router.push(`/app/sheets/${sheet.id}`); }} className="flex h-full w-full min-w-0 flex-col rounded-xl p-5 pb-4">
									<span className="mb-5 flex flex-col gap-1 pr-11 sm:pr-8">
										<span className="truncate text-[19px] leading-7 font-medium tracking-[-0.035em] text-neutral-90">{sheet.name}</span>
										<span className="min-h-4 text-[11px] text-fg-subtle">{now !== null && `Edited ${relativeTime(sheet.updatedAt, now)}`}</span>
									</span>
									<SheetPreview sheet={sheet} rows={summaries?.[sheet.id]?.rows} />
									<span className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-2 text-[11px] leading-4 text-fg-subtle tabular-nums">
										<span>{summaries === undefined ? '—' : (summaries[sheet.id]?.count ?? 0).toLocaleString()} rows<span aria-hidden="true" className="mx-2 text-neutral-20">/</span>{sheet.columns.length} columns</span>
										<span className="flex items-center gap-3">
											{aiColumns > 0 && <span className="inline-flex items-center gap-1 text-fg-muted"><Sparkles aria-hidden="true" className="size-3 text-brand" strokeWidth={1.5} />{aiColumns} AI {aiColumns === 1 ? 'column' : 'columns'}</span>}
											<ArrowUpRight aria-hidden="true" className="size-3.5 text-neutral-30 transition-colors group-hover:text-fg group-focus-within:text-fg" strokeWidth={1.5} />
										</span>
									</span>
								</a>
								<div className="absolute top-3 right-3 sm:top-5 sm:right-4">
									<MenuButton
										align="right"
										label={`Actions for ${sheet.name}`}
										className="grid size-11 place-items-center rounded-md text-fg-subtle sm:size-7 transition-colors hover:bg-tint/[0.05] hover:text-fg"
										items={[
											{ label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(sheet) },
											{ label: 'Duplicate', icon: <Copy />, disabled: full, onSelect: () => void duplicateSheet(sheet.id).catch((error) => toast(message(error, 'Could not duplicate this sheet.'), 'error')) },
											{ separator: true, label: '' },
											{ label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setDeleting(sheet) },
										]}
									>
										<MoreHorizontal className="size-4" strokeWidth={1.75} />
									</MenuButton>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{dialog === 'new' && (
				<Dialog unframed title="New sheet" onClose={() => setDialog(null)} size="lg">
					<NewSheet {...starts} autoFocus onClose={() => setDialog(null)} />
				</Dialog>
			)}
			{dialog === 'import' && <ImportCsvDialog onClose={() => setDialog(null)} onImported={(sheetId) => router.push(`/app/sheets/${sheetId}`)} />}
			{renaming && <NameDialog title="Rename sheet" initial={renaming.name} confirmLabel="Rename" onClose={() => setRenaming(null)} onSubmit={(name) => updateSheet(renaming.id, { name })} />}
			{deleting && (
				<ConfirmDialog
					title={`Delete “${deleting.name}”?`}
					description={selfHosted ? 'This removes the sheet and all its rows. Export it first if you want a copy.' : 'This removes the sheet and all its rows for everyone in your workspace. Export it first if you want a copy.'}
					confirmLabel="Delete sheet"
					danger
					onClose={() => setDeleting(null)}
					onConfirm={async () => {
						await deleteSheet(deleting.id);
						toast(`Deleted “${deleting.name}”`);
					}}
				/>
			)}
		</PageColumn>
	);
}

/** A rejected looot token or OpenAI key, or an empty looot balance, found before a sheet exists for the search. A check that can't run never blocks. */
async function requiredKeyIssue(): Promise<{ error: string; issue: ConnectionIssue } | null> {
	try {
		const { looot, openai } = await verifyKeys({ only: ['looot', 'openai'] });
		if (!looot.ok && looot.issue) return { error: looot.message ?? 'looot rejected the token.', issue: { reason: looot.issue === 'key' ? 'credential_invalid' : 'credits_exhausted', provider: 'looot' } };
		if (looot.ok && looot.issue === 'balance') return { error: looot.message ?? 'Your looot balance is $0.', issue: { reason: 'credits_exhausted', provider: 'looot' } };
		if (!openai.ok && (openai.issue === 'key' || openai.issue === 'billing')) return { error: openai.message ?? 'OpenAI rejected the API key.', issue: { reason: openai.issue === 'key' ? 'credential_invalid' : 'credits_exhausted', provider: 'openai' } };
	} catch { /* The search reports the same problem with its fix. */ }
	return null;
}

/** Find rows into a new sheet, or start from a CSV or a blank sheet. */
function NewSheet({ onFind, needsKeys, onNeedKeys, onImport, onBlank, onClose, autoFocus }: { onFind: (request: PopulateRequest) => Promise<void>; needsKeys: boolean; onNeedKeys: () => void; onImport: () => void; onBlank: () => void; onClose?: () => void; autoFocus?: boolean }) {
	const [draft, setDraft] = useState<FindRowsDraft>({ entity: 'companies', query: '', countries: [] });
	const [state, setState] = useState<{ status: 'idle' | 'creating' } | { status: 'failed'; error: string; issue?: ConnectionIssue }>({ status: 'idle' });
	// One sheet per submit, even if Cmd+Enter and a click land before the busy state renders.
	const inFlight = useRef(false);
	async function submit(request: PopulateRequest) {
		if (inFlight.current) return;
		if (needsKeys) { onNeedKeys(); return; }
		inFlight.current = true;
		setState({ status: 'creating' });
		try {
			const problem = await requiredKeyIssue();
			if (problem) { setState({ status: 'failed', ...problem }); inFlight.current = false; return; }
			await onFind(request);
		} catch (error) { setState({ status: 'failed', error: message(error, 'Could not create the sheet. Try again.') }); inFlight.current = false; }
	}
	return (
		<FindRowsComposer draft={draft} onDraftChange={(next) => { setDraft(next); if (state.status === 'failed') setState({ status: 'idle' }); }} onSubmit={(request) => void submit(request)} busy={state.status === 'creating'} error={state.status === 'failed' ? state.error : null} errorAction={state.status === 'failed' && state.issue && <FailureFix issue={state.issue} />} onClose={onClose} autoFocus={autoFocus}>
			<p className="populate-shelf">
				<span>or</span>
				<button type="button" onClick={onImport}>Import CSV</button>
				<span aria-hidden>·</span>
				<button type="button" onClick={onBlank}>Blank sheet</button>
			</p>
		</FindRowsComposer>
	);
}

function SheetPreview({ sheet, rows }: { sheet: Sheet; rows?: Row[] }) {
	const columns = sheet.columns.slice(0, 3);
	return (
		<span aria-hidden="true" className="relative block h-[116px] w-full min-w-0 overflow-hidden rounded-md border border-line bg-canvas [mask-image:linear-gradient(to_bottom,black_65%,transparent)]">
			<span className="grid h-8 border-b border-line bg-neutral-5" style={{ gridTemplateColumns: `24px repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))` }}>
				<span className="border-r border-line-subtle" />
				{columns.map((column) => <span key={column.id} className="flex min-w-0 items-center gap-1.5 border-r border-line-subtle px-2 text-[10px] font-medium text-fg-muted last:border-r-0">{column.type === 'enriched' && <Sparkles className="size-2.5 shrink-0 text-brand" />}<span className="truncate">{column.name}</span></span>)}
			</span>
			{[0, 1, 2].map((index) => (
				<span key={index} className="grid h-7 border-b border-line-subtle bg-surface" style={{ gridTemplateColumns: `24px repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))` }}>
					<span className="flex items-center justify-center border-r border-line-subtle bg-neutral-5/50 font-mono text-[9px] text-neutral-30">{index + 1}</span>
					{columns.map((column) => {
						const value = rows?.[index]?.cells[column.id]?.v;
						const text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join(', ') : String(value);
						return <span key={column.id} className="truncate border-r border-line-subtle px-2 py-1.5 text-[10px] text-fg-subtle last:border-r-0">{text}</span>;
					})}
				</span>
			))}
			{rows?.length === 0 && <span className="absolute inset-x-6 top-12 text-center text-[10px] text-fg-subtle">No rows yet</span>}
		</span>
	);
}
