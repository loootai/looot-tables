'use client';

import clsx from 'clsx';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

const MENU_ITEM_SELECTOR = ':is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]):not([disabled])';
const DIALOG_FOCUSABLE = ':is(button, input, textarea, select):not([disabled]), [tabindex]:not([tabindex="-1"])';

// The transparent outline only shows in forced-colors mode, where the box-shadow edge is dropped.
export const MENU_SURFACE = 'rounded-shell bg-surface p-1.5 shadow-[0_0_0_1px_var(--color-hairline),0_0.5rem_1.5rem_-0.5rem_rgb(0_0_0/0.16)] outline outline-transparent';
export const MENU_ROW = 'relative flex w-full max-md:min-h-11 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-body-sm leading-5 transition-colors focus:bg-tint/[0.06] focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-fg-subtle [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-subtle';
export const MENU_LABEL = 'px-2.5 pt-1.5 pb-1 text-caption text-fg-subtle';
export const MENU_SEPARATOR = 'mx-0 my-1 h-px shrink-0 border-0 bg-line-subtle';

const NO_REFS: RefObject<HTMLElement | null>[] = [];
/** Open dismissable layers, newest last. Only the newest answers Escape, and pressing inside a newer layer (a nested menu portaled elsewhere) keeps older ones open. */
const layers: RefObject<HTMLElement | null>[] = [];

export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void, extraRefs: RefObject<HTMLElement | null>[] = NO_REFS, onEscape?: () => void) {
	const dismiss = useEffectEvent(close);
	const escape = useEffectEvent(() => (onEscape ?? close)());
	useEffect(() => {
		if (!open) return;
		layers.push(ref);
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node;
			if (ref.current?.contains(target)) return;
			if (extraRefs.some((extra) => extra.current?.contains(target))) return;
			if (layers.slice(layers.indexOf(ref) + 1).some((layer) => layer.current?.contains(target))) return;
			dismiss();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || layers.at(-1) !== ref) return;
			event.stopPropagation();
			escape();
		};
		document.addEventListener('pointerdown', onPointer, true);
		document.addEventListener('keydown', onKey, true);
		return () => {
			layers.splice(layers.indexOf(ref), 1);
			document.removeEventListener('pointerdown', onPointer, true);
			document.removeEventListener('keydown', onKey, true);
		};
	}, [open, ref, extraRefs]);
}

export interface MenuItem {
	label: ReactNode;
	icon?: ReactNode;
	onSelect?: () => void;
	danger?: boolean;
	disabled?: boolean;
	/** Set (true or false) on one-of-a-set options; they render as menuitemradio. */
	checked?: boolean;
	hint?: string;
	separator?: boolean;
	heading?: string;
	items?: MenuItem[];
}

/** Content-derived keys: rows are identified by their label, separators and unlabeled rows by what precedes them. */
function itemKeys(items: MenuItem[]) {
	const seen = new Map<string, number>();
	let previous = 'start';
	return items.map((item) => {
		const base = item.heading ? `heading:${item.heading}` : item.separator ? `separator:${previous}` : typeof item.label === 'string' ? `item:${item.label}` : `item:${previous}`;
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		previous = count ? `${base}#${count}` : base;
		return previous;
	});
}

const noSubscription = () => () => {};

/** A floating menu anchored to a rectangle (portaled so it escapes scroll containers). `role="dialog"` hosts form content instead of menu items. */
export function FloatingMenu({ anchor, items, onClose, align = 'left', width = 'w-56', children, portalTarget, role = 'menu', label, labelledBy, enter }: { anchor: DOMRect | { x: number; y: number }; items?: MenuItem[]; onClose: () => void; align?: 'left' | 'right'; width?: string; children?: ReactNode; portalTarget?: HTMLElement; role?: 'menu' | 'dialog'; label?: string; labelledBy?: string; enter?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const menuId = useId();
	const [submenus, setSubmenus] = useState<Array<{ label: ReactNode; items: MenuItem[]; trigger: HTMLButtonElement; left: number; top: number }>>([]);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	const positioned = position !== null;
	const portalRoot = useSyncExternalStore(noSubscription, () => portalTarget ?? document.body, () => null);
	useDismiss(ref, true, onClose, NO_REFS, () => (submenus.length ? closeSubmenu() : onClose()));
	// A dialog takes focus when it opens. A trigger's menu does only on keyboard opens; pointer opens keep focus on the trigger
	// until ArrowDown/ArrowUp. Point-anchored context menus have no trigger and take focus like native ones.
	const focusOnOpen = useEffectEvent((node: HTMLElement | null, previous: Element | null) => {
		if (role === 'dialog') node?.querySelector<HTMLElement>(DIALOG_FOCUSABLE)?.focus();
		else if (enter ?? (!('width' in anchor) || previous?.matches(':focus-visible'))) node?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus();
	});
	useEffect(() => {
		if (!positioned) return;
		const node = ref.current;
		const previous = document.activeElement as HTMLElement | null;
		focusOnOpen(node, previous);
		const onKey = (event: KeyboardEvent) => {
			if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || layers.at(-1) !== ref || !node || node.contains(document.activeElement)) return;
			const rows = [...node.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)].filter((row) => row.closest('[role="menu"]') === node);
			if (!rows.length) return;
			event.preventDefault();
			event.stopPropagation();
			rows.at(event.key === 'ArrowDown' ? 0 : -1)?.focus();
		};
		document.addEventListener('keydown', onKey, true);
		return () => {
			document.removeEventListener('keydown', onKey, true);
			if (node?.contains(document.activeElement) || document.activeElement === document.body) previous?.focus();
		};
	}, [positioned]);
	useEffect(() => {
		const panel = ref.current?.querySelectorAll('[data-submenu]')[submenus.length - 1];
		if (panel && !panel.contains(document.activeElement)) panel.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus();
	}, [submenus]);
	function closeSubmenu() {
		submenus.at(-1)?.trigger.focus();
		setSubmenus((panels) => panels.slice(0, -1));
	}
	function openSubmenu(item: MenuItem, trigger: HTMLButtonElement, depth: number) {
		if (!item.items) return;
		if (submenus[depth]?.trigger === trigger) {
			setSubmenus((panels) => panels.slice(0, depth));
			return;
		}
		const row = trigger.getBoundingClientRect();
		const menu = trigger.closest('[role="menu"]')!.getBoundingClientRect();
		const root = ref.current!.getBoundingClientRect();
		const width = 224;
		const preferredLeft = menu.right + width + 8 > window.innerWidth ? menu.left - width - 4 : menu.right + 4;
		const panel = { label: item.label, items: item.items, trigger, left: Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8)) - root.left, top: Math.max(8, Math.min(row.top, window.innerHeight - (item.items.length + 1) * 36 - 24)) - root.top };
		setSubmenus((panels) => [...panels.slice(0, depth), panel]);
	}
	function navigate(event: ReactKeyboardEvent<HTMLDivElement>) {
		if (!(event.target instanceof HTMLElement) || !event.target.matches(MENU_ITEM_SELECTOR)) return;
		// React bubbles keys from nested FloatingMenus through portals; each menu handles only its own rows.
		if (event.target.closest('[data-floating-menu]') !== ref.current) return;
		const menu = event.target.closest('[role="menu"]');
		const rows = [...(menu?.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR) ?? [])].filter((row) => row.closest('[role="menu"]') === menu);
		const index = rows.indexOf(event.target as HTMLButtonElement);
		if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
			event.preventDefault();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
			rows[next]?.focus();
		} else if (event.key === 'ArrowRight' && event.target.getAttribute('aria-haspopup') === 'menu') {
			event.preventDefault();
			event.target.click();
		} else if (event.key === 'ArrowLeft' && submenus.length) {
			event.preventDefault();
			closeSubmenu();
		} else if (event.key === 'Tab' && items) onClose();
	}
	const closeOnResize = useEffectEvent(() => onClose());
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const rect = node.getBoundingClientRect();
		const anchorRect = 'width' in anchor ? anchor : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
		let left = align === 'right' ? anchorRect.right - rect.width : anchorRect.left;
		let top = anchorRect.bottom + 6;
		if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
		if (left < 8) left = 8;
		if (top + rect.height > window.innerHeight - 8) top = Math.max(8, anchorRect.top - rect.height - 6);
		setPosition({ left, top });
	}, [anchor, align]);
	useEffect(() => {
		const onResize = () => closeOnResize();
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}, []);
	function renderRow(item: MenuItem, key: string, depth: number) {
		return (
			<button
				key={key}
				type="button"
				role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
				aria-checked={item.checked}
				disabled={item.disabled}
				aria-haspopup={item.items ? 'menu' : undefined}
				aria-expanded={item.items ? submenus[depth]?.items === item.items : undefined}
				onClick={(event) => {
					if (item.items) {
						openSubmenu(item, event.currentTarget, depth);
						return;
					}
					item.onSelect?.();
					onClose();
				}}
				className={clsx(MENU_ROW, item.danger ? 'text-danger hover:bg-danger-soft [&_svg]:text-danger' : 'text-fg hover:bg-tint/[0.05]', item.disabled && 'opacity-40')}
			>
				{item.icon}
				<span className={clsx('min-w-0 flex-1', depth === 0 && 'truncate')}>{item.label}</span>
				{item.hint && <span className="text-caption text-fg-subtle">{item.hint}</span>}
				{item.checked && <Check aria-hidden className="text-brand" strokeWidth={2} />}
				{item.items && <ChevronRight aria-hidden strokeWidth={1.75} />}
			</button>
		);
	}
	/** Rows after a heading form a group named by it, up to the next separator or heading. */
	function renderItems(entries: MenuItem[], depth: number) {
		const keys = itemKeys(entries);
		const output: ReactNode[] = [];
		let group: { key: string; labelId: string; rows: ReactNode[] } | null = null;
		const flush = (current: typeof group) => { if (current) output.push(<div key={`group:${current.key}`} role="group" aria-labelledby={current.labelId} className="flex flex-col gap-0.5">{current.rows}</div>); };
		entries.forEach((item, index) => {
			if (item.separator || item.heading) {
				flush(group);
				group = null;
			}
			if (item.separator) output.push(<hr key={keys[index]} className={MENU_SEPARATOR} />);
			else if (item.heading) {
				const labelId = `${menuId}-heading-${depth}-${index}`;
				output.push(<p key={keys[index]} id={labelId} aria-hidden className={MENU_LABEL}>{item.heading}</p>);
				group = { key: keys[index], labelId, rows: [] };
			} else (group?.rows ?? output).push(renderRow(item, keys[index], depth));
		});
		flush(group);
		return output;
	}
	if (!portalRoot) return null;
	return createPortal(
		<div ref={ref} data-floating-menu role={role} aria-label={label} aria-labelledby={label ? undefined : labelledBy} onKeyDown={navigate} className={clsx('popover-in fixed z-[70] max-w-[calc(100vw-1rem)]', MENU_SURFACE, width)} style={{ left: position?.left ?? -9999, top: position?.top ?? -9999, visibility: position ? 'visible' : 'hidden' }}>
			{children}
			{items && <div className="flex max-h-[70vh] min-w-0 flex-col gap-0.5 overflow-x-hidden overflow-y-auto">{renderItems(items, 0)}</div>}
			{submenus.map((panel, depth) => (
				<div key={`submenu:${depth}`} data-submenu role="menu" aria-label={typeof panel.label === 'string' ? panel.label : undefined} className={clsx('scrollbar-thin absolute max-h-[70vh] w-56 max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto', MENU_SURFACE)} style={{ left: panel.left, top: panel.top }}>
					<button type="button" role="menuitem" onClick={() => { panel.trigger.focus(); setSubmenus((panels) => panels.slice(0, depth)); }} className={clsx(MENU_ROW, 'text-fg-muted hover:bg-neutral-5')}><ChevronLeft aria-hidden />Back</button>
					{renderItems(panel.items, depth + 1)}
				</div>
			))}
		</div>,
		portalRoot
	);
}

/** A trigger that opens a FloatingMenu beneath itself. */
export function MenuButton({ items, children, align = 'left', className, width, render, label }: { items?: MenuItem[]; children: ReactNode; align?: 'left' | 'right'; className?: string; width?: string; render?: (close: () => void) => ReactNode; label?: string }) {
	const [menu, setMenu] = useState<{ anchor: DOMRect; enter: boolean } | null>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const triggerId = useId();
	const open = (enter: boolean) => { const anchor = buttonRef.current?.getBoundingClientRect(); if (anchor) setMenu({ anchor, enter }); };
	return (
		<>
			<button ref={buttonRef} id={triggerId} type="button" aria-label={label} aria-haspopup="menu" aria-expanded={menu !== null} onClick={(event) => { if (menu) setMenu(null); else open(event.detail === 0); }} onKeyDown={(event) => { if (event.key === 'ArrowDown' && !menu) { event.preventDefault(); open(true); } }} className={className}>
				{children}
			</button>
			{menu && (
				<FloatingMenu anchor={menu.anchor} items={items} align={align} width={width} labelledBy={triggerId} enter={menu.enter} onClose={() => setMenu(null)}>
					{render?.(() => setMenu(null))}
				</FloatingMenu>
			)}
		</>
	);
}
