'use client';

import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import { COUNTRY_OPTIONS } from '@/lib/countries';
import { INPUT_CLASS } from './input-styles';

const COUNTRY_LABELS = new Map<string, string>(COUNTRY_OPTIONS.map((country) => [country.value, country.label]));

export function CountryPicker({ id, value, onChange, disabled }: { id: string; value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
	const [search, setSearch] = useState('');
	const [open, setOpen] = useState(false);
	const matches = COUNTRY_OPTIONS.filter((country) => `${country.label} ${country.value}`.toLowerCase().includes(search.trim().toLowerCase()));
	const chosen = new Set(value);
	const summary = value.length ? value.map((code) => COUNTRY_LABELS.get(code) ?? code).join(', ') : 'Any country';
	return <Popover.Root open={open && !disabled} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(''); }}>
		<Popover.Trigger asChild><button id={id} type="button" disabled={disabled} className={`${INPUT_CLASS} flex items-center gap-2 text-left`}><span className="min-w-0 flex-1 truncate">{summary}</span><ChevronDown aria-hidden className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} /></button></Popover.Trigger>
		<Popover.Portal><Popover.Content aria-label="Choose countries" align="start" sideOffset={5} collisionPadding={12} className="z-[110] w-72 max-w-[calc(100vw-24px)] rounded-lg border border-line bg-surface p-2 text-fg shadow-lg" onEscapeKeyDown={(event) => event.stopPropagation()}>
			<input aria-label="Search countries" className={INPUT_CLASS} placeholder="Search countries…" value={search} onChange={(event) => setSearch(event.target.value)} />
			<button type="button" className="mt-1 w-full rounded-md px-2 py-2 text-left text-body-sm hover:bg-neutral-5" onClick={() => onChange([])}>Any country{value.length === 0 ? ' ✓' : ''}</button>
			<div className="max-h-56 overflow-y-auto" role="group" aria-label="Countries">
				{matches.map((country) => <label key={country.value} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-body-sm hover:bg-neutral-5"><input type="checkbox" disabled={!chosen.has(country.value) && value.length >= 20} checked={chosen.has(country.value)} onChange={(event) => onChange(event.target.checked ? [...value, country.value] : value.filter((code) => code !== country.value))} /><span className="flex-1">{country.label}</span><span className="text-caption text-fg-subtle">{country.value}</span></label>)}
				{!matches.length && <p className="p-2 text-body-sm text-fg-muted">No countries found.</p>}
			</div>
			<div className="flex items-center justify-between pt-2 text-caption"><span aria-live="polite">{value.length ? `${value.length} of 20 selected` : 'Any country'}</span><Popover.Close className="rounded-md px-3 py-1 text-brand hover:bg-neutral-5">Done</Popover.Close></div>
		</Popover.Content></Popover.Portal>
	</Popover.Root>;
}
