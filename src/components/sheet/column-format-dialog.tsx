'use client';

import { DATE_FORMATS, formatDate, type DateFormat } from '@/lib/date-format';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { Sortable, SortableItem, SortableItemHandle } from '@/components/ui/sortable';
import { ColorPicker } from '@/components/ui/color-picker';
import { CATEGORY_COLORS, categoryColor, categoryColorStyle } from '@/lib/category-colors';
import { CURRENCIES, FIELD_FORMATS, formatColumnNumber, isCheckboxColumn, isYearColumn, webColumnKind } from '@/lib/column-format';
import type { SheetCommands } from '@/lib/sheet-commands';
import type { Column, ColumnFormat } from '@/lib/types';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/field';

type Format = ColumnFormat | 'auto';
interface CategoryOption { id: string; label: string; color: string }

const NUMERIC: Format[] = ['number', 'currency', 'percent', 'unit'];
const FORMAT_HELP: Partial<Record<Format, string>> = {
	category: 'Choose one category per cell from the options below. Existing values must match an option.',
	year: 'Displays years as whole numbers without commas, for example 2024.',
	document: 'Stores Markdown and shows a document chip. Open a cell to read, edit, or download it as a PDF.',
	'email-draft': 'Shows To, Subject and Body in the sidebar. Formulas can return labeled lines, for example: ="To: "&A1&CHAR(10)&"Subject: Hello"&CHAR(10)&"Body: Hi there"',
	website: 'A domain and its homepage. Adds a dropdown for page content, links, site discovery and extraction.',
	webpage: 'A specific page URL, including its path and query. Adds a dropdown for page content, links and extraction.',
	percent: 'Enter 25% or 0.25 to show 25%.',
	checkbox: 'Checked is true; unchecked is false. Values are stored as true or false. Blank cells stay empty until checked.',
};

function validCategories(labels: string[]) {
	return labels.length > 0 && labels.length <= 100 && labels.every((label) => label.length > 0 && label.length <= 200) && new Set(labels).size === labels.length;
}

interface FormatOptions { dateFormat: DateFormat; currency: string; useGrouping: boolean; decimalPlaces: string; unit: string }

/** A header suggests a web format only for source data; an enrichment's format is what was chosen for it. */
function initialFormat(column: Column): Format {
	if (isCheckboxColumn(column)) return 'checkbox';
	return (column.type === 'source' ? webColumnKind(column) : null) ?? column.format ?? 'auto';
}

function initialOptions(column: Column): FormatOptions {
	return {
		dateFormat: column.dateFormat ?? 'YYYY-MM-DD',
		currency: column.currency ?? 'USD',
		useGrouping: column.useGrouping ?? !isYearColumn(column),
		decimalPlaces: column.decimalPlaces === undefined ? 'auto' : String(column.decimalPlaces),
		unit: column.unit ?? '',
	};
}

const decimalCount = (decimalPlaces: string) => decimalPlaces === 'auto' ? undefined : Number(decimalPlaces);

/** Settings that don't apply to the chosen format are cleared, so switching formats leaves nothing stale behind. */
function formatPatch(column: Column, format: Format, categories: CategoryOption[], options: FormatOptions): Partial<Column> {
	const numeric = NUMERIC.includes(format);
	const category = format === 'category';
	return {
		format: format === 'auto' ? undefined : format,
		dateFormat: format === 'date' ? options.dateFormat : undefined,
		categoryColors: category ? Object.fromEntries(categories.map((option) => [option.label.trim(), option.color])) : undefined,
		categoryOptions: category ? categories.map((option) => option.label.trim()) : undefined,
		currency: format === 'currency' ? options.currency : undefined,
		unit: format === 'unit' ? options.unit.trim() : undefined,
		useGrouping: numeric ? options.useGrouping : undefined,
		decimalPlaces: numeric ? decimalCount(options.decimalPlaces) : undefined,
		...(format === 'document' && (column.op?.kind === 'ai' || column.op?.kind === 'answer') ? { op: { ...column.op, output: 'document' } } : {}),
	};
}

export function ColumnFormatDialog({ column, commands, onClose, creating = false, insertAt }: { column: Column; commands: Pick<SheetCommands, 'addColumns' | 'editColumn'>; onClose: () => void; creating?: boolean; insertAt?: number }) {
	const [format, setFormat] = useState<Format>(() => initialFormat(column));
	const [categories, setCategories] = useState<CategoryOption[]>(() => (column.categoryOptions ?? ['', '']).map((label, index) => ({ id: String(index), label, color: label ? categoryColor(column, label) : CATEGORY_COLORS[index % CATEGORY_COLORS.length] })));
	const [options, setOptions] = useState(() => initialOptions(column));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState('');
	const categoryLabels = categories.map((option) => option.label.trim());
	const categoriesValid = validCategories(categoryLabels);

	async function save() {
		setSaving(true);
		setError('');
		try {
			if (format === 'category' && !categoriesValid) throw new Error('Add 1–100 unique categories, up to 200 characters each.');
			const patch = formatPatch(column, format, categories, options);
			if (creating) await commands.addColumns([{ ...column, ...patch }], { kind: format, position: insertAt });
			else await commands.editColumn(column.id, patch);
			onClose();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : 'Could not save format.');
		} finally {
			setSaving(false);
		}
	}
	const preview = formatPreview(format, { name: column.name, dateFormat: options.dateFormat, currency: options.currency, unit: options.unit.trim(), useGrouping: options.useGrouping, decimalPlaces: decimalCount(options.decimalPlaces) });
	const blocked = saving || (format === 'category' && !categoriesValid) || (format === 'unit' && !options.unit.trim());
	return <Dialog title={creating ? 'Add a category column' : `Field format · ${column.name}`} description="Applies to every cell in this column, including new rows." size="sm" onClose={onClose} footer={<><Button size="sm" onClick={onClose}>Cancel</Button><Button size="sm" variant="brand" loading={saving} disabled={blocked} onClick={() => void save()}>{creating ? 'Add column' : 'Save format'}</Button></>}>
		<div className="flex flex-col gap-4">
			{!creating && <Field label="Format" help={FORMAT_HELP[format]}>{(id) => <Select id={id} value={format} onValueChange={(value) => setFormat(value as Format)}>{FIELD_FORMATS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}</Field>}
			{format === 'category' && <CategoryOptions categories={categories} setCategories={setCategories} labels={categoryLabels} valid={categoriesValid} />}
			<FormatOptionFields format={format} options={options} onChange={(patch) => setOptions((current) => ({ ...current, ...patch }))} />
			{preview && <p className="text-body-sm text-fg-muted">Preview: <span className="tabular text-fg">{preview}</span></p>}
			{error && <p role="alert" className="text-body-sm text-danger">{error}</p>}
		</div>
	</Dialog>;
}

/** The settings each display format offers: a date pattern, a currency, a unit, or number grouping and decimals. */
function FormatOptionFields({ format, options, onChange }: { format: Format; options: FormatOptions; onChange: (patch: Partial<FormatOptions>) => void }) {
	return <>
		{format === 'date' && <Field label="Date format" help="Changes how dates are displayed; stored values stay unchanged.">{(id) => <Select id={id} value={options.dateFormat} onValueChange={(value) => onChange({ dateFormat: value as DateFormat })}>{DATE_FORMATS.map((pattern) => <option key={pattern} value={pattern}>{pattern} · {formatDate('2024-11-23', pattern)}</option>)}</Select>}</Field>}
		{format === 'currency' && <Field label="Currency">{(id) => <Select id={id} value={options.currency} onValueChange={(value) => onChange({ currency: value })}>{CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</Select>}</Field>}
		{format === 'unit' && <Field label="Unit" help="Shown after the number; the stored value stays numeric.">{(id) => <Input id={id} maxLength={30} placeholder="kg, km, hours…" value={options.unit} onChange={(event) => onChange({ unit: event.target.value })} />}</Field>}
		{NUMERIC.includes(format) && <NumberOptions decimalPlaces={options.decimalPlaces} onDecimalPlaces={(decimalPlaces) => onChange({ decimalPlaces })} useGrouping={options.useGrouping} onGrouping={(useGrouping) => onChange({ useGrouping })} />}
	</>;
}

function formatPreview(format: Format, options: { name: string; dateFormat: DateFormat; currency: string; unit: string; useGrouping: boolean; decimalPlaces?: number }): string | null {
	if (format === 'date') return formatDate('2024-11-23', options.dateFormat);
	if (!NUMERIC.includes(format) && format !== 'year') return null;
	return formatColumnNumber(format === 'percent' ? 0.25 : format === 'year' ? 2024 : 1234.5, { ...options, format: format as ColumnFormat });
}

function NumberOptions({ decimalPlaces, onDecimalPlaces, useGrouping, onGrouping }: { decimalPlaces: string; onDecimalPlaces: (value: string) => void; useGrouping: boolean; onGrouping: (value: boolean) => void }) {
	return <>
		<Field label="Decimal places">{(id) => <Select id={id} value={decimalPlaces} onValueChange={onDecimalPlaces}><option value="auto">Automatic</option>{Array.from({ length: 11 }, (_, i) => <option key={i} value={String(i)}>{i}</option>)}</Select>}</Field>
		<div className="flex items-center justify-between text-body-sm"><span>Thousands separator</span><Switch label="Thousands separator" checked={useGrouping} onChange={onGrouping} /></div>
	</>;
}

function CategoryOptions({ categories, setCategories, labels, valid }: { categories: CategoryOption[]; setCategories: Dispatch<SetStateAction<CategoryOption[]>>; labels: string[]; valid: boolean }) {
	const edit = (id: string, patch: Partial<CategoryOption>) => setCategories((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
	return <div className="space-y-3">
		<div className="flex items-center justify-between"><span className="text-body-sm font-medium">Options</span><span className="text-caption text-fg-subtle">{categories.length}/100</span></div>
		<Sortable value={categories} onValueChange={setCategories} getItemValue={(option) => option.id} className="space-y-2" data-category-list>
			{categories.map((option, index) => <SortableItem key={option.id} value={option.id} className="relative flex items-center gap-2 rounded-lg border-0 bg-surface shadow-none ring-0">
				<SortableItemHandle render={<button type="button" />} aria-label={`Reorder option ${index + 1}`} title="Drag to reorder. Or press Space, use arrow keys, and press Space to drop." className="grid size-8 shrink-0 touch-none place-items-center rounded-lg text-fg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-brand"><GripVertical className="size-4" strokeWidth={1.5} /></SortableItemHandle>
				<ColorPicker label={`Color for option ${index + 1}`} value={option.color} onChange={(color) => edit(option.id, { color })} />
				<div className="relative min-w-0 flex-1"><Input aria-label={`Option ${index + 1}`} placeholder={`Option ${index + 1}`} maxLength={200} value={option.label} onChange={(event) => edit(option.id, { label: event.target.value })} className={index === 0 ? 'pr-16' : undefined} />{index === 0 && <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded bg-neutral-5 px-1.5 py-0.5 text-[10px] text-fg-subtle">Default</span>}</div>
				<IconButton label={`Remove option ${index + 1}`} onClick={() => setCategories((current) => current.filter((item) => item.id !== option.id))}><Trash2 strokeWidth={1.5} /></IconButton>
			</SortableItem>)}
		</Sortable>
		<Button size="sm" variant="ghost" disabled={categories.length >= 100} onClick={() => setCategories((current) => [...current, { id: crypto.randomUUID(), label: '', color: CATEGORY_COLORS[current.length % CATEGORY_COLORS.length] }])}><Plus strokeWidth={1.5} />Add option</Button>
		{labels.some(Boolean) && <div className="flex flex-wrap gap-1.5 rounded-lg bg-neutral-5 p-3" aria-label="Category preview">{categories.filter((option) => option.label.trim()).map((option) => <span key={option.id} className="max-w-full truncate rounded-full px-2.5 py-1 text-caption" style={categoryColorStyle(option.color)}>{option.label.trim()}</span>)}</div>}
		<p className="text-caption text-fg-subtle">The first option is the default for empty and new cells. Drag to reorder.</p>
		{labels.some(Boolean) && !valid && <p role="alert" className="text-caption text-danger">Give every option a unique name, or remove empty options.</p>}
	</div>;
}
