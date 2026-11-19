'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/field';
import { isImeComposing } from '@/components/ui/keyboard';
import { categoryColor, categoryColorStyle } from '@/lib/category-colors';
import { organizationKind } from '@/lib/organization-logo';
import type { Column } from '@/lib/types';
import { OrganizationChip } from './organization-chip';

function ValueChip({ column, value }: { column: Column; value: string }) {
	if (organizationKind(column) === 'company') return <OrganizationChip name={value} kind="company" />;
	return <span className="inline-flex h-[22px] max-w-full items-center truncate rounded-full bg-blue-10 px-2 text-caption text-brand" style={column.format === 'category' ? categoryColorStyle(categoryColor(column, value)) : undefined}>{value}</span>;
}

export function FilterValueInput({ column, options, value, onChange }: { column: Column; options: string[]; value: string; onChange: (value: string) => void }) {
	const id = useId();
	const list = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [query, setQuery] = useState('');
	const [active, setActive] = useState(-1);
	const matches = options.filter((option) => option.toLowerCase().includes(query.toLowerCase()));
	const selected = !editing && value !== '';
	const show = () => { setEditing(true); setQuery(''); setActive(-1); setOpen(true); };
	const choose = (option: string) => { onChange(option); setOpen(false); setEditing(false); setActive(-1); };
	useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
	return <div className="relative col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
		<Input aria-label="Filter value" role="combobox" aria-autocomplete="list" aria-expanded={open && matches.length > 0} aria-controls={open && matches.length > 0 ? id : undefined} aria-activedescendant={open && active >= 0 && matches[active] ? `${id}-${active}` : undefined}
			value={value} placeholder="Type or choose a value…" className={`h-8! px-2! text-caption! ${selected ? 'text-transparent! caret-transparent' : ''}`}
			onFocus={show} onClick={show} onBlur={() => { setOpen(false); setEditing(false); }}
			onChange={(event) => { onChange(event.target.value); setQuery(event.target.value); setEditing(true); setOpen(true); setActive(-1); }}
			onKeyDown={(event) => {
				if (isImeComposing(event)) return;
				if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); setEditing(false); }
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault(); setOpen(true); setEditing(true);
					setActive((current) => matches.length ? (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : -1);
				}
				if (event.key === 'Enter' && open) { event.preventDefault(); if (matches[active]) choose(matches[active]); else { setOpen(false); setEditing(false); } }
			}} />
		{selected && <span className="pointer-events-none absolute inset-y-0 left-2 right-2 flex min-w-0 items-center"><ValueChip column={column} value={value} /></span>}
		{open && matches.length > 0 && <div ref={list} id={id} role="listbox" aria-label="Suggested filter values" className="absolute top-full z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg" onMouseDown={(event) => event.preventDefault()}>
			{matches.map((option, index) => <div key={option} id={`${id}-${index}`} role="option" aria-selected={index === active} onPointerMove={() => setActive(index)} onClick={() => choose(option)} className={`cursor-pointer rounded px-2 py-1.5 ${index === active ? 'bg-blue-10' : 'hover:bg-neutral-5'}`}><ValueChip column={column} value={option} /></div>)}
		</div>}
	</div>;
}
