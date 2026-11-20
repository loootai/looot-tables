'use client';

import { RunScopeButton, useRunScope } from './run-scope-button';
import { FloatingMenu, MENU_LABEL, MENU_ROW } from '@/components/ui/menu';
import { ENTITY_FIELDS, type EntityField } from '@/lib/entity-fields';
import { ArrowLeft, ChevronDown, ChevronRight, Check, Plus } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useLayoutEffect, useRef, useState } from 'react';

/** field-sizing grows the textarea natively; measure its height only where that is unsupported. */
function useFallbackAutoHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string, open: unknown) {
	useLayoutEffect(() => {
		const input = ref.current;
		if (!input || CSS.supports('field-sizing', 'content')) return;
		input.style.height = '0px';
		input.style.height = `${input.scrollHeight + 2}px`;
	}, [ref, value, open]);
}

/** Arrow keys move between the list's buttons; ArrowRight opens a field group and ArrowLeft returns to the groups. */
function listKeys(event: KeyboardEvent<HTMLDivElement>, onOpen: ((index: number) => void) | null, onBack: (() => void) | null) {
	const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
	const index = buttons.indexOf(event.target as HTMLButtonElement);
	if (index < 0) return;
	const moves: Record<string, number> = { Home: 0, End: buttons.length - 1, ArrowDown: (index + 1) % buttons.length, ArrowUp: (index - 1 + buttons.length) % buttons.length };
	if (Object.hasOwn(moves, event.key)) {
		event.preventDefault();
		buttons[moves[event.key]]?.focus();
	} else if (event.key === 'ArrowRight' && onOpen) {
		event.preventDefault();
		onOpen(index);
	} else if (event.key === 'ArrowLeft' && onBack) {
		event.preventDefault();
		onBack();
	}
}

/** A non-modal dialog rather than a menu: it holds a form, so fields are checkboxes and the query is a textarea. */
export function EntityFieldMenu({ kind, rowId, remainingRows = 1, totalRows = remainingRows, onSelect }: { rowId?: string; remainingRows?: number; totalRows?: number; kind: keyof typeof ENTITY_FIELDS; onSelect: (fields: EntityField[]) => void }) {
	const { scope } = useRunScope(remainingRows, totalRows);
	const [query, setQuery] = useState('');
	const [selectedFields, setSelectedFields] = useState<Exclude<EntityField, { kind: 'custom' }>[]>([]);
	const fieldCount = selectedFields.length + (query.trim() ? 1 : 0);
	const toggleField = (field: Exclude<EntityField, { kind: 'custom' }>) => setSelectedFields((current) => current.some((entry) => entry.field === field.field) ? current.filter((entry) => entry.field !== field.field) : [...current, field]);
	const [shake, setShake] = useState(0);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const [group, setGroup] = useState<number | null>(null);
	const returnTo = useRef(0);
	const trigger = useRef<HTMLButtonElement>(null);
	const queryInput = useRef<HTMLTextAreaElement>(null);
	const fieldsRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => { fieldsRef.current?.querySelectorAll<HTMLButtonElement>('button')[group === null ? returnTo.current : 0]?.focus(); }, [group]);
	useFallbackAutoHeight(queryInput, query, anchor);
	const close = () => { setAnchor(null); setGroup(null); returnTo.current = 0; setQuery(''); setSelectedFields([]); setShake(0); trigger.current?.focus({ preventScroll: true }); };
	const openGroup = (index: number) => { returnTo.current = index; setGroup(index); };
	const web = kind === 'website' || kind === 'webpage';
	const visibleFields = web ? ENTITY_FIELDS[kind].flatMap((entry) => entry.fields) : group === null ? null : ENTITY_FIELDS[kind][group].fields;
	const label = { company: 'Company', person: 'Person', website: 'Website', webpage: 'Webpage' }[kind];
	const panelLabel = `${label} ${web ? 'actions' : 'fields'}`;
	const triggerLabel = web ? panelLabel : `Add ${kind} field column`;
	const groupLabel = group === null ? null : ENTITY_FIELDS[kind][group].label;
	return <span className="inline-flex shrink-0" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
		<button ref={trigger} type="button" aria-label={triggerLabel} title={triggerLabel} aria-haspopup="dialog" aria-expanded={Boolean(anchor)} onClick={(event) => { if (anchor) close(); else { setAnchor(event.currentTarget.getBoundingClientRect()); } }} className="grid size-4 shrink-0 place-items-center rounded text-fg-subtle hover:bg-neutral-5 hover:text-fg focus-visible:outline-brand">
			<ChevronDown className="size-3" strokeWidth={1.75} />
		</button>
		{anchor && <FloatingMenu anchor={anchor} onClose={close} width="w-64" role="dialog" label={panelLabel}>
			{groupLabel === null ? <p className={`${MENU_LABEL} flex h-8 items-center !py-0`}>{panelLabel} · Add column to right</p> : <button type="button" onClick={() => setGroup(null)} className={`${MENU_ROW} h-8 text-fg-muted hover:bg-neutral-5`}><ArrowLeft aria-hidden />{label} / {groupLabel}</button>}
			<div ref={fieldsRef} role="group" aria-label={groupLabel ?? panelLabel} className="overflow-y-auto" style={{ height: `min(40vh, 20rem, ${(web ? ENTITY_FIELDS[kind].flatMap((entry) => entry.fields).length : ENTITY_FIELDS[kind].length) * 2}rem)` }} onKeyDown={(event) => listKeys(event, visibleFields ? null : openGroup, group === null ? null : () => setGroup(null))}>
				{visibleFields ? visibleFields.map((field) => {
					const selected = selectedFields.some((entry) => entry.field === field.field);
					return <button key={field.field} type="button" role="checkbox" aria-checked={selected} onClick={() => toggleField(field)} className={`${MENU_ROW} text-fg hover:bg-neutral-5`}>
						<span className="flex-1">{field.label}</span>{selected ? <Check aria-hidden /> : <Plus aria-hidden />}
					</button>;
				}) : ENTITY_FIELDS[kind].map((entry, index) => <button key={entry.label} type="button" onClick={() => openGroup(index)} className={`${MENU_ROW} text-fg hover:bg-neutral-5`}><span className="flex-1">{entry.label}</span><ChevronRight aria-hidden /></button>)}
			</div>
			<form className="flex flex-col gap-1.5 px-1 pt-2 pb-1" onSubmit={(event) => {
				event.preventDefault();
				const question = query.trim();
				if (!question && !selectedFields.length) {
					setQuery('');
					setShake((value) => value + 1);
					queryInput.current?.focus();
					return;
				}
				const run = rowId ? { rowId, ...scope } : undefined;
				const fields: EntityField[] = selectedFields.map((field) => ({ ...field, run }));
				if (question) fields.push({ kind: 'custom', entity: kind, query: question, run, label: question.length > 80 ? `${question.slice(0, 79)}…` : question });
				onSelect(fields);
				close();
			}}>
				<div className="relative">
					<textarea ref={queryInput} aria-label="Custom query" rows={2} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={2000} placeholder="Enter a custom query" className="block min-h-16 max-h-[124px] w-full min-w-0 resize-none overflow-y-auto rounded-lg border border-line bg-surface px-2 pt-1.5 pb-4 text-caption leading-5 text-fg outline-none [field-sizing:content] placeholder:text-transparent focus:border-line focus:shadow-none" />
					{!query.trim() && <span key={shake} aria-hidden="true" data-query-placeholder className="pointer-events-none absolute top-[7px] left-[9px] text-caption leading-5 text-fg-subtle motion-reduce:animate-none" style={{ animation: shake ? 'query-placeholder-shake 320ms ease-in-out' : undefined }}>Enter a custom query</span>}
				</div>
				<RunScopeButton submit remainingRows={remainingRows} totalRows={totalRows} fieldCount={fieldCount} />
			</form>
		</FloatingMenu>}
	</span>;
}
