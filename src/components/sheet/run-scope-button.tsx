'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { ChevronDown } from 'lucide-react';
import { accountStorageKey } from '@/lib/account-storage';
import { parseRunCount, runScopeChoice, type RunCount, type RunScope } from '@/lib/run-scope';
import { Button } from '@/components/ui/button';
import { FloatingMenu } from '@/components/ui/menu';

export type { RunCount, RunScope };

// A per-person browser preference: one member's choice never changes a teammate's default or races settings saves.
const listeners = new Set<() => void>();
const memory = new Map<string, RunCount>();
const storageKey = () => accountStorageKey('enrichable.run-scope.v2');
function snapshot(): RunCount {
	try {
		const key = storageKey();
		try { return parseRunCount(localStorage.getItem(key)); } catch { return memory.get(key) ?? 1; }
	} catch { return 1; }
}
function subscribe(listener: () => void) {
	listeners.add(listener);
	window.addEventListener('storage', listener);
	return () => { listeners.delete(listener); window.removeEventListener('storage', listener); };
}
function remember(count: RunCount) {
	try {
		const key = storageKey();
		memory.set(key, count);
		localStorage.setItem(key, String(count));
	} catch { /* The in-memory choice still applies for this session. */ }
	listeners.forEach((listener) => listener());
}

export function useRunScope(remainingRows: number, totalRows: number, startRow?: number, override?: RunCount | null) {
	const saved = useSyncExternalStore(subscribe, snapshot, () => 1 as const);
	return runScopeChoice(override ?? saved, remainingRows, totalRows, startRow);
}

/** Shared by chip extensions and AI column setup. */
/** `tryFirst`: a new column, which offers "Try 5 rows" before the whole column. */
export function RunScopeButton({ remainingRows, totalRows, startRow, onRun, submit = false, disabled, loading, fieldCount, className, tryFirst = false }: { className?: string; remainingRows: number; totalRows: number; startRow?: number; onRun?: (scope: RunScope) => void; submit?: boolean; disabled?: boolean; loading?: boolean; fieldCount?: number; tryFirst?: boolean }) {
	const [override, setOverride] = useState<RunCount | null>(tryFirst && totalRows > 5 ? 5 : null);
	const { scope, label, options, selected } = useRunScope(remainingRows, totalRows, startRow, override);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
	const [portalTarget, setPortalTarget] = useState<HTMLElement>();
	const wrapper = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const choosable = totalRows > 1;
	const toggle = () => {
		// Inside a chip's popover, render the scope menu within it so choosing a scope doesn't dismiss the popover.
		setPortalTarget(wrapper.current?.closest<HTMLElement>('[data-floating-menu]') ?? undefined);
		setAnchor(anchor ? null : wrapper.current?.getBoundingClientRect() ?? null);
	};
	return <div ref={wrapper} className={`relative flex gap-0.5 ${className ?? ''}`}>
		<Button type={submit ? 'submit' : 'button'} size="sm" variant="primary" disabled={disabled || totalRows === 0} loading={loading} onClick={() => onRun?.(scope)} className={`min-w-0 flex-1 !whitespace-normal bg-brand px-2 text-caption leading-3.5 text-brand-fg ${choosable ? 'rounded-r-none' : ''}`} aria-label={fieldCount === undefined ? label : `${label}, ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} selected`}>
			<span className="min-w-0 flex-1">{label}</span>
			{fieldCount !== undefined && <span aria-hidden className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-white/20 px-1 text-[11px] font-medium tabular-nums">{fieldCount}</span>}
		</Button>
		{choosable && <Button ref={trigger} size="sm" variant="primary" disabled={disabled || loading} aria-label="Choose which rows to run" aria-haspopup="menu" aria-expanded={anchor !== null} className="w-8 rounded-l-none bg-brand px-0 text-brand-fg" onClick={toggle}><ChevronDown className="size-3.5" /></Button>}
		{anchor && <FloatingMenu portalTarget={portalTarget} label="Run scope" anchor={anchor} align="right" width="w-64" onClose={() => { setAnchor(null); trigger.current?.focus(); }} items={options.map((option) => ({ label: option.label, checked: selected === option.value, onSelect: () => { setOverride(null); remember(option.value); } }))} />}
	</div>;
}
