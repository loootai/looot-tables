'use client';

import clsx from 'clsx';
import { Check, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { Children, isValidElement, Fragment, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MENU_ROW, MENU_SURFACE } from './menu';
import { INPUT_CLASS } from './input-styles';

type Option = { value: string; label: ReactNode; text: string; disabled: boolean };
type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean };
type SelectProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'defaultValue' | 'onChange' | 'children'> & {
	value: string | number;
	variant?: 'input' | 'pill';
	onValueChange: (value: string) => void;
	children?: ReactNode;
};

function optionText(node: ReactNode): string {
	return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? optionText(child.props.children) : String(child)).join('');
}

/** Existing option markup is a declaration only; no native select or option is rendered. */
function optionsFrom(children: ReactNode): Option[] {
	return Children.toArray(children).flatMap((child) => {
		if (!isValidElement<OptionProps>(child)) return [];
		if (child.type === Fragment) return optionsFrom(child.props.children);
		if (child.type !== 'option') return [];
		const text = optionText(child.props.children);
		return [{ value: String(child.props.value ?? text), label: child.props.children, text, disabled: Boolean(child.props.disabled) }];
	});
}

/** The option a navigation key moves to, or null when the key does not navigate. */
function nextActive(key: string, active: number, enabled: number[]): number | null {
	if (key === 'Home') return enabled[0] ?? 0;
	if (key === 'End') return enabled.at(-1) ?? 0;
	if (key !== 'ArrowDown' && key !== 'ArrowUp') return null;
	const current = enabled.indexOf(active);
	return enabled[(current + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length] ?? 0;
}

/** Type-to-select: printable keys within 700 ms of each other extend one search string. */
function typeaheadText(event: KeyboardEvent, previous: { text: string; time: number }) {
	if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return null;
	const time = Date.now();
	return { text: (time - previous.time < 700 ? previous.text : '') + event.key.toLowerCase(), time };
}

export function Select({ variant = 'input', value, onValueChange, children, className, disabled, id, onKeyDown, onBlur, onClick, ...props }: SelectProps) {
	const generatedId = useId();
	const listId = `${id ?? generatedId}-options`;
	const trigger = useRef<HTMLButtonElement>(null);
	// Where the open list portals: inside an enclosing dialog so it stays within its focus trap. Resolved on open, not during render.
	const [container, setContainer] = useState<HTMLElement | null>(null);
	const open = container !== null && !disabled;
	const close = useCallback(() => setContainer(null), []);
	const [active, setActive] = useState(0);
	const search = useRef({ text: '', time: 0 });
	const options = optionsFrom(children);
	const selected = options.findIndex((option) => option.value === String(value));
	const enabled = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index !== -1);
	const openList = () => setContainer(trigger.current?.closest<HTMLElement>('dialog, [role="dialog"]') ?? document.body);
	function show(last = false) {
		setActive(selected >= 0 && !options[selected].disabled ? selected : (last ? enabled.at(-1) : enabled[0]) ?? 0);
		openList();
	}
	function choose(index: number) {
		if (!options[index] || options[index].disabled) return;
		onValueChange(options[index].value);
		close();
		trigger.current?.focus();
	}
	function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
		if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
		const next = nextActive(event.key, active, enabled);
		if (next !== null) {
			event.preventDefault();
			if (open) setActive(next);
			else {
				show(event.key === 'ArrowUp' || event.key === 'End');
				if (event.key === 'Home' || event.key === 'End') setActive(next);
			}
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			if (open) choose(active); else show();
		} else if (event.key === 'Tab') close();
		else {
			const typed = typeaheadText(event, search.current);
			if (!typed) return;
			search.current = typed;
			const match = enabled.find((index) => options[index].text.toLowerCase().startsWith(typed.text));
			if (match !== undefined) { event.preventDefault(); setActive(match); openList(); }
		}
	}
	return <>
		<button {...props} ref={trigger} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined} disabled={disabled}
			className={clsx(variant === 'pill' ? 'relative z-[2] inline-flex h-[22px] max-w-full min-w-0 items-center gap-1 rounded-full px-2 text-caption whitespace-nowrap transition-colors disabled:opacity-60' : [INPUT_CLASS, 'relative flex min-w-0 items-center gap-2 pr-9 text-left'], className)}
			onClick={(event) => { onClick?.(event); if (!event.defaultPrevented) { if (open) close(); else show(); } }}
			onBlur={(event) => { onBlur?.(event); close(); }}
			onKeyDown={(event) => { onKeyDown?.(event); if (!event.defaultPrevented && !disabled) handleKey(event); }}>
			<span className="min-w-0 flex-1 truncate">{options[selected]?.label ?? options[0]?.label ?? 'Select…'}</span>
			{variant === 'pill' ? <ChevronDown aria-hidden className="size-3 shrink-0 opacity-70" strokeWidth={1.5} /> : <ChevronsUpDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-fg-subtle" strokeWidth={1.5} />}
		</button>
		{open && container && <SelectOptions id={listId} trigger={trigger} container={container} options={options} active={active} selected={selected} onActive={setActive} onChoose={choose} onClose={close} label={props['aria-label']} labelledBy={props['aria-labelledby'] ?? (id ? `${id}-label` : undefined)} />}
	</>;
}

function SelectOptions({ id, trigger, container, options, active, selected, onActive, onChoose, onClose, label, labelledBy }: { id: string; trigger: RefObject<HTMLButtonElement | null>; container: HTMLElement; options: Option[]; active: number; selected: number; onActive: (index: number) => void; onChoose: (index: number) => void; onClose: () => void; label?: string; labelledBy?: string }) {
	const popup = useRef<HTMLDivElement>(null);
	const dismiss = useEffectEvent(() => onClose());
	useLayoutEffect(() => {
		const node = popup.current;
		if (!node || !trigger.current) return;
		function position() {
			if (!node || !trigger.current) return;
			const rect = trigger.current.getBoundingClientRect();
			const below = window.innerHeight - rect.bottom - 14;
			const above = rect.top - 14;
			const down = below >= Math.min(node.scrollHeight, 280) || below >= above;
			const maxHeight = Math.max(40, Math.min(280, down ? below : above));
			Object.assign(node.style, { width: `${Math.min(Math.max(rect.width, 160), window.innerWidth - 16)}px`, left: `${Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 160) - 8))}px`, top: down ? `${rect.bottom + 6}px` : 'auto', bottom: down ? 'auto' : `${window.innerHeight - rect.top + 6}px`, maxHeight: `${maxHeight}px`, visibility: 'visible' });
		}
		function outside(event: PointerEvent) { if (!node?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) dismiss(); }
		position();
		window.addEventListener('resize', position);
		window.addEventListener('scroll', position, true);
		document.addEventListener('pointerdown', outside, true);
		return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); document.removeEventListener('pointerdown', outside, true); };
	}, [trigger]);
	useLayoutEffect(() => { popup.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
	return createPortal(<div ref={popup} id={id} role="listbox" aria-label={label} aria-labelledby={label ? undefined : labelledBy} className={clsx(MENU_SURFACE, 'popover-in scrollbar-thin fixed z-[80] overflow-y-auto')} style={{ visibility: 'hidden' }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.preventDefault()}>
		{options.map((option, index) => <div key={option.value} id={`${id}-${index}`} data-option-index={index} role="option" aria-selected={index === selected} aria-disabled={option.disabled || undefined} onPointerMove={() => { if (!option.disabled) onActive(index); }} onClick={() => onChoose(index)} className={clsx(MENU_ROW, 'cursor-pointer', option.disabled ? 'cursor-not-allowed opacity-40' : index === active ? 'bg-blue-10 text-fg' : 'text-fg hover:bg-neutral-5')}><span className="min-w-0 flex-1 break-words">{option.label}</span>{index === selected && <Check aria-hidden className="text-brand!" strokeWidth={2} />}</div>)}
	</div>, container);
}
