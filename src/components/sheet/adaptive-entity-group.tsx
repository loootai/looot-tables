'use client';

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const CompactEntityContext = createContext(false);

/** Compact names only when their full labels would overflow the cell. */
export function AdaptiveEntityGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [compact, setCompact] = useState(false);
	useLayoutEffect(() => {
		const node = ref.current;
		if (!node) return;
		const measure = () => {
			const items = Array.from(node.children) as HTMLElement[];
			const gap = parseFloat(getComputedStyle(node).columnGap) || 0;
			const fullWidth = items.reduce((width, item) => {
				const full = item.querySelector<HTMLElement>('[data-entity-full-label]');
				const shown = item.querySelector<HTMLElement>('[data-entity-visible-label]');
				return width + item.getBoundingClientRect().width + (full && shown ? full.getBoundingClientRect().width - shown.getBoundingClientRect().width : 0);
			}, gap * Math.max(0, items.length - 1));
			setCompact(fullWidth > node.clientWidth + 0.5);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		void document.fonts.ready.then(measure);
		return () => observer.disconnect();
	}, [children]);
	return <CompactEntityContext.Provider value={compact}><span ref={ref} data-entity-group data-entity-compact={compact} className={`flex w-full min-w-0 max-w-full items-center ${className}`}>{children}</span></CompactEntityContext.Provider>;
}

export function EntityLabel({ name }: { name: string }) {
	const compact = useContext(CompactEntityContext);
	const characters = Array.from(name);
	const label = compact && characters.length > 10 ? `${characters.slice(0, 9).join('')}…` : name;
	return <span className="relative min-w-0 truncate">
		<span data-entity-full-label aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 w-max whitespace-nowrap">{name}</span>
		<span data-entity-visible-label className="block truncate">{label}</span>
	</span>;
}
