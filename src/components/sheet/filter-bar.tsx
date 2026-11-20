'use client';

import { FILTER_OPS, isActiveFilter } from '@/lib/filters';
import { organizationKind } from '@/lib/organization-logo';
import { formatValue } from '@/lib/template';
import type { Column, Filter, Row, Sheet } from '@/lib/types';
import { FilterValueInput } from './filter-value-input';
import { Input, Select } from '@/components/ui/field';
import { Button, IconButton } from '@/components/ui/button';
import { nanoid } from 'nanoid';
import { ChevronDown, Filter as FilterIcon, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react';

function valueOptions(column: Column | undefined, rows: Row[]): string[] {
	if (column?.format === 'category') return column.categoryOptions ?? [];
	if (column?.op?.kind === 'classify') return column.op.options.map((option) => option.label);
	if (column?.format === 'boolean' || column?.format === 'checkbox' || column?.op?.kind === 'check') return ['true', 'false'];
	if (column && organizationKind(column) === 'company') {
		const values = rows.map((row) => formatValue(row.cells[column.id]?.v)).filter((value) => value.trim() !== '');
		return [...new Set(values)].sort((a, b) => a.localeCompare(b));
	}
	return [];
}

/** This viewer's filters (see sheet-view.ts). A hidden trigger (the mobile toolbar opens filters from its overflow menu)
    places the panel under the trigger's row. */
export function FilterMenu({ sheet, filters, onChange, allRows, shownRows, totalRows, openRequest, triggerClassName = '' }: { sheet: Sheet; filters: Filter[]; onChange: (filters: Filter[]) => void; allRows: Row[]; shownRows: number; totalRows: number; openRequest: number; triggerClassName?: string }) {
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDialogElement>(null);
	const [open, setOpen] = useState(false);
	const columns = sheet.columns.filter((column) => !column.hidden);
	const optionsByColumn = useMemo(() => new Map(sheet.columns.map((column) => [column.id, valueOptions(column, allRows)])), [sheet.columns, allRows]);
	const activeFilterCount = filters.filter(isActiveFilter).length;
	// Changes apply as they are made (typing is debounced), so dismissing the panel never discards them.
	const [draftFilters, setDraftFilters] = useState<Filter[]>(filters);
	const [sync, setSync] = useState(() => ({ seen: filters, saved: JSON.stringify(filters) }));
	const pending = useRef<{ filters: Filter[]; timer: ReturnType<typeof setTimeout> } | null>(null);
	// Adopt filters set elsewhere ("Filter by this column", this viewer's other tab), but not the echo of our own changes.
	if (sync.seen !== filters) {
		setSync({ ...sync, seen: filters });
		if (JSON.stringify(filters) !== sync.saved) setDraftFilters(filters);
	}
	const flush = () => {
		const next = pending.current;
		if (!next) return;
		clearTimeout(next.timer);
		pending.current = null;
		setSync((current) => ({ ...current, saved: JSON.stringify(next.filters) }));
		onChange(next.filters);
	};
	const change = (filters: Filter[], delay = 0) => {
		setDraftFilters(filters);
		if (pending.current) clearTimeout(pending.current.timer);
		pending.current = { filters, timer: setTimeout(flush, delay) };
	};
	const flushOnUnmount = useEffectEvent(flush);
	useEffect(() => () => flushOnUnmount(), []);
	const add = () => change([...draftFilters, { id: nanoid(8), columnId: columns[0]?.id ?? '', op: (optionsByColumn.get(columns[0]?.id) ?? []).length ? 'equals' : 'contains', value: '' }]);
	const patch = (id: string, changes: Partial<Filter>, delay = 0) => change(draftFilters.map((filter) => (filter.id === id ? { ...filter, ...changes } : filter)), delay);
	const remove = (id: string) => change(draftFilters.filter((filter) => filter.id !== id));

	useEffect(() => {
		if (openRequest > 0) panel.current?.showPopover();
	}, [openRequest]);

	const position = useCallback(() => {
		const button = trigger.current;
		const anchorRect = (button?.getClientRects().length ? button : button?.parentElement)?.getBoundingClientRect();
		const node = panel.current;
		if (!anchorRect || !node) return;
		const width = Math.min(560, window.innerWidth - 24);
		node.style.width = `${width}px`;
		node.style.left = `${Math.max(12, Math.min(anchorRect.left, window.innerWidth - width - 12))}px`;
		node.style.top = `${anchorRect.bottom + 8}px`;
		node.style.maxHeight = `${Math.max(120, window.innerHeight - anchorRect.bottom - 20)}px`;
	}, [panel]);

	useEffect(() => {
		if (!open) return;
		position();
		panel.current?.querySelector<HTMLElement>('select, button')?.focus();
		window.addEventListener('resize', position);
		window.addEventListener('scroll', position, true);
		return () => {
			window.removeEventListener('resize', position);
			window.removeEventListener('scroll', position, true);
		};
	}, [open, panel, position]);

	return <>
		<Button ref={trigger} size="sm" variant="ghost" popoverTarget={id} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} className={`${open || activeFilterCount > 0 ? 'bg-blue-10 text-brand hover:bg-blue-10 hover:text-brand' : ''} ${triggerClassName}`}>
			<FilterIcon strokeWidth={1.5} /> Filter
			{activeFilterCount > 0 && <span className="grid min-w-4 place-items-center rounded bg-brand/10 px-1 text-caption tabular">{activeFilterCount}</span>}
			<ChevronDown className={`!size-3 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={1.5} />
		</Button>
		<dialog ref={panel} id={id} popover="auto" aria-label="Filters" onBeforeToggle={(event) => { position(); if (event.newState === 'open' && !pending.current) setDraftFilters(filters); }} onToggle={(event) => { setOpen(event.newState === 'open'); if (event.newState === 'closed') flush(); }} onKeyDown={(event) => event.stopPropagation()} className="popover-in fixed m-0 overflow-y-auto rounded-xl border border-line bg-surface p-0 text-fg shadow-[0_12px_40px_-8px_rgb(0_0_0/0.2)]">
			<div className="flex items-start justify-between gap-3 border-b border-line-subtle px-3 py-2.5">
				<div>
					<h2 className="text-body-sm font-semibold">Filter rows</h2>
					<p className="mt-1 text-caption text-fg-subtle">Match all conditions below.</p>
				</div>
				<button type="button" aria-label="Close filters" popoverTarget={id} popoverTargetAction="hide" className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-subtle hover:bg-neutral-5"><X className="size-4" /></button>
			</div>
			<div className="min-w-0 space-y-1.5 p-3">
				{draftFilters.length === 0 ? <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center">
					<FilterIcon className="mx-auto mb-2 size-5 text-fg-subtle" strokeWidth={1.5} />
					<p className="text-body-sm text-fg-muted">Narrow down your sheet</p>
					<p className="mt-1 text-caption text-fg-subtle">Choose a column and a condition to get started.</p>
				</div> : <>
					<div aria-hidden className="hidden grid-cols-[1fr_1fr_1fr_28px] gap-2 px-1 text-caption text-fg-subtle sm:grid"><span>Column</span><span>Condition</span><span>Value</span><span /></div>
					{draftFilters.map((filter) => {
						const options = optionsByColumn.get(filter.columnId) ?? [];
						const column = columns.find((column) => column.id === filter.columnId);
						const useAutocomplete = options.length > 0 && ['equals', 'not_equals', 'contains', 'not_contains'].includes(filter.op);
						const needsValue = FILTER_OPS.find((op) => op.value === filter.op)?.needsValue ?? true;
						return <div key={filter.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-1.5 rounded-lg bg-neutral-5 p-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_28px]">
							<Select aria-label="Filter column" value={filter.columnId} onValueChange={(value) => patch(filter.id, { columnId: value, value: '', op: (optionsByColumn.get(value) ?? []).length ? 'equals' : 'contains' })} className="h-8! pl-2! pr-8! text-caption!">
								{columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}
							</Select>
							<Select aria-label="Filter condition" value={filter.op} onValueChange={(value) => patch(filter.id, { op: value as Filter['op'] })} className="h-8! pl-2! pr-8! text-caption!">
								{FILTER_OPS.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}
							</Select>
							{needsValue && useAutocomplete && column ? <FilterValueInput key={filter.columnId} column={column} options={options} value={filter.value ?? ''} onChange={(value) => patch(filter.id, { value }, 300)} /> : needsValue ? <Input aria-label="Filter value" value={filter.value ?? ''} onChange={(event) => patch(filter.id, { value: event.target.value }, 300)} placeholder="Enter a value…" className="col-span-2 row-start-2 h-8! px-2! text-caption! sm:col-span-1 sm:row-start-auto" /> : <span className="hidden text-caption text-fg-subtle sm:block">No value needed</span>}
							<IconButton size="sm" label="Remove filter" onClick={() => remove(filter.id)} className="col-start-3 row-start-1 sm:col-start-4"><X /></IconButton>
						</div>;
					})}
				</>}
				<Button size="xs" variant="ghost" onClick={add} disabled={columns.length === 0} className="text-brand"><Plus strokeWidth={1.5} /> Add filter</Button>
			</div>
			<div className="flex flex-wrap items-center gap-2 border-t border-line-subtle bg-neutral-5/50 px-3 py-2">
				<span role="status" className="mr-auto text-caption text-fg-subtle tabular">{shownRows.toLocaleString()} of {totalRows.toLocaleString()} rows shown</span>
				{draftFilters.length > 0 && <Button size="xs" variant="ghost" onClick={() => change([])}>Clear filters</Button>}
				<Button size="xs" variant="primary" popoverTarget={id} popoverTargetAction="hide">Done</Button>
			</div>
		</dialog>
	</>;
}
