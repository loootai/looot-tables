import { memo, type CSSProperties, type ReactNode, useLayoutEffect, useRef } from 'react';

export function RowArrival({ at, column, slot, loading, expandDelay = 0, onTextStart, children }: { at?: number; column: number; slot: number; loading: boolean; expandDelay?: number; onTextStart: (slot: number) => void; children?: ReactNode }) {
	const ref = useRef<HTMLSpanElement>(null);
	const dotsRef = useRef<HTMLSpanElement>(null);
	const loadingSince = useRef<number | null>(null);
	useLayoutEffect(() => {
		if (!ref.current || !dotsRef.current) return;
		if (at === undefined) {
			if (loading && loadingSince.current === null) loadingSince.current = Date.now();
			if (!loading || !expandDelay || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
			const expand = dotsRef.current.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 130, delay: expandDelay, fill: 'both', easing: 'ease-out' });
			return () => expand.cancel();
		}
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			ref.current.style.opacity = '1';
			dotsRef.current.style.opacity = '0';
			if (column === 0) onTextStart(slot);
			return;
		}
		// Resolve the existing frontier into blue dots before replacing them. Fast
		// responses must not skip the loader or introduce text in an empty cell.
		const age = loadingSince.current === null ? 0 : Date.now() - loadingSince.current;
		const delay = Math.max(100, 260 - age) + Math.min(440, column * 110);
		const dots = dotsRef.current.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, delay, fill: 'both', easing: 'ease-out' });
		const animation = ref.current.animate([
			{ opacity: 0, transform: 'translateY(5px)', filter: 'blur(2px)' },
			{ opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
		], { duration: 520, delay, fill: 'both', easing: 'cubic-bezier(.22, 1, .36, 1)' });
		let handoff: number | undefined;
		if (column === 0) {
			const advance = () => {
				if (Number(animation.currentTime) >= delay) onTextStart(slot);
				else handoff = requestAnimationFrame(advance);
			};
			handoff = requestAnimationFrame(advance);
		}
		return () => { if (handoff !== undefined) cancelAnimationFrame(handoff); dots.cancel(); animation.cancel(); };
	}, [at, column, slot, loading, expandDelay, onTextStart]);
	return <span className="row-arrival-cell" style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%', minWidth: 0, maxWidth: '100%', minHeight: 20 }}>
		<span ref={dotsRef} className="row-arrival-dots" aria-hidden="true" style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: at !== undefined || loading ? 1 : 0 }}>{(loading || at !== undefined) && <RowLoading row={slot % 3} column={column} resolved={at !== undefined} />}</span>
		<span ref={ref} className="row-arrival-text" style={{ display: 'flex', minWidth: 0, maxWidth: '100%', opacity: 0 }}>{children}</span>
	</span>;
}

/** Fixed-size, seeded dots keep the frontier organic without frame-by-frame React work. */
export const RowLoading = memo(function RowLoading({ row, column, resolved = false }: { row: number; column: number; resolved?: boolean }) {
	return <span className="row-loading" aria-hidden="true">{Array.from({ length: 57 }, (_, index) => {
		const x = index % 19, y = Math.floor(index / 19);
		const seed = Math.sin((x + 1) * 127.1 + (y + 1) * 311.7 + row * 74.7 + column * 53.3) * 43758.5453;
		const noise = seed - Math.floor(seed);
		const style = {
			'--dot-delay': `${Math.max(.65, .95 + (x + y) * .26 + (noise - .5) * 1.35 + row * .12 + column * .14)}s`,
			'--dot-peak': .62 + noise * .3,
			'--dot-echo': .3 + noise * .32,
			...(resolved ? { animation: 'none', opacity: 1 } : {}),
		} as CSSProperties;
		return <span className="row-loading-reveal" key={index} style={style}><i /></span>;
	})}</span>;
});
