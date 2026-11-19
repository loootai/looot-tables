'use client';

import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/field';
import { isImeComposing } from '@/components/ui/keyboard';
import { SUGGESTED_MODELS } from '@/lib/types';

type ModelOption = { value: string; label: string; detail: string };
const AUTOMATIC: ModelOption = { value: 'decisions', label: 'Automatic (recommended)', detail: 'Calibrated yes/no and category answers' };

/** Suggested models plus the current one matching `query`; a typed model ID is offered when nothing matches it exactly. */
function modelOptions(value: string, query: string, classifier: boolean): ModelOption[] {
	const models = new Set([...SUGGESTED_MODELS, value === 'decisions' ? '' : value].filter(Boolean));
	const options = [...(classifier ? [AUTOMATIC] : []), ...[...models].map((model) => ({ value: model, label: model, detail: 'OpenAI' }))]
		.filter((option) => `${option.label} ${option.detail}`.toLowerCase().includes(query.toLowerCase()));
	const custom = query.trim();
	if (custom && /^[a-z0-9.\-_:/]+$/i.test(custom) && custom !== 'decisions' && !options.some((option) => option.value === custom)) options.push({ value: custom, label: custom, detail: 'Use model ID' });
	return options;
}

export function ModelPicker({ id, value, onChange, classifier = false }: { id: string; value: string; onChange: (value: string) => void; classifier?: boolean }) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(0);
	const options = modelOptions(value, query, classifier);
	const selected = classifier && value === 'decisions' ? AUTOMATIC.label : value;
	const highlighted = Math.min(active, Math.max(0, options.length - 1));
	function choose(next: string) { onChange(next); setOpen(false); setQuery(''); }
	return <div className="relative" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setQuery(''); } }}>
		<Input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-models`} aria-autocomplete="list" aria-activedescendant={open && options.length ? `${id}-model-${highlighted}` : undefined} value={open ? query : selected} placeholder={open ? 'Search models or enter a model ID…' : selected} autoComplete="off" spellCheck={false} className="pr-9" onFocus={() => { setOpen(true); setActive(0); }} onClick={() => { if (!open) { setQuery(''); setOpen(true); setActive(0); } }} onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }} onKeyDown={(event) => {
			if (isImeComposing(event)) return;
			if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(''); }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive((current) => options.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : 0); }
			if (event.key === 'Enter' && open) { event.preventDefault(); if (options[highlighted]) choose(options[highlighted].value); }
		}} />
		<ChevronDown aria-hidden className="pointer-events-none absolute top-3 right-3 size-4 text-fg-subtle" />
		{open && <div id={`${id}-models`} role="listbox" aria-label={classifier ? 'Classifier models' : 'OpenAI models'} className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
			{options.length ? options.map((option, index) => <div key={option.value} id={`${id}-model-${index}`} role="option" aria-selected={value === option.value} onPointerDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(option.value)} className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 text-body-sm ${index === highlighted ? 'bg-neutral-5' : ''}`}><span className="min-w-0"><span className="block truncate text-fg">{option.label}</span><span className="block text-caption text-fg-subtle">{option.detail}</span></span>{value === option.value && <Check aria-hidden className="size-4 shrink-0 text-brand" />}</div>) : <p className="px-3 py-2 text-body-sm text-fg-subtle">No matching models</p>}
		</div>}
	</div>;
}
