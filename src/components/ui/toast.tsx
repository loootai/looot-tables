'use client';

import clsx from 'clsx';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { announce, prepareAnnouncer } from './announcer';

interface Toast {
	id: number;
	kind: 'info' | 'success' | 'error';
	message: string;
}

const ToastContext = createContext<{ toast: (message: string, kind?: Toast['kind']) => void }>({ toast: () => {} });

const AUTO_DISMISS_MS = 4000;
let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);
	const region = useRef<HTMLDivElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	useEffect(() => prepareAnnouncer(), []);
	const dismiss = useCallback((id: number) => setToasts((list) => list.filter((entry) => entry.id !== id)), []);
	const toast = useCallback(
		(message: string, kind: Toast['kind'] = 'info') => {
			const id = ++counter;
			setToasts((list) => [...list.filter((entry) => entry.kind !== kind || entry.message !== message).slice(-3), { id, kind, message }]);
			// Errors stay until dismissed and speak through role="alert"; other kinds are announced once and expire.
			if (kind === 'error') return;
			announce(message);
			const expire = () => {
				if (region.current?.querySelector(`[data-toast="${id}"]`)?.matches(':hover, :focus-within')) setTimeout(expire, 1000);
				else dismiss(id);
			};
			setTimeout(expire, AUTO_DISMISS_MS);
		},
		[dismiss]
	);
	function close(id: number, button: HTMLButtonElement) {
		if (document.activeElement === button) {
			const buttons = [...(region.current?.querySelectorAll<HTMLButtonElement>('[data-toast-dismiss]') ?? [])];
			const index = buttons.indexOf(button);
			const next = buttons[index + 1] ?? buttons[index - 1] ?? (returnFocus.current?.isConnected ? returnFocus.current : null);
			next?.focus();
		}
		dismiss(id);
	}
	const value = useMemo(() => ({ toast }), [toast]);
	return (
		<ToastContext.Provider value={value}>
			{children}
			<div ref={region} role="region" aria-label="Notifications" onFocus={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) returnFocus.current = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null; }} className="pointer-events-none fixed right-4 bottom-4 z-[90] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
				{toasts.map((entry) => (
					<div key={entry.id} data-toast={entry.id} className="content-in pointer-events-auto flex min-h-14 items-center gap-3 rounded-window bg-surface p-3 text-body-sm shadow-[var(--shadow-floating)] outline outline-transparent">
						<span aria-hidden="true" className={clsx('grid size-7 shrink-0 place-items-center rounded-full', entry.kind === 'error' ? 'bg-danger-soft text-danger' : entry.kind === 'success' ? 'bg-success-soft text-success' : 'bg-blue-10 text-brand')}>
							{entry.kind === 'error' ? <AlertCircle className="size-4" strokeWidth={1.75} /> : entry.kind === 'success' ? <CheckCircle2 className="size-4" strokeWidth={1.75} /> : <Info className="size-4" strokeWidth={1.75} />}
						</span>
						<span role={entry.kind === 'error' ? 'alert' : undefined} className="min-w-0 flex-1 break-words leading-5 text-fg">{entry.message}</span>
						<button type="button" data-toast-dismiss aria-label="Dismiss notification" onClick={(event) => close(entry.id, event.currentTarget)} className="grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-tint/[0.05] hover:text-fg">
							<X className="size-3.5" strokeWidth={1.75} />
						</button>
					</div>
				))}
			</div>
		</ToastContext.Provider>
	);
}

export const useToast = () => useContext(ToastContext);
