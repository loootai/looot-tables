'use client';

import { Info } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function HelpTooltip({ children, label = 'More information' }: { children: ReactNode; label?: string }) {
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const tooltip = useRef<HTMLSpanElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [position, setPosition] = useState<{ top: number; left: number; above: boolean; anchorTop: number; anchorLeft: number } | null>(null);
	const hide = () => { clearTimeout(timer.current); setPosition(null); };
	const show = () => {
		clearTimeout(timer.current);
		const rect = trigger.current?.getBoundingClientRect();
		if (!rect) return;
		const above = rect.bottom > window.innerHeight / 2;
		setPosition({ top: above ? rect.top : rect.bottom, left: Math.max(16, Math.min(rect.left, window.innerWidth - 304)), above, anchorTop: rect.top, anchorLeft: rect.left });
	};
	const leave = () => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			if (document.activeElement !== trigger.current) setPosition(null);
		}, 120);
	};
	useEffect(() => () => clearTimeout(timer.current), []);
	useEffect(() => {
		if (!position) return;
		const dismiss = () => setPosition(null);
		const onScroll = (event: Event) => {
			if (event.target instanceof Node && tooltip.current?.contains(event.target)) return;
			// A scroll queued before focus/click can arrive after the tooltip opens.
			// Dismiss only if the trigger has actually moved since it opened.
			const rect = trigger.current?.getBoundingClientRect();
			if (rect && rect.top === position.anchorTop && rect.left === position.anchorLeft) return;
			dismiss();
		};
		window.addEventListener('resize', dismiss);
		document.addEventListener('scroll', onScroll, true);
		return () => {
			window.removeEventListener('resize', dismiss);
			document.removeEventListener('scroll', onScroll, true);
		};
	}, [position]);
	return <span className="inline-flex shrink-0" onMouseEnter={show} onMouseLeave={leave} onKeyDown={(event) => {
		if (event.key === 'Escape' && position) { event.stopPropagation(); hide(); }
	}}>
		<button ref={trigger} type="button" data-help-trigger aria-label={label} aria-describedby={position ? id : undefined} onFocus={show} onBlur={hide} onClick={show} className="inline-flex size-6 items-center justify-center rounded-md text-fg-subtle hover:bg-neutral-5 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
			<Info aria-hidden="true" className="size-4" strokeWidth={1.75} />
		</button>
		{position && createPortal(<span ref={tooltip} id={id} role="tooltip" onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave} style={{ top: position.top, left: position.left, transform: position.above ? 'translateY(-100%)' : undefined }} className="fixed z-[60] w-72 max-w-[calc(100vw-2rem)] py-1.5 text-caption text-fg-muted">
			<span className="flex max-h-[min(20rem,45vh)] flex-col gap-2 overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-floating">{children}</span>
		</span>, document.body)}
	</span>;
}
