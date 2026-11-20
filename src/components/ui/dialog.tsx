'use client';

import { AlertCircle, X } from 'lucide-react';
import { type FormEvent, type ReactNode, type RefObject, useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Button, IconButton } from './button';
import { Field, Input } from './field';

const WIDTHS = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
const subscribeNothing = () => () => {};
// Menus, selects and popovers portal to <body>, so a native modal <dialog> would make them inert.
// Until they move to the top layer, stacked dialogs share this list: only the top one handles Escape and Tab.
const openDialogs: object[] = [];

export function Dialog({ title, description, onClose, children, footer, size = 'md', footerNote, collapsing, collapseTarget, unframed = false }: { unframed?: boolean; title: ReactNode; description?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; footerNote?: ReactNode; size?: keyof typeof WIDTHS; collapsing?: boolean; collapseTarget?: RefObject<HTMLElement | null> }) {
	const titleId = useId();
	const descriptionId = useId();
	const ref = useRef<HTMLDivElement>(null);
	// No <body> during server render or hydration; the dialog appears on the client pass.
	const portal = useSyncExternalStore(subscribeNothing, () => document.body, () => null);
	const close = useEffectEvent(() => onClose());
	useEffect(() => {
		if (!collapsing || !ref.current) return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !collapseTarget?.current) { close(); return; }
		const node = ref.current, from = node.getBoundingClientRect(), to = collapseTarget.current.getBoundingClientRect();
		const animation = node.animate([
			{ transform: 'translate(0, 0) scale(1)', opacity: 1 },
			{ transform: `translate(${to.x + to.width / 2 - from.x - from.width / 2}px, ${to.y + to.height / 2 - from.y - from.height / 2}px) scale(${to.width / from.width}, ${to.height / from.height})`, opacity: 0 },
		], { duration: 240, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
		let cancelled = false;
		void animation.finished.then(() => { if (!cancelled) close(); }).catch(() => {});
		return () => { cancelled = true; animation.cancel(); };
	}, [collapsing, collapseTarget]);

	useEffect(() => {
		const node = ref.current;
		if (!portal || !node) return;
		const token = {};
		openDialogs.push(token);
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const first = [...node.querySelectorAll<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]):not([aria-label="Close"]):not([data-help-trigger]), [tabindex]:not([tabindex="-1"])')].find((element) => element.getClientRects().length > 0);
		// React autoFocus has already focused the intended field during mount.
		if (!node.contains(document.activeElement)) (first ?? node).focus();
		const onKey = (event: KeyboardEvent) => {
			if (openDialogs.at(-1) !== token) return;
			if (event.key === 'Escape') {
				// Let the sortable sensor cancel its active drag before closing the dialog.
				if (node.querySelector('[data-slot="sortable"][data-dragging="true"]')) return;
				event.stopPropagation();
				close();
			}
			if (event.key === 'Tab') {
				const focusable = [...node.querySelectorAll<HTMLElement>('a[href], summary, button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length > 0);
				if (focusable.length === 0) return;
				const firstEl = focusable[0];
				const lastEl = focusable[focusable.length - 1];
				if (event.shiftKey && document.activeElement === firstEl) {
					event.preventDefault();
					lastEl.focus();
				} else if (!event.shiftKey && document.activeElement === lastEl) {
					event.preventDefault();
					firstEl.focus();
				}
			}
		};
		document.addEventListener('keydown', onKey);
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			openDialogs.splice(openDialogs.indexOf(token), 1);
			if (!openDialogs.length) document.body.style.overflow = '';
			// The opener can be gone (a menu item, a replaced button); then focus stays where the page puts it.
			if (previous?.isConnected) previous.focus();
		};
	}, [portal]);

	if (!portal) return null;
	// A confirmation with nothing to add below its description skips the empty body.
	const hasBody = children !== null && children !== undefined && children !== false && children !== '';
	return createPortal(
		<div role="presentation" className="fade-in fixed inset-0 z-50 flex flex-col items-center overflow-y-auto overscroll-contain bg-scrim backdrop-blur-[3px] px-4 pt-[10vh] pb-8 max-md:pt-[max(1rem,env(safe-area-inset-top))] max-md:pb-[max(1rem,env(safe-area-inset-bottom))] max-md:pl-[max(0.75rem,env(safe-area-inset-left))] max-md:pr-[max(0.75rem,env(safe-area-inset-right))]" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} className={`${unframed ? '' : 'glass-frame glass-floating'} content-in flex max-h-[calc(90dvh-2rem)] w-full flex-col max-md:max-h-[calc(100dvh-max(1rem,env(safe-area-inset-top))-max(1rem,env(safe-area-inset-bottom)))] ${WIDTHS[size]} outline-none`}>
				{unframed ? <><h2 id={titleId} className="sr-only">{title}</h2>{description && <p id={descriptionId} className="sr-only">{description}</p>}<div className="scrollbar-thin min-h-0 overflow-y-auto p-1">{children}</div></> : <div className="flex min-h-0 flex-col overflow-hidden rounded-window bg-surface">
					<div className={clsx('flex shrink-0 items-start gap-4 px-5 pt-5', !hasBody && 'pb-5')}>
						<div className="min-w-0 flex-1">
							<h2 id={titleId} className="text-h5 text-fg">
								{title}
							</h2>
							{description && <p id={descriptionId} className="mt-1.5 text-body-sm text-fg-muted">{description}</p>}
						</div>
						<IconButton label="Close" onClick={onClose} className="-mt-1.5 -mr-2">
							<X strokeWidth={1.5} />
						</IconButton>
					</div>
					{hasBody && <div className="scrollbar-thin min-h-0 overflow-y-auto overscroll-contain px-5 pt-5 pb-5">{children}</div>}
					{footer && (
						<div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line-subtle px-5 py-3.5">
							<div className="min-w-0 text-caption text-fg-subtle">{footerNote}</div>
							<div className="ml-auto flex flex-wrap items-center justify-end gap-2">{footer}</div>
						</div>
					)}
				</div>}
			</div>
		</div>,
		portal
	);
}

/** An inline failure inside a dialog. Link it from the control it explains with aria-describedby. */
export function DialogError({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
	return (
		<p id={id} role="alert" className={clsx('flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-body-sm text-danger-strong', className)}>
			<AlertCircle aria-hidden className="mt-px size-4 shrink-0" strokeWidth={1.75} />
			<span className="min-w-0 break-words">{children}</span>
		</p>
	);
}

type ActionState = { status: 'idle' } | { status: 'pending' } | { status: 'failed'; error: string };

/** idle → pending → idle | failed. One action at a time; a rejection stays in the dialog instead of closing it. */
function useDialogAction() {
	const [state, setState] = useState<ActionState>({ status: 'idle' });
	const busy = useRef(false);
	async function run(action: () => unknown, onSuccess: (async: boolean) => void) {
		if (busy.current) return;
		busy.current = true;
		setState({ status: 'pending' });
		try {
			const result = action();
			const async = typeof (result as PromiseLike<unknown> | undefined)?.then === 'function';
			if (async) await result;
			setState({ status: 'idle' });
			onSuccess(async);
		} catch (error) {
			setState({ status: 'failed', error: error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.' });
		} finally {
			busy.current = false;
		}
	}
	return { state, run, reset: () => setState({ status: 'idle' }) };
}

/**
 * An async onConfirm keeps the dialog busy until it settles, shows a rejection inline, and closes on success.
 * Callers that track the work themselves (a synchronous onConfirm, or one passing `loading`) also close it themselves.
 */
export function ConfirmDialog({ title, description, confirmLabel = 'Confirm', danger, onConfirm, onClose, loading }: { title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void; loading?: boolean }) {
	const errorId = useId();
	const { state, run } = useDialogAction();
	const pending = Boolean(loading) || state.status === 'pending';
	const close = () => { if (!pending) onClose(); };
	return (
		<Dialog
			title={title}
			description={description}
			onClose={close}
			size="sm"
			footer={
				<>
					<Button size="sm" onClick={close} disabled={pending}>Cancel</Button>
					<Button size="sm" variant={danger ? 'danger' : 'brand'} loading={pending} aria-describedby={state.status === 'failed' ? errorId : undefined} onClick={() => void run(onConfirm, (async) => { if (async && loading === undefined) onClose(); })}>
						{confirmLabel}
					</Button>
				</>
			}
		>
			{state.status === 'failed' && <DialogError id={errorId}>{state.error}</DialogError>}
		</Dialog>
	);
}

/** A one-field form: Enter submits (never mid-IME-composition), and the dialog closes only once onSubmit settles. */
export function NameDialog({ title, initial, confirmLabel, label = 'Name', onClose, onSubmit }: { title: string; initial: string; confirmLabel: string; label?: string; onClose: () => void; onSubmit: (name: string) => void | Promise<void> }) {
	const formId = useId();
	const [name, setName] = useState(initial);
	const { state, run, reset } = useDialogAction();
	const pending = state.status === 'pending';
	const failed = state.status === 'failed';
	const trimmed = name.trim();
	const close = () => { if (!pending) onClose(); };
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (trimmed) void run(() => onSubmit(trimmed), onClose);
	};
	return (
		<Dialog
			title={title}
			onClose={close}
			size="sm"
			footer={
				<>
					<Button size="sm" onClick={close} disabled={pending}>Cancel</Button>
					<Button size="sm" variant="brand" type="submit" form={formId} loading={pending} disabled={!trimmed}>{confirmLabel}</Button>
				</>
			}
		>
			<form id={formId} onSubmit={submit} noValidate>
				{/* Field links the error to the input (aria-invalid, aria-describedby) and announces it. */}
				<Field label={label} error={failed ? state.error : undefined}>{(id) => <Input id={id} value={name} autoFocus readOnly={pending} onFocus={(event) => event.target.select()} onChange={(event) => { setName(event.target.value); if (failed) reset(); }} />}</Field>
			</form>
		</Dialog>
	);
}
