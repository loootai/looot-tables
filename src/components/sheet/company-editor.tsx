'use client';

import { useSettings } from '@/components/app/settings-context';
import { isImeComposing } from '@/components/ui/keyboard';
import { COMPANY_SEARCH_DELAY_MS, COMPANY_SEARCH_MIN_LENGTH, type CompanySuggestion } from '@/lib/company-search';
import { contextRequest } from '@/lib/context-credits';
import { keyHeaders } from '@/lib/keys';
import { logoLinkUrl } from '@/lib/organization-logo';
import { Building2 } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { LogoLinkImage } from './logolink-image';

function CompanyPreview({ domain, clientId }: { domain: string; clientId: string }) {
	return <LogoLinkImage src={clientId ? logoLinkUrl(clientId, domain) : null} size={28} className="rounded-md" fallback={<Building2 className="size-4 text-fg-subtle" strokeWidth={1.5} />} />;
}

type Position = { left: number; top: number; width: number; maxHeight: number };
type Search = { query: string; companies: CompanySuggestion[]; error?: string };

const VARIANTS = {
	inline: { wrapper: 'absolute inset-0 z-10', input: 'h-full w-full bg-surface px-3 text-body-sm text-fg shadow-[inset_0_0_0_1.5px_var(--color-brand)] outline-none' },
	panel: { wrapper: 'relative', input: 'h-9 w-full rounded-lg border border-line bg-surface px-3 text-body-sm text-fg outline-none focus:border-brand' },
};
const subscribeNothing = () => () => {};
const searchable = (query: string) => query.length >= COMPANY_SEARCH_MIN_LENGTH && query.length <= 200;

/** Shared company combobox for inline and detail-panel edits. Free text remains valid. */
export function CompanyEditor({ value, onChange, onSelect, onCommit, onCancel, onBlur, autoFocus = true, selectInitial, inline }: {
	value: string;
	onChange: (value: string) => void;
	onSelect: (company: CompanySuggestion) => void;
	onCommit: () => void;
	onCancel: () => void;
	onBlur?: () => void;
	autoFocus?: boolean;
	selectInitial?: boolean;
	inline?: boolean;
}) {
	const { settings, server } = useSettings();
	const input = useRef<HTMLInputElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const listId = useId();
	const [focused, setFocused] = useState(false);
	const [typed, setTyped] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [active, setActive] = useState(-1);
	const query = value.trim();
	const canSearch = Boolean(settings.contextKey || server?.context);
	const open = focused && !dismissed && !query.startsWith('=');
	const eligible = open && typed && canSearch && searchable(query);
	const current = useCompanySearch(query, eligible);
	const companies = eligible ? current?.companies ?? [] : [];
	const position = useAnchoredPosition(open, input, popup, current, companies.length);

	useLayoutEffect(() => {
		if (autoFocus) input.current?.focus();
		if (selectInitial) input.current?.select();
	}, [autoFocus, selectInitial]);

	useEffect(() => {
		if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
	}, [active, listId]);

	function choose(company: CompanySuggestion) {
		setDismissed(true);
		setActive(-1);
		onSelect(company);
	}
	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		event.stopPropagation();
		if (isImeComposing(event)) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			setDismissed(false);
			if (companies.length) setActive((index) => event.key === 'ArrowDown' ? (index + 1) % companies.length : (index <= 0 ? companies.length : index) - 1);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (open && active >= 0 && companies[active]) choose(companies[active]); else onCommit();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			if (open) setDismissed(true); else onCancel();
		} else if (event.key === 'Tab') {
			if (inline) { event.preventDefault(); onCommit(); }
			else setDismissed(true);
		}
	}
	const variant = VARIANTS[inline ? 'inline' : 'panel'];
	return <div data-company-editor className={variant.wrapper} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
		<input ref={input} role="combobox" aria-label="Company" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={optionId(listId, active, companies)} autoComplete="off" spellCheck={false} value={value}
			onFocus={() => { setFocused(true); setDismissed(false); }}
			onChange={(event) => { setTyped(true); setDismissed(false); setActive(-1); onChange(event.target.value); }}
			onBlur={() => { setFocused(false); onBlur?.(); }}
			onKeyDown={onKeyDown}
			className={variant.input} />
		{open && <CompanySuggestions ref={popup} id={listId} busy={eligible && !current} position={position} companies={companies} active={active} onActive={setActive} onChoose={choose} message={searchMessage(canSearch, typed, query, current)} />}
	</div>;
}

const optionId = (listId: string, active: number, companies: CompanySuggestion[]) => active >= 0 && companies[active] ? `${listId}-${active}` : undefined;

function searchMessage(canSearch: boolean, typed: boolean, query: string, current: Search | null) {
	if (!canSearch) return 'Connect Context.dev in Configuration to search companies.';
	if (!typed || query.length < 3) return 'Type at least 3 characters to search companies.';
	if (query.length > 200) return 'Use up to 200 characters to search.';
	return current?.error ?? (!current ? 'Searching…' : 'No companies found. You can enter a name manually.');
}

/** Debounced, cached Context.dev company search for `query` while `eligible`; null until results for it arrive. */
function useCompanySearch(query: string, eligible: boolean) {
	const { settings } = useSettings();
	const [search, setSearch] = useState<Search | null>(null);
	const cache = useRef(new Map<string, CompanySuggestion[]>());
	useEffect(() => {
		if (!eligible) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			const cacheKey = JSON.stringify([query.toLowerCase(), settings.contextKey, settings.accessPassword]);
			const cached = cache.current.get(cacheKey);
			if (cached) { setSearch({ query, companies: cached }); return; }
			void contextRequest('/api/companies/search', { method: 'POST', headers: keyHeaders(settings), body: JSON.stringify({ query }), signal: controller.signal })
				.then(async (response) => {
					const data = await response.json() as { companies?: CompanySuggestion[]; error?: string };
					if (!response.ok) throw new Error(data.error ?? 'Company search is unavailable. You can still enter a company manually.');
					if (controller.signal.aborted) return;
					const results = data.companies ?? [];
					if (cache.current.size >= 20) cache.current.delete(cache.current.keys().next().value!);
					cache.current.set(cacheKey, results);
					setSearch({ query, companies: results });
				})
				.catch((error: unknown) => {
					if (!controller.signal.aborted) setSearch({ query, companies: [], error: error instanceof Error ? error.message : 'Company search is unavailable. You can still enter a company manually.' });
				});
		}, COMPANY_SEARCH_DELAY_MS);
		return () => { clearTimeout(timer); controller.abort(); };
	}, [eligible, query, settings]);
	return search?.query === query ? search : null;
}

/** Fixed position for the suggestions under the input, flipping above it when there is more room there. Re-placed as results arrive. */
function useAnchoredPosition(open: boolean, anchor: RefObject<HTMLElement | null>, popup: RefObject<HTMLElement | null>, results: Search | null, count: number) {
	const [position, setPosition] = useState<Position | null>(null);
	useLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			const rect = anchor.current?.getBoundingClientRect();
			if (!rect) return;
			const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 16);
			const below = window.innerHeight - rect.bottom - 12;
			const above = rect.top - 12;
			const height = Math.min(popup.current?.scrollHeight ?? 300, 320);
			const upwards = below < height && above > below;
			const maxHeight = Math.max(40, Math.min(320, upwards ? above : below));
			setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: upwards ? Math.max(8, rect.top - Math.min(height, maxHeight) - 4) : rect.bottom + 4, width, maxHeight });
		};
		place();
		window.addEventListener('scroll', place, true);
		window.addEventListener('resize', place);
		return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
	}, [open, anchor, popup, results, count]);
	return position;
}

const popupStyle = (position: Position | null) => ({ left: position?.left ?? -9999, top: position?.top ?? -9999, width: position?.width ?? 280, maxHeight: position?.maxHeight ?? 320 });

function CompanySuggestions({ ref, id, busy, position, companies, active, onActive, onChoose, message }: { ref: RefObject<HTMLDivElement | null>; id: string; busy: boolean; position: Position | null; companies: CompanySuggestion[]; active: number; onActive: (index: number) => void; onChoose: (company: CompanySuggestion) => void; message: string }) {
	const { settings } = useSettings();
	// No <body> during a server render; the list only opens on the client.
	const portal = useSyncExternalStore(subscribeNothing, () => document.body, () => null);
	if (!portal) return null;
	return createPortal(<div ref={ref} id={id} role="listbox" aria-label="Company suggestions" aria-busy={busy} className="fixed z-[80] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg" style={popupStyle(position)} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }} onClick={(event) => event.stopPropagation()}>
		{companies.length ? companies.map((company, index) => <div key={company.domain} id={`${id}-${index}`} role="option" aria-selected={active === index} onMouseEnter={() => onActive(index)} onClick={() => onChoose(company)} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 ${active === index ? 'bg-blue-10' : 'hover:bg-neutral-5'}`}>
			<CompanyPreview key={`${company.domain}:${settings.logolinkKey}`} domain={company.domain} clientId={settings.logolinkKey} />
			<span className="flex min-w-0 flex-col"><span className="truncate text-body-sm text-fg">{company.name}</span><span className="truncate text-caption text-fg-subtle">{company.domain}</span></span>
		</div>) : <div role="status" className="px-2 py-2 text-caption text-fg-muted">{message}</div>}
	</div>, portal);
}
