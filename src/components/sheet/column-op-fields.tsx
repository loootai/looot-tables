'use client';

import { useId, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { GripVertical, Plus, X } from 'lucide-react';
import { clampNumber, fromListRows, parseCommaList, parseListLines, toListRows, type ListItem, type ListRow } from '@/lib/list-input';
import { keyHeaders } from '@/lib/keys';
import { formatUsd, suggestInputMap } from '@/lib/endpoint-map';
import { type Column, type ColumnOp, type ContactSource, type EmailPreference, type OpKind, OUTPUT_TYPES, type PageSource } from '@/lib/types';
import { useSettings } from '@/components/app/settings-context';
import { isReady } from '@/components/app/providers';
import { Button, IconButton } from '@/components/ui/button';
import { Field, Input, Select, Switch } from '@/components/ui/field';
import { HelpTooltip } from '@/components/ui/help-tooltip';
import { Sortable, SortableItem, SortableItemHandle } from '@/components/ui/sortable';
import { ColumnPrompt } from './column-prompt';

type OpOf<K extends OpKind> = Extract<ColumnOp, { kind: K }>;
interface Shared { columns: Column[]; domainColumn?: string; jevAvailable: boolean }
interface FieldsProps<K extends OpKind> extends Shared { op: OpOf<K>; set: (patch: Partial<OpOf<K>>) => void }

const COMPANY_FIELDS: Array<{ value: OpOf<'company'>['field']; label: string }> = [
	{ value: 'description', label: 'Description' },
	{ value: 'title', label: 'Name' },
	{ value: 'slogan', label: 'Slogan' },
	{ value: 'industry', label: 'Industry' },
	{ value: 'employees', label: 'Employees' },
	{ value: 'city', label: 'City' },
	{ value: 'country', label: 'Country' },
	{ value: 'address', label: 'Address' },
	{ value: 'email', label: 'Email' },
	{ value: 'phone', label: 'Phone' },
	{ value: 'ticker', label: 'Stock ticker' },
	{ value: 'linkedin', label: 'LinkedIn URL' },
	{ value: 'twitter', label: 'X / Twitter URL' },
	{ value: 'pricing_url', label: 'Pricing page URL' },
	{ value: 'careers_url', label: 'Careers page URL' },
	{ value: 'blog_url', label: 'Blog URL' },
	{ value: 'contact_url', label: 'Contact page URL' },
	{ value: 'logo_url', label: 'Logo URL' },
	{ value: 'primary_color', label: 'Primary brand color' },
	{ value: 'language', label: 'Primary language' },
	{ value: 'funding_total', label: 'Total raised (USD)' },
	{ value: 'funding_stage', label: 'Current stage' },
	{ value: 'funding_latest_round', label: 'Latest round' },
	{ value: 'funding_latest_date', label: 'Latest round date' },
	{ value: 'funding_latest_amount', label: 'Latest round amount (USD)' },
	{ value: 'funding_round_count', label: 'Round count' },
];
const PERSON_FIELDS: Array<{ value: OpOf<'person'>['field']; label: string }> = [
	{ value: 'title', label: 'Current title' },
	{ value: 'company', label: 'Current company' },
	{ value: 'company_domain', label: 'Company domain' },
	{ value: 'location', label: 'Location' },
	{ value: 'linkedin', label: 'LinkedIn URL' },
	{ value: 'email', label: 'Email' },
	{ value: 'bio', label: 'Bio' },
	{ value: 'schools', label: 'Schools' },
	{ value: 'degrees', label: 'Degrees' },
	{ value: 'experience', label: 'Experience' },
	{ value: 'skills', label: 'Skills' },
	{ value: 'years_at_company', label: 'Years at current company' },
	{ value: 'full_name', label: 'Full name' },
];
const SCRAPE_MODES: Array<{ value: OpOf<'scrape'>['mode']; label: string }> = [
	{ value: 'highlights', label: 'Passages relevant to a query' },
	{ value: 'extract', label: 'Extracted fields' },
	{ value: 'markdown', label: 'Markdown' },
	{ value: 'links', label: 'Links on the page' },
	{ value: 'images', label: 'Image URLs' },
	{ value: 'emails', label: 'Email addresses' },
	{ value: 'phone-numbers', label: 'Phone numbers' },
	{ value: 'title', label: 'Page title' },
	{ value: 'url', label: 'Just the page URL' },
];

/** Fields for one operation. Keyed by the caller, so local drafts reset whenever the operation is replaced. */
export function OpFields({ op, onChange, ...shared }: Shared & { op: ColumnOp; onChange: (op: ColumnOp) => void }) {
	const set = (patch: Partial<ColumnOp>) => onChange({ ...op, ...patch } as ColumnOp);
	switch (op.kind) {
		case 'email-draft': return <EmailDraftFields op={op} set={set} {...shared} />;
		case 'ai': return <AskFields op={op} set={set} {...shared} />;
		case 'check': return <CheckFields op={op} set={set} {...shared} />;
		case 'classify': return <ClassifyFields op={op} set={set} {...shared} />;
		case 'score': return <ScoreFields op={op} set={set} {...shared} />;
		case 'scrape': return <ScrapeFields op={op} set={set} {...shared} />;
		case 'search': return <SearchFields op={op} set={set} {...shared} />;
		case 'company': return <CompanyFields op={op} set={set} {...shared} />;
		case 'person': return <PersonFields op={op} set={set} {...shared} />;
		case 'email-enrichment': return <FindEmailFields op={op} set={set} {...shared} />;
		case 'email-verify': return <VerifyEmailFields op={op} set={set} {...shared} />;
		case 'phone-find': return <FindPhoneFields op={op} set={set} {...shared} />;
		case 'looot': return <LoootFields op={op} set={set} {...shared} />;
		case 'answer': return <ResearchFields op={op} set={set} {...shared} />;
		case 'template': return <Field label="Template" help="Combine columns; no API calls. e.g. https://{{Website}}/pricing">{(id) => <ColumnPrompt id={id} rows={1} columns={shared.columns} value={op.template} onChange={(template) => set({ template })} placeholder="{{Name}} <{{Email}}>" />}</Field>;
	}
}

function PromptField({ label, help, value, onChange, columns, rows = 1, placeholder }: { label: string; help?: string; value: string; onChange: (value: string) => void; columns: Column[]; rows?: number; placeholder?: string }) {
	return <Field label={label} help={help}>{(id) => <ColumnPrompt id={id} rows={rows} columns={columns} value={value} onChange={onChange} placeholder={placeholder} />}</Field>;
}

function EmailDraftFields({ op, set, columns }: FieldsProps<'email-draft'>) {
	const ai = op.mode === 'ai';
	return <>
		<Field label="Draft with">{(id) => <Select id={id} value={op.mode} onValueChange={(value) => set({ mode: value as 'ai' | 'template' })}><option value="ai">AI</option><option value="template">Template from columns</option></Select>}</Field>
		{ai && <PromptField label="Instructions" columns={columns} rows={3} value={op.prompt} onChange={(prompt) => set({ prompt })} placeholder="Draft an email to {{Name}} introducing our product" />}
		<PromptField label="To" columns={columns} value={op.to} onChange={(to) => set({ to })} placeholder="{{Email}}" />
		<details className="group/recipients">
			<summary className="cursor-pointer text-body-sm text-fg-muted hover:text-fg">Cc / Bcc</summary>
			<div className="mt-3 flex flex-col gap-3">
				<PromptField label="Cc" columns={columns} value={op.cc} onChange={(cc) => set({ cc })} />
				<PromptField label="Bcc" columns={columns} value={op.bcc} onChange={(bcc) => set({ bcc })} />
			</div>
		</details>
		<PromptField label="Subject" columns={columns} value={op.subject} onChange={(subject) => set({ subject })} placeholder={ai ? 'Let AI write the subject' : 'Hello {{Name}}'} />
		<PromptField label="Body" columns={columns} rows={6} value={op.body} onChange={(body) => set({ body })} placeholder={ai ? 'Let AI write the body' : 'Hi {{Name}},'} />
		<p className="text-caption text-fg-subtle">Type / to insert a column. A formula can also make drafts: set the column’s format to Email draft and return To:, Subject: and Body: lines.</p>
	</>;
}

function AskFields({ op, set, columns, domainColumn }: FieldsProps<'ai'>) {
	return <>
		<PromptField label="Question" help="Type / to insert a column, cell or range; otherwise the whole row is sent. Use $ to lock coordinates, e.g. $A$1." columns={columns} rows={3} value={op.prompt} onChange={(prompt) => set({ prompt })} placeholder="Who is the CEO of {{Company}}?" />
		<div className="grid gap-4 sm:grid-cols-2">
			<OutputField value={op.output} onChange={(output) => set({ output })} />
			<Field label="Research">{(id) => <Select id={id} value={op.research} onValueChange={(value) => set({ research: value as 'none' | 'web' })}><option value="web">Search and read the web (looot)</option><option value="none">Row only, no web</option></Select>}</Field>
		</div>
		<PageField label="Read a page first" page={op.page} optional columns={columns} domainColumn={domainColumn} onChange={(page) => set({ page })} />
	</>;
}

function CheckFields({ op, set, columns, domainColumn, jevAvailable }: FieldsProps<'check'>) {
	return <>
		<PromptField label="True/false question" help="Asked against the row and, when set, the page below." columns={columns} rows={2} value={op.question} onChange={(question) => set({ question })} placeholder="Does this pricing page offer a free tier?" />
		<PageField label="Read a page first" page={op.page} optional columns={columns} domainColumn={domainColumn} onChange={(page) => set({ page })} />
		<div className="grid gap-4 sm:grid-cols-3">
			<DeciderField value={op.decider} onChange={(decider) => set({ decider })} jevAvailable={jevAvailable} />
			<NumberField label="True threshold" help="Probability at or above which the cell is true (0.05–0.95)." value={op.threshold} min={0.05} max={0.95} step={0.05} onChange={(threshold) => set({ threshold })} />
			<Field label="Exact text (optional)" help="Skip the model: true when the page contains this text.">{(id) => <Input id={id} value={op.literal ?? ''} onChange={(event) => set({ literal: event.target.value || undefined })} placeholder="free tier" />}</Field>
		</div>
	</>;
}

function ClassifyFields({ op, set, columns, domainColumn, jevAvailable }: FieldsProps<'classify'>) {
	return <>
		<PromptField label="Question" columns={columns} rows={2} value={op.question} onChange={(question) => set({ question })} placeholder="Which segment does this company belong to?" />
		<ListEditor label="Options" help="Each row gets exactly one option. A short description helps the model choose." item="Option" detail="Description (optional)" placeholders={['e.g. Strong fit', 'e.g. Weak fit']} detailPlaceholder="e.g. B2B SaaS with 50–500 employees" minRows={2} max={20}
			items={op.options.map((option) => ({ label: option.label, detail: option.description }))} onChange={(items) => set({ options: items.map((item) => ({ label: item.label, description: item.detail })) })} />
		<PageField label="Read a page first" page={op.page} optional columns={columns} domainColumn={domainColumn} onChange={(page) => set({ page })} />
		<DeciderField value={op.decider} onChange={(decider) => set({ decider })} jevAvailable={jevAvailable} />
	</>;
}

function ScoreFields({ op, set, columns, domainColumn, jevAvailable }: FieldsProps<'score'>) {
	return <>
		<PromptField label="Question" columns={columns} rows={2} value={op.question} onChange={(question) => set({ question })} placeholder="How mature is this company's developer documentation?" />
		<ListEditor label="Levels, lowest to highest" help="Drag to reorder. The first level is the lowest score." item="Level" placeholders={['e.g. None', 'e.g. Basic', 'e.g. Thorough']} minRows={2} max={10}
			items={op.levels.map((label) => ({ label }))} onChange={(items) => set({ levels: items.map((item) => item.label) })} />
		<PageField label="Read a page first" page={op.page} optional columns={columns} domainColumn={domainColumn} onChange={(page) => set({ page })} />
		<DeciderField value={op.decider} onChange={(decider) => set({ decider })} jevAvailable={jevAvailable} />
	</>;
}

function ScrapeFields({ op, set, columns, domainColumn }: FieldsProps<'scrape'>) {
	const sized = op.mode === 'highlights' || op.mode === 'markdown';
	return <>
		<PageField label="Page" page={op.page} columns={columns} domainColumn={domainColumn} onChange={(page) => page && set({ page })} />
		<div className="grid gap-4 sm:grid-cols-2">
			<Field label="Keep">{(id) => <Select id={id} value={op.mode} onValueChange={(value) => set({ mode: value as OpOf<'scrape'>['mode'] })}>{SCRAPE_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</Select>}</Field>
			{sized && <NumberField label="Max characters" value={op.maxChars} min={100} max={20000} step={100} integer onChange={(maxChars) => set({ maxChars })} />}
		</div>
		{(op.mode === 'highlights' || op.mode === 'extract') && <PromptField label={op.mode === 'highlights' ? 'Query' : 'Instructions (optional)'} columns={columns} value={op.query ?? ''} onChange={(query) => set({ query: query || undefined })} placeholder={op.mode === 'highlights' ? 'pricing tiers and free plan' : 'Prefer the monthly price'} />}
		{op.mode === 'extract' && <ListEditor label="Fields" help="Name each value to pull from the page. Add instructions above instead if you prefer." item="Field" detail="What it is (optional)" placeholders={['e.g. starting_price', 'e.g. free_plan']} detailPlaceholder="e.g. the lowest monthly price" minRows={1} max={20} maxLength={60}
			items={(op.fields ?? []).map((field) => ({ label: field.name, detail: field.description }))} onChange={(items) => set({ fields: items.length ? items.map((item) => ({ name: item.label, description: item.detail })) : undefined })} />}
	</>;
}

function SearchFields({ op, set, columns }: FieldsProps<'search'>) {
	return <>
		<PromptField label="Search query" help="A template; {{Company}} and friends are filled per row." columns={columns} value={op.query} onChange={(query) => set({ query })} placeholder="{{Company}} crunchbase" />
		<div className="grid gap-4 sm:grid-cols-3">
			<Field label="Keep">{(id) => <Select id={id} value={op.pick} onValueChange={(value) => set({ pick: value as OpOf<'search'>['pick'] })}><option value="url">First result URL</option><option value="title">First result title</option><option value="snippet">First result snippet</option><option value="list">List of result URLs</option></Select>}</Field>
			<NumberField label="Results" value={op.numResults} min={1} max={10} step={1} integer onChange={(numResults) => set({ numResults })} />
			<DomainsField value={op.includeDomains} onChange={(includeDomains) => set({ includeDomains })} />
		</div>
	</>;
}

function CompanyFields({ op, set, columns }: FieldsProps<'company'>) {
	return <div className="grid gap-4 sm:grid-cols-2">
		<PromptField label="Domain" help="A column reference or template." columns={columns} value={op.domain} onChange={(domain) => set({ domain })} placeholder="{{Website}}" />
		<Field label="Field">{(id) => <Select id={id} value={op.field} onValueChange={(value) => set({ field: value as OpOf<'company'>['field'] })}>{COMPANY_FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</Select>}</Field>
	</div>;
}

function PersonFields({ op, set, columns }: FieldsProps<'person'>) {
	const text = (key: 'name' | 'company' | 'email' | 'profileUrl') => (value: string) => set({ [key]: value || undefined });
	return <>
		<div className="grid gap-4 sm:grid-cols-2">
			<PromptField label="Name" columns={columns} value={op.name ?? ''} onChange={text('name')} placeholder="{{Name}}" />
			<PromptField label="Company (name or domain)" columns={columns} value={op.company ?? ''} onChange={text('company')} placeholder="{{Company}}" />
			<PromptField label="Email" columns={columns} value={op.email ?? ''} onChange={text('email')} placeholder="{{Email}}" />
			<PromptField label="Profile URL" columns={columns} value={op.profileUrl ?? ''} onChange={text('profileUrl')} placeholder="{{LinkedIn}}" />
		</div>
		<Field label="Field">{(id) => <Select id={id} value={op.field} onValueChange={(value) => set({ field: value as OpOf<'person'>['field'] })}>{PERSON_FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}</Select>}</Field>
		<SourceField value={op.source} onChange={(source) => set({ source })} help="MoltSets looks a person up by email or LinkedIn URL and answers name, title, company, location and LinkedIn URL. looot answers the other fields and any miss." />
	</>;
}

const FIND_EMAIL_INPUTS = [
	{ key: 'name', label: 'Person name', placeholder: '{{Name}}' },
	{ key: 'domain', label: 'Company domain', placeholder: '{{Company website}}' },
	{ key: 'company', label: 'Company (optional)', placeholder: '{{Company}}' },
	{ key: 'profileUrl', label: 'LinkedIn URL (optional)', placeholder: '{{LinkedIn}}' },
] as const;

const PREFER_OPTIONS: Array<{ value: EmailPreference; label: string }> = [
	{ value: 'balanced', label: 'Balanced: price and track record' },
	{ value: 'cheapest', label: 'Cheapest provider first' },
	{ value: 'reliable', label: 'Most reliable provider first' },
];

/** looot walks the providers of a job in this order and stops at the first answer. */
function PreferField({ value, onChange }: { value: EmailPreference; onChange: (value: EmailPreference) => void }) {
	return <Field label="Provider order" help="looot tries the job's providers one after another and stops at the first answer. You pay only for the attempts that ran.">{(id) => <Select id={id} value={value} onValueChange={(next) => onChange(next as EmailPreference)}>{PREFER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>}</Field>;
}

const SOURCE_OPTIONS: Array<{ value: ContactSource; label: string }> = [
	{ value: 'moltsets-first', label: 'MoltSets then looot' },
	{ value: 'looot', label: 'looot only' },
	{ value: 'moltsets', label: 'MoltSets only' },
];

/** Which source a contact column asks first. An unset source is the default, so picking it clears the field. */
function SourceField({ value, onChange, help }: { value?: ContactSource; onChange: (value: ContactSource | undefined) => void; help?: string }) {
	const { connections } = useSettings();
	const connected = isReady(connections.moltsets);
	return <Field label="Source" help={help ?? 'MoltSets answers from your flat-fee plan, so a hit costs no dollars. looot answers a miss, or everything when you pick looot only.'}>{(id) => <>
		<Select id={id} value={value ?? 'moltsets-first'} onValueChange={(next) => onChange(next === 'moltsets-first' ? undefined : next as ContactSource)}>{SOURCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>
		{!connected && value !== 'looot' && <p className="mt-1 text-caption text-fg-subtle">No MoltSets key is connected, so this column runs on looot. Add the key in Configuration to use your plan first.</p>}
	</>}</Field>;
}

function FindEmailFields({ op, set, columns }: FieldsProps<'email-enrichment'>) {
	return <>
		<div className="grid gap-3 sm:grid-cols-2">
			{FIND_EMAIL_INPUTS.map((input) => <PromptField key={input.key} label={input.label} columns={columns} value={op[input.key]} onChange={(value) => set({ [input.key]: value })} placeholder={input.placeholder} />)}
		</div>
		<SourceField value={op.source} onChange={(source) => set({ source })} />
		<PreferField value={op.prefer} onChange={(prefer) => set({ prefer })} />
	</>;
}

function VerifyEmailFields({ op, set, columns }: FieldsProps<'email-verify'>) {
	return <>
		<PromptField label="Email to verify" columns={columns} value={op.email} onChange={(email) => set({ email })} placeholder="{{Work email}}" />
		<PreferField value={op.prefer} onChange={(prefer) => set({ prefer })} />
	</>;
}

function FindPhoneFields({ op, set, columns }: FieldsProps<'phone-find'>) {
	return <>
		<div className="grid gap-3 sm:grid-cols-2">
			<PromptField label="LinkedIn URL" help="Best match. Without it, give a name and a company." columns={columns} value={op.profileUrl} onChange={(profileUrl) => set({ profileUrl })} placeholder="{{LinkedIn}}" />
			<PromptField label="Person name" columns={columns} value={op.name} onChange={(name) => set({ name })} placeholder="{{Name}}" />
			<PromptField label="Company (optional)" columns={columns} value={op.company} onChange={(company) => set({ company })} placeholder="{{Company}}" />
			<PromptField label="Company domain (optional)" columns={columns} value={op.domain} onChange={(domain) => set({ domain })} placeholder="{{Company website}}" />
		</div>
		<SourceField value={op.source} onChange={(source) => set({ source })} help="MoltSets finds a mobile from a LinkedIn URL, or a name and company. It draws from the phone tokens of your MoltSets plan. looot answers a miss." />
		<PreferField value={op.prefer} onChange={(prefer) => set({ prefer })} />
		<p className="text-caption text-fg-subtle">Phone lookups cost more than emails. Check the estimate before you run a column.</p>
	</>;
}

interface CatalogHit { endpointId: string; provider: string | null; name: string; category: string | null; job: string | null; runnable: boolean; priceUsd: number | null }
interface Inspected { endpointId: string; priceUsd: number | null; inputs: Array<{ name: string; type: string; description: string; required: boolean }> }

async function loootJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { headers: keyHeaders(), cache: 'no-store' });
	const data = await response.json().catch(() => null) as (T & { error?: string }) | null;
	if (!response.ok || !data) throw new Error(data?.error ?? `looot answered ${response.status}`);
	return data;
}

/** Any looot endpoint: search the catalog in plain words, inspect the pick, map its inputs from columns with
    `{{Column}}` templates, and see the price per row. The run asks to confirm the estimated cost before it spends. */
function LoootFields({ op, set, columns }: FieldsProps<'looot'>) {
	const [query, setQuery] = useState('');
	const [hits, setHits] = useState<CatalogHit[]>([]);
	const [descriptions, setDescriptions] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<'search' | 'inspect' | null>(null);
	const [error, setError] = useState('');
	const [newInput, setNewInput] = useState('');
	const columnNames = columns.map((column) => column.name);
	const job = op.endpointId.startsWith('job:');

	async function search() {
		if (!query.trim()) return;
		setBusy('search'); setError('');
		try { setHits((await loootJson<{ results: CatalogHit[] }>(`/api/looot/search?q=${encodeURIComponent(query.trim())}`)).results); }
		catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not search looot.'); }
		finally { setBusy(null); }
	}

	async function pick(hit: CatalogHit) {
		setBusy('inspect'); setError('');
		try {
			const detail = await loootJson<Inspected>(`/api/looot/inspect?id=${encodeURIComponent(hit.endpointId)}`);
			setDescriptions(Object.fromEntries(detail.inputs.map((input) => [input.name, `${input.type}${input.required ? ', required' : ''}${input.description ? `: ${input.description}` : ''}`])));
			set({
				endpointId: hit.endpointId,
				inputs: suggestInputMap(detail.inputs.map((input) => input.name), columnNames),
				inputTypes: Object.fromEntries(detail.inputs.map((input) => [input.name, input.type])),
				unitCostUsd: detail.priceUsd ?? hit.priceUsd,
			});
		} catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not inspect this endpoint.'); }
		finally { setBusy(null); }
	}

	const names = Object.keys(op.inputs);
	return <>
		<Field label="Find an endpoint" help="Describe what you want in plain words, for example work email from name and company. Searching is free.">
			{(id) => <div className="flex gap-2"><Input id={id} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} placeholder="Find LinkedIn posts for a profile" /><Button size="sm" loading={busy === 'search'} disabled={!query.trim()} onClick={() => void search()}>Search looot</Button></div>}
		</Field>
		{error && <p role="alert" className="text-body-sm text-danger">{error}</p>}
		{hits.length > 0 && <ul aria-label="looot endpoints" className="flex max-h-56 flex-col gap-1 overflow-auto rounded-lg border border-line-subtle p-1">
			{hits.map((hit) => <li key={hit.endpointId}><button type="button" disabled={!hit.runnable || busy === 'inspect'} onClick={() => void pick(hit)} aria-pressed={op.endpointId === hit.endpointId} className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-body-sm hover:bg-tint/[0.05] disabled:opacity-50 aria-pressed:bg-tint/[0.08]">
				<span className="text-fg">{hit.name}</span>
				<span className="text-caption text-fg-subtle">{hit.provider ?? 'provider'} · {hit.endpointId} · {formatUsd(hit.priceUsd)} per call{hit.runnable ? '' : ' · needs your own account'}</span>
			</button></li>)}
		</ul>}
		<Field label="Endpoint" help="The picked endpoint id. Type job:<job id>, for example job:people.email.find, to let looot pick the provider and walk to the next on a miss. Use that job's input names then.">
			{(id) => <Input id={id} value={op.endpointId} onChange={(event) => set({ endpointId: event.target.value.trim() })} placeholder="Pick one above, or paste an endpoint id" />}
		</Field>
		{op.endpointId && <>
			<div className="flex flex-col gap-3">
				{names.map((name) => <div key={name} className="flex flex-col gap-1">
					<span className="text-caption text-fg-muted" title={descriptions[name]}>{name}{op.inputTypes[name] ? <span className="ml-1.5 rounded bg-neutral-5 px-1 text-fg-subtle">{op.inputTypes[name]}</span> : null}{descriptions[name]?.includes('required') ? ' *' : ''}</span>
					<ColumnPrompt id={`looot-input-${name}`} rows={1} columns={columns} value={op.inputs[name]} onChange={(value) => set({ inputs: { ...op.inputs, [name]: value } })} placeholder="{{Column}} or fixed text" />
				</div>)}
				<div className="flex items-end gap-2">
					<Field label="Add an input" help="An input the endpoint takes that is not listed.">{(id) => <Input id={id} value={newInput} onChange={(event) => setNewInput(event.target.value)} placeholder="input name" />}</Field>
					<Button size="sm" disabled={!newInput.trim() || newInput.trim() in op.inputs} onClick={() => { set({ inputs: { ...op.inputs, [newInput.trim()]: '' } }); setNewInput(''); }}>Add</Button>
				</div>
			</div>
			<Field label="Keep this field of the answer (optional)" help="A dot path into the answer, for example data.0.email. Empty keeps the whole answer.">{(id) => <Input id={id} value={op.path} onChange={(event) => set({ path: event.target.value })} placeholder="email" />}</Field>
			{job && <PreferField value={op.prefer} onChange={(prefer) => set({ prefer })} />}
			<p role="status" className="rounded-lg border border-line-subtle bg-neutral-5/60 px-3 py-2 text-caption text-fg-muted">{op.unitCostUsd !== null ? `About ${formatUsd(op.unitCostUsd)} per row. The run shows the total for the rows you pick and asks before it spends.` : 'The price of this endpoint is not known yet. Pick it from the search above to see it.'}</p>
		</>}
	</>;
}

function ResearchFields({ op, set, columns }: FieldsProps<'answer'>) {
	return <>
		<PromptField label="Research task" help="AI searches the web and reads pages through looot, then returns a sourced answer." columns={columns} rows={3} value={op.task} onChange={(task) => set({ task })} placeholder="What is {{Company}}'s most recent funding round, amount and lead investor?" />
		<div className="grid gap-4 sm:grid-cols-2">
			<OutputField value={op.output} onChange={(output) => set({ output })} />
			<Field label="Depth">{(id) => <Select id={id} value={op.mode} onValueChange={(value) => set({ mode: value as 'fast' | 'ultra' })}><option value="fast">Fast · about 1 cent per row</option><option value="ultra">Ultra · about 3 cents per row</option></Select>}</Field>
		</div>
	</>;
}

/* ───────────────────────────── Shared inputs ───────────────────────────── */

const newRowId = () => crypto.randomUUID();

/** Add/remove/reorder rows. Rows own their raw text; the saved list is derived, so Enter, ':' and ',' are never eaten. */
function ListEditor({ label, help, item, detail, placeholders, detailPlaceholder, items, onChange, minRows, max, maxLength = 120 }: { label: string; help: string; item: string; detail?: string; placeholders: string[]; detailPlaceholder?: string; items: ListItem[]; onChange: (items: ListItem[]) => void; minRows: number; max: number; maxLength?: number }) {
	const baseId = useId();
	const [rows, setRows] = useState<ListRow[]>(() => {
		const initial = toListRows(items, newRowId);
		return [...initial, ...toListRows(Array.from({ length: Math.max(0, minRows - initial.length) }, () => ({ label: '' })), newRowId)];
	});
	const [added, setAdded] = useState<string | null>(null);
	const inputId = (row: ListRow) => `${baseId}-${row.id}`;
	const update = (next: ListRow[]) => { setRows(next); onChange(fromListRows(next)); };
	const edit = (id: string, patch: Partial<ListRow>) => update(rows.map((row) => row.id === id ? { ...row, ...patch } : row));
	const insert = (at: number, entries: ListItem[], base = rows) => {
		const created = toListRows(entries, newRowId).slice(0, Math.max(0, max - base.length));
		update([...base.slice(0, at), ...created, ...base.slice(at)]);
		if (created.length) setAdded(created.at(-1)!.id);
	};
	const remove = (index: number) => {
		const neighbour = rows[index - 1] ?? rows[index + 1];
		update(rows.filter((_, position) => position !== index));
		if (neighbour) document.getElementById(inputId(neighbour))?.focus();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
		const row = rows[index];
		if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
			event.preventDefault();
			const next = rows[index + 1];
			if (next && !next.label && !next.detail) document.getElementById(inputId(next))?.focus();
			else insert(index + 1, [{ label: '' }]);
		}
		else if (event.key === 'Backspace' && !row.label && !row.detail && rows.length > 1) { event.preventDefault(); remove(index); }
	};
	// Pasting several lines ("Strong fit: B2B SaaS") fills several rows; a blank row is replaced by the first.
	const onPaste = (event: ClipboardEvent<HTMLInputElement>, index: number) => {
		const pasted = parseListLines(event.clipboardData.getData('text'), Boolean(detail));
		if (!pasted) return;
		event.preventDefault();
		const blank = !rows[index].label && !rows[index].detail;
		insert(blank ? index : index + 1, pasted, blank ? rows.filter((_, position) => position !== index) : rows);
	};
	return <div role="group" aria-labelledby={`${baseId}-label`} className="flex flex-col gap-2">
		<div className="flex items-center gap-1.5"><span id={`${baseId}-label`} className="text-body-sm text-fg">{label}</span><HelpTooltip label={`About ${label.toLowerCase()}`}>{help}</HelpTooltip></div>
		<Sortable value={rows} onValueChange={update} getItemValue={(row) => row.id} className="flex flex-col gap-1.5">
			{rows.map((row, index) => <SortableItem key={row.id} value={row.id} className="flex items-center gap-1.5 rounded-lg border-0 bg-surface shadow-none ring-0">
				<SortableItemHandle render={<button type="button" />} aria-label={`Reorder ${item.toLowerCase()} ${index + 1}`} title="Drag to reorder" className="grid size-8 shrink-0 touch-none place-items-center rounded-lg text-fg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-brand"><GripVertical className="size-4" strokeWidth={1.5} /></SortableItemHandle>
				<div className={`grid min-w-0 flex-1 gap-1.5 ${detail ? 'sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : ''}`}>
					<Input id={inputId(row)} aria-label={`${item} ${index + 1}`} autoFocus={row.id === added} maxLength={maxLength} placeholder={placeholders[index] ?? `${item} ${index + 1}`} value={row.label} onChange={(event) => edit(row.id, { label: event.target.value })} onKeyDown={(event) => onKeyDown(event, index)} onPaste={(event) => onPaste(event, index)} />
					{detail && <Input aria-label={`${item} ${index + 1} description`} maxLength={300} placeholder={index === 0 && detailPlaceholder ? detailPlaceholder : detail} value={row.detail} onChange={(event) => edit(row.id, { detail: event.target.value })} onKeyDown={(event) => onKeyDown(event, index)} />}
				</div>
				<IconButton label={`Remove ${item.toLowerCase()} ${index + 1}`} disabled={rows.length <= 1} onClick={() => remove(index)}><X strokeWidth={1.5} /></IconButton>
			</SortableItem>)}
		</Sortable>
		<Button size="sm" variant="ghost" className="self-start" disabled={rows.length >= max} onClick={() => insert(rows.length, [{ label: '' }])}><Plus strokeWidth={1.5} />Add {item.toLowerCase()}</Button>
	</div>;
}

/** Keeps the typed text while editing (so clearing the field never snaps back); clamps on blur. */
function NumberField({ label, help, value, min, max, step, integer, onChange }: { label: string; help?: string; value: number; min: number; max: number; step: number; integer?: boolean; onChange: (value: number) => void }) {
	const [raw, setRaw] = useState(String(value));
	const inRange = (text: string) => { const parsed = Number(text); return text.trim() !== '' && Number.isFinite(parsed) && parsed >= min && parsed <= max; };
	return <Field label={label} help={help}>{(id) => <Input id={id} type="number" inputMode={integer ? 'numeric' : 'decimal'} min={min} max={max} step={step} value={raw}
		onChange={(event) => { setRaw(event.target.value); if (inRange(event.target.value)) onChange(clampNumber(event.target.value, { min, max, fallback: value, integer })); }}
		onBlur={() => { const next = clampNumber(raw, { min, max, fallback: value, integer }); setRaw(String(next)); onChange(next); }} />}</Field>;
}

function DomainsField({ value, onChange }: { value?: string[]; onChange: (domains: string[] | undefined) => void }) {
	const [raw, setRaw] = useState(() => (value ?? []).join(', '));
	const commit = (text: string) => { const domains = parseCommaList(text); onChange(domains.length ? domains : undefined); return domains; };
	return <Field label="Only these domains" help="Optional. Separate domains with commas.">{(id) => <Input id={id} value={raw} placeholder="linkedin.com, crunchbase.com" onChange={(event) => { setRaw(event.target.value); commit(event.target.value); }} onBlur={() => setRaw(commit(raw).join(', '))} />}</Field>;
}

function OutputField({ value, onChange }: { value: (typeof OUTPUT_TYPES)[number]; onChange: (value: (typeof OUTPUT_TYPES)[number]) => void }) {
	return <Field label="Answer type">{(id) => <Select id={id} value={value} onValueChange={(next) => onChange(next as (typeof OUTPUT_TYPES)[number])}>
		<option value="text">Text</option><option value="document">Document</option><option value="number">Number</option><option value="boolean">True / false</option><option value="url">URL</option><option value="date">Date</option><option value="list">List</option>
	</Select>}</Field>;
}

function DeciderField({ value, onChange, jevAvailable }: { value: 'jev' | 'openai'; onChange: (value: 'jev' | 'openai') => void; jevAvailable: boolean }) {
	return <Field label="Decide with" help={jevAvailable ? undefined : 'Connect TypeSafe in Configuration → Connections for calibrated answers.'}>{(id) => <Select id={id} value={value} onValueChange={(next) => onChange(next as 'jev' | 'openai')}>
		<option value="jev" disabled={!jevAvailable}>TypeSafe · calibrated answers</option>
		<option value="openai">OpenAI · structured answer</option>
	</Select>}</Field>;
}

const PAGE_KINDS = [
	{ value: 'find', label: 'A named page on the domain (pricing, careers…)' },
	{ value: 'homepage', label: 'Homepage of a domain column' },
	{ value: 'column', label: 'A URL column' },
	{ value: 'template', label: 'A URL template' },
] as const;
const NAMED_PAGES = ['pricing', 'careers', 'about', 'contact', 'blog', 'team', 'docs', 'customers', 'integrations', 'security', 'privacy', 'terms'];

function PageField({ label, page, optional, columns, domainColumn, onChange }: { label: string; page?: PageSource; optional?: boolean; columns: Column[]; domainColumn?: string; onChange: (page: PageSource | undefined) => void }) {
	const defaultColumn = domainColumn ?? columns[0]?.name ?? '';
	const switchType = (type: PageSource['type']) => {
		switch (type) {
			case 'find': return onChange({ type, column: defaultColumn, page: 'pricing' });
			case 'homepage': return onChange({ type, column: defaultColumn });
			case 'column': return onChange({ type, column: defaultColumn });
			case 'template': return onChange({ type, template: domainColumn ? `https://{{${domainColumn}}}/` : 'https://' });
		}
	};
	return <div className="flex flex-col gap-2 rounded-lg border border-line-subtle bg-neutral-5/60 p-3">
		<div className="flex items-center justify-between gap-3">
			<span className="text-body-sm text-fg">{label}</span>
			{optional && <Switch checked={Boolean(page)} onChange={(checked) => (checked ? switchType('find') : onChange(undefined))} label={label} />}
		</div>
		{page && <div className="grid gap-3 sm:grid-cols-2">
			<Select aria-label="Page source" value={page.type} onValueChange={(value) => switchType(value as PageSource['type'])}>{PAGE_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</Select>
			{page.type === 'template'
				? <Input aria-label="Page URL template" value={page.template} onChange={(event) => onChange({ type: 'template', template: event.target.value })} placeholder="https://{{Website}}/pricing" />
				: <Select aria-label="Page column" value={page.column} onValueChange={(value) => onChange({ ...page, column: value })}>{columns.map((column) => <option key={column.id} value={column.name}>{column.name}</option>)}</Select>}
			{page.type === 'find' && <Input aria-label="Page to find" value={page.page} onChange={(event) => onChange({ ...page, page: event.target.value })} placeholder="pricing" list="page-kinds" className="sm:col-span-2" />}
			<datalist id="page-kinds">{NAMED_PAGES.map((kind) => <option key={kind} value={kind} />)}</datalist>
		</div>}
	</div>;
}
