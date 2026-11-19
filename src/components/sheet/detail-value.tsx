import { Braces, Brackets, Check, ChevronRight, ExternalLink, Hash, Link, Type } from 'lucide-react';
import { keyedItems } from '@/lib/detail-value';

function fieldLabel(key: string) {
	return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function isLink(value: unknown): value is string {
	return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value);
}

const FIELD_ICONS = { list: Brackets, object: Braces, number: Hash, boolean: Check, link: Link, text: Type };

function fieldKind(value: unknown): keyof typeof FIELD_ICONS {
	if (Array.isArray(value)) return 'list';
	if (value !== null && typeof value === 'object') return 'object';
	if (typeof value === 'number') return 'number';
	if (typeof value === 'boolean') return 'boolean';
	return isLink(value) ? 'link' : 'text';
}

function FieldIcon({ value }: { value: unknown }) {
	const Icon = FIELD_ICONS[fieldKind(value)];
	return <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" strokeWidth={1.75} />;
}

function DetailField({ label, value }: { label: string; value: unknown }) {
	const nested = value !== null && typeof value === 'object';
	if (nested) {
		const array = Array.isArray(value);
		const count = array ? value.length : Object.keys(value).length;
		return <details className="min-w-0 [&[open]>summary>svg:first-child]:rotate-90">
			<summary className="flex cursor-pointer list-none items-start gap-2 rounded px-1 py-1.5 hover:bg-neutral-5 focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
				<ChevronRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-subtle transition-transform" />
				<FieldIcon value={value} />
				<span className="min-w-0 break-words font-medium text-fg">{label}</span>
				<span className="shrink-0 text-fg-subtle" aria-label={`${count} ${array ? 'items' : 'fields'}`}>{array ? `[${count}]` : `{${count}}`}</span>
			</summary>
			<div className="ml-3 border-l border-line pl-3"><DetailValue value={value} /></div>
		</details>;
	}
	return <div className="flex min-w-0 items-start gap-2 px-1 py-1.5 pl-6">
		<FieldIcon value={value} />
		<div className="min-w-0 leading-relaxed">
			<dt className="mr-1.5 inline break-words font-medium text-fg">{label}</dt>
			<dd className="inline text-fg-muted"><DetailValue value={value} /></dd>
		</div>
	</div>;
}

/** Compact typed fields, with nested objects and arrays expanded on demand. */
export function DetailValue({ value }: { value: unknown }) {
	if (value === null || value === undefined || value === '') return <span className="text-fg-subtle">Empty</span>;
	if (Array.isArray(value)) {
		if (!value.length) return <span className="text-fg-subtle">No items</span>;
		return <ol className="flex min-w-0 flex-col">{keyedItems(value).map(({ key, item, index }) => <li key={key} className="min-w-0"><dl><DetailField label={`Item ${index + 1}`} value={item} /></dl></li>)}</ol>;
	}
	if (typeof value === 'object') {
		const fields = Object.entries(value);
		if (!fields.length) return <span className="text-fg-subtle">No fields</span>;
		return <dl className="flex min-w-0 flex-col">{fields.map(([key, item]) => <div key={key} className="min-w-0"><DetailField label={fieldLabel(key)} value={item} /></div>)}</dl>;
	}
	const text = String(value);
	if (isLink(value)) {
		return <a href={value} target="_blank" rel="noopener noreferrer" className="inline text-brand hover:underline [overflow-wrap:anywhere]">{value}<ExternalLink aria-hidden className="ml-1 inline size-3" /></a>;
	}
	return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>;
}
