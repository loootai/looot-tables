'use client';

import { PersonAvatar } from './person-avatar';
import Image from 'next/image';
import { formatDate } from '@/lib/date-format';
import { isDocumentColumn, documentTitle } from '@/lib/document';
import { isEmailColumn, parseEmailDraft } from '@/lib/email-draft';
import { AdaptiveEntityGroup, EntityLabel } from './adaptive-entity-group';
import { entityKind, type EntityField } from '@/lib/entity-fields';
import { EntityFieldMenu } from './entity-field-menu';
import { organizationKind, OrganizationChip } from './organization-chip';
import { CellStatusLoader } from './cell-status-loader';
import { formatValue, toUrl } from '@/lib/template';
import { formatColumnNumber, isCheckboxColumn, webColumnKind, webColumnUrl } from '@/lib/column-format';
import { columnRole, roleColumn } from '@/lib/column-roles';
import { fundingLabel } from '@/lib/funding';
import type { Cell, CellValue, Column, Row } from '@/lib/types';
import { keyedItems } from '@/lib/detail-value';
import clsx from 'clsx';
import { AlertCircle, Check, ExternalLink, FileText, X } from 'lucide-react';
import { useContext } from 'react';
import { RunPausedContext } from './run-paused';
import { Waterfall } from './waterfall';
import { formatUsd } from '@/lib/endpoint-map';

function Pill({ tone, children, title, numeric = false }: { numeric?: boolean; tone: 'true' | 'false' | 'brand' | 'muted' | 'danger'; children: React.ReactNode; title?: string }) {
	return (
		<span
			title={title}
			className={clsx('inline-flex h-[22px] max-w-full items-center gap-1 rounded-full px-2 text-caption whitespace-nowrap tabular', numeric && 'ml-auto', {
				'bg-success-soft text-success': tone === 'true',
				'bg-neutral-5 text-fg-muted': tone === 'false' || tone === 'muted',
				'bg-blue-10 text-brand': tone === 'brand',
				'bg-danger-soft text-danger': tone === 'danger',
			})}
		>
			{children}
		</span>
	);
}

type EntityKind = NonNullable<ReturnType<typeof entityKind>>;
type CellViewProps = { onToggleCheckbox?: (value: boolean) => void; remainingRows?: number; totalRows?: number; onAddEntityColumn?: (source: Column, fields: EntityField[]) => void; cell: Cell | undefined; column: Column; row?: Row; columns?: Column[] };
type ValueProps = Omit<CellViewProps, 'cell' | 'onToggleCheckbox'> & { cell: Cell; value: NonNullable<CellValue> };
type EntityMenuProps = Pick<CellViewProps, 'column' | 'row' | 'remainingRows' | 'totalRows' | 'onAddEntityColumn'>;

const isBlank = (value: CellValue | undefined): value is null | undefined | '' => value === null || value === undefined || value === '';
const NUMBER_FORMATS = ['currency', 'percent', 'unit'];
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Renders one cell's content for the grid. Keeps a fixed row height; the detail panel shows the full value. */
export function CellView(props: CellViewProps) {
	const { cell, column, row, onToggleCheckbox } = props;
	if (!cell && column.format !== 'checkbox') return null;
	if (cell?.s === 'running' || cell?.s === 'queued') return <CellProgress status={cell.s} column={column} rowId={row?.id} />;
	if (cell?.s === 'error') return <CellError message={cell.e} />;
	if (isCheckboxColumn(column)) return <CheckboxCell column={column} cell={cell} onToggle={onToggleCheckbox} />;	const value = cell?.v;
	if (!cell || isBlank(value)) return cell?.s === 'done' ? column.type === 'enriched' ? <span data-miss className="num text-[11.5px] text-fg-subtle">Not found · {formatUsd(cell.m?.costUsd ?? 0)}</span> : <span className="text-caption text-fg-subtle">—</span> : null;
	if (column.op?.kind === 'email-enrichment' && typeof value === 'string') return <EmailValue email={value} status={cell.m?.verification} />;
	return <FormattedValue {...props} cell={cell} value={value} />;
}

function CellProgress({ status, column, rowId = '' }: { status: 'running' | 'queued'; column: Column; rowId?: string }) {
	const paused = useContext(RunPausedContext) && status === 'queued';	if (status === 'running' && !paused && column.type === 'enriched') return <Waterfall column={column} seed={`${rowId}:${column.id}`} />;
	return (
		<span className="inline-flex min-w-0 items-center text-body-sm text-fg-subtle" style={{ gap: 9 }}>
			<CellStatusLoader status={paused ? 'paused' : status} seed={`${rowId}:${column.id}`} />
			<span className="truncate">{status === 'running' ? runningLabel(column) : paused ? 'Paused' : 'Queued'}</span>
		</span>
	);
}

function CellError({ message }: { message?: string }) {
	return (
		<span className="inline-flex max-w-full items-center gap-1.5 text-caption text-fg-muted" title={message}>
			<AlertCircle className="size-3.5 shrink-0 text-danger" strokeWidth={1.75} />
			<span className="truncate">{message ?? 'Failed'}</span>
			<span className="shrink-0 rounded-full border border-danger-line px-1.5 text-[10.5px] text-danger-strong">retry</span>
		</span>
	);
}

const VERIFY: Record<string, { label: string; tone: string }> = {
	valid: { label: 'Valid', tone: 'bg-success-soft text-success' },
	catch_all: { label: 'Catch-all', tone: 'bg-warning-soft text-warning-strong' },
	risky: { label: 'Risky', tone: 'bg-warning-soft text-warning-strong' },
	unknown: { label: 'Unknown', tone: 'bg-neutral-5 text-fg-muted' },
	invalid: { label: 'Invalid', tone: 'bg-danger-soft text-danger-strong' },
};

/** A found work email in mono, with its checked status when the column verifies. Emerald only for Valid. */
function EmailValue({ email, status }: { email: string; status?: string }) {
	const verdict = status ? VERIFY[status] : undefined;
	return <span className="flex min-w-0 items-center gap-1.5">
		{verdict && <span data-verification={status} className={clsx('shrink-0 rounded-full px-1.5 text-[10.5px] font-medium leading-[18px]', verdict.tone)}>{verdict.label}</span>}
		<span className="num truncate text-fg">{email}</span>
	</span>;
}

function CheckboxCell({ column, cell, onToggle }: { column: Column; cell: Cell | undefined; onToggle?: (value: boolean) => void }) {
	return <label onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} className="relative z-[2] -mx-2.5 flex size-9 shrink-0 cursor-pointer items-center justify-center has-disabled:cursor-default">
		<input type="checkbox" aria-label={`${column.name} checkbox`} checked={cell?.v === true} disabled={!onToggle || Boolean(cell?.f)} onChange={(event) => onToggle?.(event.target.checked)} className="size-4 cursor-pointer accent-brand disabled:cursor-default" />
	</label>;
}

/** Values whose column format or operation decides their presentation; anything else renders by its entity or text. */
function FormattedValue(props: ValueProps) {
	const { cell, column, value } = props;
	if (column.format === 'date' && typeof value === 'string') return <span className="truncate tabular">{formatDate(value, column.dateFormat)}</span>;
	if (column.format === 'category') return <Pill tone="brand"><span className="truncate">{formatValue(value)}</span></Pill>;
	if (typeof value === 'number' && NUMBER_FORMATS.includes(column.format ?? '')) return <NumberValue value={value} column={column} />;
	if (isDocumentColumn(column)) return <DocumentChip value={value} column={column} />;
	if (isEmailColumn(column)) return <EmailDraftChip value={value} />;
	if (typeof value === 'boolean') return <ProbabilityPill tone={value ? 'true' : 'false'} cell={cell}>{value ? <Check className="size-3" strokeWidth={2.5} /> : <X className="size-3" strokeWidth={2.5} />}{String(value)}</ProbabilityPill>;
	if (column.op?.kind === 'classify' || column.op?.kind === 'score') return <ProbabilityPill tone="brand" cell={cell} numeric={typeof value === 'number'} confidence><span className="truncate">{formatValue(value)}</span></ProbabilityPill>;
	return <EntityValue {...props} />;
}

function NumberValue({ value, column }: { value: number; column: Column }) {	return <span className="num ml-auto min-w-0 truncate text-right">{formatColumnNumber(value, column)}</span>;
}

function DocumentChip({ value, column }: { value: NonNullable<CellValue>; column: Column }) {
	const title = documentTitle(String(value), column.name);
	return <span data-document-chip className="inline-flex max-w-full cursor-pointer"><Pill tone="muted" title={title}><FileText aria-hidden className="size-3 shrink-0" strokeWidth={1.75} /><span className="truncate">{title}</span></Pill></span>;
}

function EmailDraftChip({ value }: { value: NonNullable<CellValue> }) {
	const draft = parseEmailDraft(value);
	return <Pill tone="muted" title={draft.to ? `To: ${draft.to} · ${draft.subject || 'Email draft'}` : draft.subject || 'Email draft'}><Image src="/providers/email/gmail.svg" alt="" width={12} height={12} className="size-3 shrink-0 object-contain" /><span className="truncate">{draft.subject || (draft.to ? `Draft to ${draft.to}` : 'Email draft')}</span></Pill>;
}

/** A decided value with the model's probability (or, with `confidence`, its confidence) beside it. */
function ProbabilityPill({ tone, cell, numeric, confidence = false, children }: { tone: 'true' | 'false' | 'brand'; cell: Cell; numeric?: boolean; confidence?: boolean; children: React.ReactNode }) {
	const probability = confidence ? cell.m?.probability ?? cell.m?.confidence : cell.m?.probability;
	return (
		<Pill tone={tone} title={cell.m?.reasoning} numeric={numeric}>
			{children}
			{probability !== undefined && <span className="opacity-70">· {probability.toFixed(2)}</span>}
		</Pill>
	);
}

/** Lists, numbers, and entity values (organizations, people, websites); plain text and links otherwise. */
function EntityValue({ cell, column, row, columns, value, remainingRows, totalRows, onAddEntityColumn }: ValueProps) {
	const organization = organizationKind(column);
	const domain = organization ? organizationDomain(cell, row, columns, organization) : undefined;
	const entity = entityKind(column);
	const menu = { column, row, remainingRows, totalRows, onAddEntityColumn };
	if (Array.isArray(value)) return <ListValue items={value} organization={organization} entity={entity} domain={domain} />;
	if (typeof value === 'number') return <NumberValue value={value} column={column} />;
	const text = cellText(column, value);
	if (entity === 'website' || entity === 'webpage') return <WebsiteValue {...menu} kind={entity} text={text} />;
	if (entity === 'person') return <PersonValue {...menu} cell={cell} columns={columns} text={text} />;
	if (organization) return <AdaptiveEntityGroup><OrganizationChip name={text} kind={organization} domain={domain}>{entity && <EntityMenu {...menu} kind={entity} />}</OrganizationChip></AdaptiveEntityGroup>;
	if (entity) return <AdaptiveEntityGroup><Pill tone="muted" title={text}><EntityLabel name={text} /><EntityMenu {...menu} kind={entity} /></Pill></AdaptiveEntityGroup>;
	return <TextValue column={column} text={text} />;
}

/** The organization's domain: from its saved match, else the row's website (or school website) column. */
function organizationDomain(cell: Cell, row: Row | undefined, columns: Column[] | undefined, organization: 'company' | 'school') {
	if (cell.m?.organization?.name === cell.v) return cell.m.organization.domain;
	const domainColumn = columns && roleColumn(columns, organization === 'company' ? 'website' : 'school-website');
	const domain = domainColumn ? row?.cells[domainColumn.id]?.v : undefined;
	return typeof domain === 'string' ? domain : undefined;
}

// Also format previously saved discovery rows, without requiring another search.
function cellText(column: Column, value: Exclude<CellValue, null | string[]>) {
	const op = column.op;
	const isFundingLabel = op?.kind === 'company'
		? op.field === 'funding_stage' || op.field === 'funding_latest_round'
		: column.type === 'source' && /^(stage|current stage|latest round)$/i.test(column.name.trim());
	return isFundingLabel ? fundingLabel(String(value)) ?? '' : String(value);
}

function ListValue({ items, organization, entity, domain }: { items: string[]; organization: 'company' | 'school' | null; entity: EntityKind | null; domain?: string }) {
	const Group = organization || entity ? AdaptiveEntityGroup : 'span';
	return (
		<Group className="flex min-w-0 items-center gap-1 overflow-hidden">
			{keyedItems(items.slice(0, 4)).map(({ key, item }) => (
				organization ? <OrganizationChip key={key} name={item} kind={organization} domain={items.length === 1 ? domain : undefined} /> : (
					<span key={key} title={item} className={clsx("min-w-0 truncate rounded-md bg-neutral-5 px-1.5 py-0.5 text-caption text-fg-muted", !entity && "max-w-[160px]")}>{entity ? <EntityLabel name={item} /> : item}</span>
				)
			))}
			{items.length > 4 && <span className="shrink-0 text-caption text-fg-subtle">+{items.length - 4}</span>}
		</Group>
	);
}

/** "Add columns from this entity" for the grid; absent where new columns can't be added (the detail panel). */
function EntityMenu({ kind, column, row, remainingRows, totalRows, onAddEntityColumn }: EntityMenuProps & { kind: EntityKind }) {
	return onAddEntityColumn ? <EntityFieldMenu kind={kind} rowId={row?.id} remainingRows={remainingRows} totalRows={totalRows} onSelect={(fields) => onAddEntityColumn(column, fields)} /> : null;
}

function WebsiteValue({ kind, text, ...menu }: EntityMenuProps & { kind: 'website' | 'webpage'; text: string }) {
	const url = webColumnUrl(text);
	return <AdaptiveEntityGroup><span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-neutral-5 px-2 py-0.5 text-caption text-fg-muted">
		{url ? <a href={url.href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} title={url.href} className="num min-w-0 truncate hover:underline">{webColumnKind(menu.column) === 'website' ? url.hostname.replace(/^www\./, '') : text}</a> : <span className="truncate">{text}</span>}
		<EntityMenu {...menu} kind={kind} />
	</span></AdaptiveEntityGroup>;
}

function PersonValue({ cell, columns, text, ...menu }: EntityMenuProps & { cell: Cell; columns?: Column[]; text: string }) {
	return <AdaptiveEntityGroup><Pill tone="muted" title={text}><PersonAvatar src={personPhoto(cell, menu.column, menu.row, columns, text)} /><EntityLabel name={text} /><EntityMenu {...menu} kind="person" /></Pill></AdaptiveEntityGroup>;
}

/** The matched person's avatar, else a hand-entered row's photo column. */
function personPhoto(cell: Cell, column: Column, row: Row | undefined, columns: Column[] | undefined, text: string) {
	if (cell.m?.person?.name === text) return cell.m.person.avatarUrl;
	const photoColumn = columns && roleColumn(columns, 'photo');
	const photo = photoColumn && row?.cells[photoColumn.id]?.v;
	return column.type === 'source' && typeof photo === 'string' ? photo : null;
}

function TextValue({ column, text }: { column: Column; text: string }) {	if (columnRole(column) === 'email' && EMAIL_ADDRESS.test(text)) return <a href={`mailto:${text}`} onClick={event => event.stopPropagation()} className="num truncate text-fg hover:underline">{text}</a>;
	const url = isLinkColumn(column) || /^https?:\/\//i.test(text) ? toUrl(text) : null;
	if (!url) return <span className="truncate">{text}</span>;
	return (
		<a href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="group/link inline-flex max-w-full items-center gap-1 truncate text-fg-muted hover:text-brand" title={url}>
			<span className="truncate">{text.replace(/^https?:\/\/(www\.)?/, '')}</span>
			<ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100" strokeWidth={1.75} />
		</a>
	);
}

const isLinkColumn = ({ format, op }: Column) => format === 'url' || op?.kind === 'search' || (op?.kind === 'scrape' && op.mode === 'url');

function runningLabel(column: Column): string {
	switch (column.op?.kind) {
		case 'check':
		case 'classify':
		case 'score':
			return column.op.page ? 'Reading page…' : 'Deciding…';
		case 'scrape':
			return 'Reading page…';
		case 'search':
			return 'Searching…';
		case 'company':
			return 'Looking up…';
		case 'email-enrichment':
		case 'email-verify':
		case 'phone-find':
		case 'looot':
		case 'person':
			return 'Enriching…';
		case 'answer':
			return 'Researching…';
		case 'ai':
			return column.op.research === 'web' ? 'Researching…' : 'Thinking…';
		default:
			return 'Running…';
	}
}
