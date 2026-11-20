'use client';

import { categoryColor, categoryColorStyle } from '@/lib/category-colors';

import { isDocumentColumn } from '@/lib/document';
import { documentClientDomain } from '@/lib/document-branding';
import { DocumentPreview } from './document-preview';
import { LoootCalls } from './looot-calls';
import { EmailDraftAction } from './email-draft-action';
import { isEmailColumn, parseEmailDraft } from '@/lib/email-draft';
import { EmailDraftFields } from './email-draft-fields';
import { cellFromInput, cellInput } from '@/lib/formula-input';
import { useToast } from '@/components/ui/toast';
import { formatValue, toUrl } from '@/lib/template';
import { type Cell, type CellMeta, type Column, type EmailDraft, type Row, type Sheet } from '@/lib/types';
import { formatUsd } from '@/lib/endpoint-map';
import { Button, IconButton } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/field';
import { Copy, ExternalLink, Pencil, RefreshCw, X } from 'lucide-react';
import { type Dispatch, type ReactNode, type SetStateAction, useRef, useState, useSyncExternalStore } from 'react';
import { CellView } from './cell-view';
import { DetailValue } from './detail-value';
import { detailValue } from '@/lib/detail-value';
import { CompanyEditor } from './company-editor';
import { CompanyPreview } from './company-preview';
import { ImagePreviews } from './image-previews';
import { organizationKind } from '@/lib/organization-logo';

type SaveCell = (rowId: string, columnId: string, cell: Cell) => Promise<void>;

const subscribeNothing = () => () => {};
const isBusy = (cell: Cell | undefined) => cell?.s === 'running' || cell?.s === 'queued';
const panelWidth = (document: boolean, wide: boolean) => document ? 'w-[540px]' : wide ? 'w-[440px]' : 'w-[360px]';
const isCategoryEdit = (column: Column, cell: Cell | undefined) => column.format === 'category' && !cell?.f;

/** Details for the selected cell: value, probability, sources, reasoning, and actions. `errorAction` fixes a failed cell's cause (a lost connection). */
export function CellPanel({ sheet, row, column, onClose, onRerun, onEditColumn, onSave, errorAction }: { sheet: Sheet; row: Row; column: Column; onClose: () => void; onRerun: () => void; onEditColumn: () => void; onSave: SaveCell; errorAction?: ReactNode }) {
	const cell = row.cells[column.id];
	const [editing, setEditing] = useState(false);
	const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null);
	// Leave edit mode when a different cell is selected.
	const [editKey, setEditKey] = useState(`${row.id}:${column.id}`);
	if (editKey !== `${row.id}:${column.id}`) {
		setEditKey(`${row.id}:${column.id}`);
		setEditing(false);
		setEmailDraft(null);
	}
	const document = isDocumentColumn(column);
	const value = document ? cell?.v ?? null : detailValue(cell?.v);
	const structured = value !== null && typeof value === 'object';

	return (
		<aside aria-label="Cell details" className={`content-in absolute inset-y-0 right-0 z-30 flex h-full ${panelWidth(document, structured || isEmailColumn(column))} max-w-full flex-col border-l border-line bg-surface shadow-[var(--shadow-floating)] max-md:w-full`}>
			<CellPanelHeader sheet={sheet} row={row} column={column} cell={cell} emailDraft={emailDraft} onClose={onClose} />
			<div className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-4">
				<CellPanelMain sheet={sheet} row={row} column={column} cell={cell} value={value} structured={structured} editing={editing} setEditing={setEditing} emailDraft={emailDraft} setEmailDraft={setEmailDraft} onSave={onSave} errorAction={errorAction} />
				{!editing && organizationKind(column) === 'company' && <CompanyPreview row={row} column={column} columns={sheet.columns} />}
				{cell?.f && <section className="flex flex-col gap-2"><h4 className="text-caption text-fg-subtle">Formula</h4><code className="break-all text-body-sm text-fg">{cell.f}</code></section>}
				<ProbabilitySection meta={cell?.m} column={column} />
				<WhySection meta={cell?.m} />
				<UsageSection cell={cell} />
				<LoootCalls calls={cell?.m?.looot} moltsets={cell?.m?.moltsets} />
				<SourcesSection meta={cell?.m} />
			</div>
			{column.op && (
				<div className="flex items-center gap-2 border-t border-line-subtle px-4 py-3">
					<Button size="sm" variant="brand" onClick={onRerun} disabled={isBusy(cell)}>
						<RefreshCw strokeWidth={1.75} /> Re-run cell
					</Button>
					<Button size="sm" onClick={onEditColumn}>
						Edit AI column
					</Button>
				</div>
			)}
		</aside>
	);
}

function CellPanelHeader({ sheet, row, column, cell, emailDraft, onClose }: { sheet: Sheet; row: Row; column: Column; cell: Cell | undefined; emailDraft: EmailDraft | null; onClose: () => void }) {
	const rowLabel = formatValue(row.cells[sheet.columns[0]?.id]?.v) || `Row ${row.order + 1}`;
	return (
		<div className="flex items-center gap-3 border-b border-line-subtle px-4 py-3">
			<div className="min-w-0 flex-1">
				<h3 className="truncate text-body font-medium text-fg" title={column.name}>{column.name}</h3>
				<p className="mt-0.5 truncate text-caption text-fg-subtle" title={rowLabel}>{rowLabel}{cell?.m?.model ? ` · ${cell.m.model}` : ''}</p>
			</div>
			{isEmailColumn(column) && <EmailDraftAction draft={emailDraft ?? parseEmailDraft(cell?.v)} disabled={isBusy(cell)} />}
			<IconButton label="Close" onClick={onClose} className="-mr-1">
				<X strokeWidth={1.5} />
			</IconButton>
		</div>
	);
}

type MainProps = { sheet: Sheet; row: Row; column: Column; cell: Cell | undefined; value: unknown; structured: boolean; editing: boolean; setEditing: (editing: boolean) => void; emailDraft: EmailDraft | null; setEmailDraft: Dispatch<SetStateAction<EmailDraft | null>>; onSave: SaveCell; errorAction?: ReactNode };

/** Email drafts and finished documents edit in place; every other cell shows its value with an Edit action. */
function CellPanelMain({ sheet, row, column, cell, emailDraft, setEmailDraft, onSave, ...section }: MainProps) {
	if (isEmailColumn(column)) return <EmailDraftFields key={`${row.id}:${column.id}`} cell={cell} draft={emailDraft} setDraft={setEmailDraft} onSave={(next) => onSave(row.id, column.id, next)} />;
	if (isDocumentColumn(column) && cell?.s !== 'error' && !isBusy(cell)) return <DocumentPreview key={`${row.id}:${column.id}`} clientDomain={documentClientDomain(sheet, row)} markdown={typeof cell?.v === 'string' ? cell.v : ''} title={column.name} onSave={(markdown) => onSave(row.id, column.id, { v: markdown, s: 'done', t: Date.now(), m: { ...cell?.m, reasoning: 'Edited by hand' } })} />;
	return <ValueSection row={row} column={column} cell={cell} onSave={onSave} {...section} />;
}

function ValueSection({ row, column, cell, value, structured, editing, setEditing, onSave, errorAction }: Omit<MainProps, 'sheet' | 'emailDraft' | 'setEmailDraft'>) {
	return <section className="flex flex-col gap-2">
		<div className="flex items-center justify-between">
			<h4 className="text-caption text-fg-subtle">Value</h4>
			{!editing && (
				<div className="flex items-center gap-3">
					{structured && !isDocumentColumn(column) && <CopyJsonButton value={value} />}
					<button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 text-caption text-fg-muted hover:text-fg">
						<Pencil className="size-3" strokeWidth={1.75} /> Edit
					</button>
				</div>
			)}
		</div>
		{editing ? <CellEditor row={row} column={column} cell={cell} onSave={onSave} onDone={() => setEditing(false)} />
			: cell?.s === 'error' ? (
				<div className="flex flex-col items-start gap-2 rounded-lg bg-danger-soft px-3 py-2">
					<p className="text-body-sm break-words text-danger-strong">{cell.e}</p>
					{errorAction}
				</div>
			) : <ValueDisplay row={row} column={column} cell={cell} value={value} structured={structured} />}
	</section>;
}

function CopyJsonButton({ value }: { value: unknown }) {
	const { toast } = useToast();
	async function copyJson() {
		try {
			await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
			toast('JSON copied');
		} catch {
			toast('Could not copy JSON', 'error');
		}
	}
	return <button type="button" onClick={() => void copyJson()} className="inline-flex items-center gap-1 text-caption text-fg-muted hover:text-fg"><Copy aria-hidden className="size-3" strokeWidth={1.75} /> Copy JSON</button>;
}

function ValueDisplay({ row, column, cell, value, structured }: { row: Row; column: Column; cell: Cell | undefined; value: unknown; structured: boolean }) {
	const busy = isBusy(cell);
	return (
		<div className={`min-w-0 text-body-sm break-words text-fg ${busy ? 'flex items-center rounded-lg bg-neutral-5 px-3 py-2' : structured || isDocumentColumn(column) ? '-mx-1' : 'rounded-lg bg-neutral-5 px-3 py-3'}`}>
			{busy ? <CellView cell={cell} column={column} /> : column.op?.kind === 'scrape' && column.op.mode === 'images' ? <ImagePreviews key={`${row.id}:${column.id}`} value={value} /> : <DetailValue key={`${row.id}:${column.id}`} value={value} />}
		</div>
	);
}

/** Mounted by Edit, so the draft starts from the cell's value at that moment. */
function CellEditor({ row, column, cell, onSave, onDone }: { row: Row; column: Column; cell: Cell | undefined; onSave: SaveCell; onDone: () => void }) {
	const { toast } = useToast();
	const [draft, setDraft] = useState(() => isCategoryEdit(column, cell) ? String(cell?.v || column.categoryOptions?.[0] || '') : cellInput(cell));
	// The picked company only matters when saving; typing over it clears it.
	const company = useRef(cell?.m?.organization);

	async function saveDraft() {
		try {
			const picked = company.current;
			const next = picked ? { v: picked.name, s: 'done' as const, t: Date.now() } : cellFromInput(isCategoryEdit(column, cell) ? `'${draft}` : draft, column);
			await onSave(row.id, column.id, { ...next, m: next.f ? undefined : { ...cell?.m, organization: picked, reasoning: 'Edited by hand' } });
		} catch (error) {
			toast(error instanceof Error ? error.message : 'Could not save cell', 'error');
			return;
		}
		onDone();
	}

	return (
		<div className="flex flex-col gap-2">
			{isCategoryEdit(column, cell) ? <Select aria-label="Cell category" value={draft || column.categoryOptions?.[0] || ''} onValueChange={setDraft}>{column.categoryOptions?.map((option) => <option key={option} value={option}><span className="inline-flex max-w-full items-center rounded-full px-2 py-0.5" style={categoryColorStyle(categoryColor(column, option))}>{option}</span></option>)}</Select>
				: organizationKind(column) === 'company' && !cell?.f ? <CompanyEditor value={draft} onChange={(value) => { setDraft(value); company.current = undefined; }} onSelect={(value) => { setDraft(value.name); company.current = value; }} onCommit={() => void saveDraft()} onCancel={onDone} />
				: <Textarea aria-label="Cell value" rows={isDocumentColumn(column) ? 18 : 4} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void saveDraft(); if (event.key === 'Escape') onDone(); }} />}
			<div className="flex justify-end gap-2">
				<Button size="xs" onClick={onDone}>
					Cancel
				</Button>
				<Button size="xs" variant="brand" onClick={() => void saveDraft()}>
					Save
				</Button>
			</div>
		</div>
	);
}

function ProbabilitySection({ meta, column }: { meta: CellMeta | undefined; column: Column }) {
	const probability = meta?.probability ?? meta?.confidence;
	if (probability === undefined) return null;
	return (
		<section className="flex flex-col gap-2">
			<h4 className="text-caption text-fg-subtle">{meta?.probability !== undefined && column.op?.kind === 'check' ? 'Probability of yes' : 'Confidence'}</h4>
			<div className="flex items-center gap-3">
				<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-10">
					<div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(probability * 100)}%` }} />
				</div>
				<span className="text-body-sm tabular">{probability.toFixed(2)}</span>
			</div>
			{meta?.probabilities && (
				<ul className="mt-1 flex flex-col gap-1">
					{Object.entries(meta.probabilities)
						.sort((a, b) => b[1] - a[1])
						.map(([label, p]) => (
							<li key={label} className="flex items-center justify-between gap-3 text-caption">
								<span className="truncate text-fg-muted">{label}</span>
								<span className="tabular text-fg">{p.toFixed(2)}</span>
							</li>
						))}
				</ul>
			)}
		</section>
	);
}

function WhySection({ meta }: { meta: CellMeta | undefined }) {
	if (!meta?.reasoning) return null;
	return (
		<section className="flex flex-col gap-2">
			<h4 className="text-caption text-fg-subtle">Why</h4>
			<p className="text-body-sm leading-relaxed text-fg-muted">{meta.reasoning}</p>
		</section>
	);
}

function SourcesSection({ meta }: { meta: CellMeta | undefined }) {
	if (!meta?.sources?.length && !meta?.pageUrl) return null;
	return (
		<section className="flex flex-col gap-2">
			<h4 className="text-caption text-fg-subtle">Sources</h4>
			<ul className="flex flex-col gap-1">
				{[...new Set([meta.pageUrl, ...(meta.sources ?? [])].filter((s): s is string => Boolean(s)))].map((source) => <SourceLink key={source} source={source} />)}
			</ul>
		</section>
	);
}

function SourceLink({ source }: { source: string }) {
	const url = toUrl(source);
	return (
		<li className="min-w-0">
			{url ? (
				<a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-caption text-brand hover:underline">
					<span className="truncate">{source.replace(/^https?:\/\/(www\.)?/, '')}</span>
					<ExternalLink className="size-3 shrink-0" strokeWidth={1.75} />
				</a>
			) : (
				<span className="text-caption text-fg-muted">{source}</span>
			)}
		</li>
	);
}

/** What the cell cost in USD, how long it took, and when the value was written. */
function UsageSection({ cell }: { cell: Cell | undefined }) {
	const meta = cell?.m;
	if (meta?.costUsd === undefined && meta?.durationMs === undefined) return null;
	return (		<section aria-label="Run totals" className="grid grid-cols-3 gap-2 rounded-lg bg-neutral-5 px-3 py-2">
			<span className="flex flex-col"><span className="text-[10.5px] text-fg-subtle">Cost</span><span className="num text-fg">{formatUsd(meta.costUsd ?? 0)}</span></span>
			<span className="flex flex-col"><span className="text-[10.5px] text-fg-subtle">Time</span><span className="num text-fg">{meta.durationMs !== undefined ? `${(meta.durationMs / 1000).toFixed(1)} s` : '—'}</span></span>
			<span className="flex min-w-0 flex-col"><span className="text-[10.5px] text-fg-subtle">Settled</span><span className="num truncate text-fg">{cell?.t ? <LocalTime time={cell.t} /> : '—'}</span></span>
		</section>
	);
}

// The viewer's locale and time zone only exist in the browser, so a server pass renders no text.
function LocalTime({ time }: { time: number }) {
	const text = useSyncExternalStore(subscribeNothing, () => new Date(time).toLocaleString(), () => '');
	return <span>{text}</span>;
}
