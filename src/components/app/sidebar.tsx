'use client';

import { CreditsRemaining } from './credits-remaining';
import { Logo } from '@/components/ui/logo';
import clsx from 'clsx';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, LifeBuoy, LogOut, Menu, Settings, Table2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { GITHUB_URL } from '@/lib/constants';
import { SELF_HOSTED_ISSUER, type Account } from '@/lib/auth-identity';
import { db } from '@/lib/db';

const HELP_URL = `${GITHUB_URL}/blob/main/docs/usage.md`;

const NavigationContext = createContext<{ open: boolean; setOpen: (open: boolean) => void }>({ open: false, setOpen: () => {} });

/** The phone drawer's open state, shared by the drawer and the button each page puts in its header. */
export function NavigationProvider({ children }: { children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const value = useMemo(() => ({ open, setOpen }), [open]);
	return <NavigationContext value={value}>{children}</NavigationContext>;
}

/** Opens the navigation drawer on phones. It sits in the page's header row, so it never floats over content. */
export function NavigationButton({ className }: { className?: string }) {
	const { open, setOpen } = useContext(NavigationContext);
	return (
		<button type="button" aria-label="Open navigation" aria-expanded={open} aria-controls="app-navigation" onClick={() => setOpen(true)} className={clsx('grid size-11 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-tint/[0.05] hover:text-fg md:hidden', className)}>
			<Menu className="size-4" strokeWidth={1.5} />
		</button>
	);
}

/** `size` sets the row's height and padding; the default fits a top-level row. */
function linkClass(active: boolean, size = 'h-11 md:h-8 pr-2 pl-3') {
	return clsx('group/link flex items-center gap-2.5 rounded-lg text-body-sm transition-colors duration-150', size, active ? 'bg-tint/[0.07] font-medium text-neutral-80' : 'text-fg-muted hover:bg-tint/[0.04] hover:text-fg');
}

function iconClass(active: boolean) {
	return clsx('size-4 shrink-0 transition-colors', active ? 'text-neutral-80' : 'text-fg-subtle group-hover/link:text-fg-muted');
}

/** The Sheets link with every sheet listed under it. The list folds away; it starts open. */
function SheetsNav({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
	const [open, setOpen] = useState(true);
	// Newest sheet first, by creation, so editing a sheet never moves it under the pointer.
	const sheets = useLiveQuery(async () => (await db.sheets.toArray()).sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name)), []);
	const onSheet = pathname.startsWith('/app/sheets/');
	// With the list folded, the parent row stands in for whichever sheet is open.
	const active = pathname === '/app' || (!open && onSheet);
	return (
		<div className="flex flex-col gap-0.5">
			<div className="relative">
				<Link href="/app" onClick={onNavigate} aria-current={pathname === '/app' ? 'page' : undefined} className={linkClass(active, 'h-11 md:h-8 pr-12 pl-3 md:pr-9')}>
					<Table2 className={iconClass(active)} strokeWidth={1.75} />
					<span className="min-w-0 flex-1 truncate">Sheets</span>
				</Link>
				<button type="button" aria-label={open ? 'Collapse sheets' : 'Expand sheets'} aria-expanded={open} aria-controls="sidebar-sheets" onClick={() => setOpen((value) => !value)} className="absolute inset-y-0 right-0 my-auto grid size-11 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-tint/[0.05] hover:text-fg md:right-1 md:size-6">
					<ChevronDown className={clsx('size-3.5 transition-transform duration-150 motion-reduce:transition-none', !open && '-rotate-90')} strokeWidth={1.75} />
				</button>
			</div>
			<ul id="sidebar-sheets" hidden={!open} className="flex flex-col gap-0.5">
				{sheets?.length === 0 && <li className="py-1.5 pr-2 pl-[38px] text-caption text-fg-subtle">No sheets yet</li>}
				{sheets?.map((sheet) => {
					const href = `/app/sheets/${sheet.id}`;
					const current = pathname === href;
					return (
						<li key={sheet.id} className="min-w-0">
							<Link href={href} prefetch={false} onClick={onNavigate} aria-current={current ? 'page' : undefined} title={sheet.name} className={linkClass(current, 'h-11 md:h-7 pr-2 pl-[38px]')}>
								<span className="min-w-0 flex-1 truncate">{sheet.name}</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

export function Sidebar({ account }: { account: Account }) {
	const pathname = usePathname() ?? '';
	const { open: mobileOpen, setOpen: setMobileOpen } = useContext(NavigationContext);
	const drawerRef = useRef<HTMLElement>(null);
	useEffect(() => {
		if (!mobileOpen || window.matchMedia('(min-width: 768px)').matches) return;
		const drawer = drawerRef.current;
		const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const desktop = window.matchMedia('(min-width: 768px)');
		const onResize = () => { if (desktop.matches) setMobileOpen(false); };
		const main = document.querySelector('main');
		const wasInert = main?.inert ?? false;
		if (main) main.inert = true;
		drawer?.querySelector<HTMLElement>('a, button')?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLElement && event.target.closest('[role="dialog"], [role="menu"]')) return;
			if (event.key === 'Escape') { event.preventDefault(); setMobileOpen(false); }
			if (event.key !== 'Tab') return;
			const controls = [...(drawer?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])].filter((element) => element.getClientRects().length > 0);
			const first = controls[0], last = controls[controls.length - 1];
			if (!drawer?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
			else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
		};
		document.addEventListener('keydown', onKey);
		desktop.addEventListener('change', onResize);
		return () => {
			if (main) main.inert = wasInert;
			document.removeEventListener('keydown', onKey);
			desktop.removeEventListener('change', onResize);
			trigger?.focus();
		};
	}, [mobileOpen, setMobileOpen]);
	// The drawer is modal, so its own links are the only way to change pages while it's open.
	const close = () => setMobileOpen(false);
	const configurationActive = pathname.startsWith('/app/settings');

	const content = (
		<>
			<div className="flex h-11 items-center gap-2 pl-3 md:h-8">
				<Link href="/app" onClick={close} className="flex items-center gap-2">
					<Logo size={18} />
					<span className="text-body-sm font-semibold text-fg">Enrichable</span>
				</Link>
				<button type="button" aria-label="Close navigation" onClick={() => setMobileOpen(false)} className="ml-auto grid size-11 place-items-center md:size-8 rounded-lg text-fg-subtle hover:bg-tint/[0.04] md:hidden">
					<X className="size-4" strokeWidth={1.5} />
				</button>
			</div>
			<nav aria-label="App" className="mt-5 flex flex-col gap-0.5">
				<SheetsNav pathname={pathname} onNavigate={close} />
			</nav>
			<div className="min-h-6 flex-1" />
			<div className="flex flex-col gap-0.5">
				<a href={HELP_URL} target="_blank" rel="noopener noreferrer" className={linkClass(false)}>
					<LifeBuoy className={iconClass(false)} strokeWidth={1.75} />
					<span className="min-w-0 flex-1 truncate">Help</span>
				</a>
				<Link href="/app/settings" onClick={close} aria-current={configurationActive ? 'page' : undefined} className={linkClass(configurationActive)}>
					<Settings className={iconClass(configurationActive)} strokeWidth={1.75} />
					<span className="min-w-0 flex-1 truncate">Configuration</span>
				</Link>
				<div className="mt-3 flex flex-col">
					<CreditsRemaining />
				</div>
				{account.issuer === SELF_HOSTED_ISSUER
					? <p className="mt-4 border-t border-hairline px-3 pt-4 text-caption text-fg-subtle">Self-hosted</p>
					: <div className="mt-4 flex items-center gap-2 border-t border-hairline px-3 pt-4 text-caption text-fg-muted">
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium" title={account.user.email}>{account.user.name || account.user.email}</p>
							<p className="mt-0.5 truncate text-fg-subtle" title={account.organization.name}>{account.organization.name}</p>
						</div>
						<form action="/api/auth/logout" method="post" className="shrink-0"><button type="submit" aria-label="Sign out" title="Sign out" className="grid size-11 place-items-center rounded-md text-fg-subtle md:size-7 transition-colors hover:bg-tint/[0.05] hover:text-fg"><LogOut className="size-3.5" strokeWidth={1.75} /></button></form>
					</div>}
			</div>
		</>
	);

	return (
		<>
			<div aria-hidden onClick={() => setMobileOpen(false)} className={clsx('fixed inset-0 z-40 bg-scrim transition-opacity md:hidden', !mobileOpen && 'pointer-events-none opacity-0')} />
			<aside ref={drawerRef} id="app-navigation" aria-label="Workspace navigation" className={clsx('scrollbar-thin flex h-full w-[212px] shrink-0 flex-col overflow-y-auto bg-canvas px-5 pt-6 pb-5', 'max-md:fixed max-md:top-[max(0.5rem,env(safe-area-inset-top))] max-md:bottom-[max(0.5rem,env(safe-area-inset-bottom))] max-md:left-[max(0.5rem,env(safe-area-inset-left))] max-md:z-50 max-md:h-auto max-md:w-[min(19rem,calc(100vw-1rem))] max-md:overscroll-contain max-md:rounded-shell max-md:bg-surface max-md:shadow-[var(--shadow-floating)] max-md:transition-[translate,visibility] max-md:duration-200 motion-reduce:transition-none', mobileOpen ? 'max-md:translate-x-0' : 'max-md:invisible max-md:-translate-x-[calc(100%+1rem)]')}>
				{content}
			</aside>
		</>
	);
}
