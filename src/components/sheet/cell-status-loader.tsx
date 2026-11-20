import { memo, type CSSProperties } from 'react';
import './cell-status-loader.css';

/** The same shimmer in both states: subdued grey while queued, brighter blue while active. Paused holds still. */
export const CellStatusLoader = memo(function CellStatusLoader({ status, seed }: { status: 'queued' | 'running' | 'paused'; seed: string }) {
	let hash = 2166136261;
	for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
	// Use only the three exact dot patterns approved in the preview.
	const phase = (hash >>> 0) % 3;
	const cycle = status === 'running' ? 3.6 : 5.4;
	return <span aria-hidden="true" className="cell-status-loader" data-cell-status={status} data-phase={phase} style={{ width: 18, height: 18, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gridTemplateRows: 'repeat(4, 1fr)', gap: 2.25, flexShrink: 0 }}>
		{Array.from({ length: 16 }, (_, index) => {
			const x = index % 4, y = Math.floor(index / 4);
			const value = Math.sin((x + 1) * 127.1 + (y + 1) * 311.7 + phase * 74.7) * 43758.5453;
			const noise = value - Math.floor(value);
			const style = {
				width: '100%', height: '100%', borderRadius: '50%',
				background: status === 'running' ? 'var(--color-brand)' : 'var(--color-fg-subtle)',
				opacity: status === 'running' ? .13 : .18 + noise * .42,
				// Longhands preserve the stagger across state changes.
				animationName: status === 'paused' ? 'none' : 'cell-status-shimmer',
				animationDuration: `${cycle}s`,
				animationTimingFunction: 'ease-in-out',
				animationIterationCount: 'infinite',
				animationDelay: `${(-1 + (x + y) * .055 + (noise - .5) * .095 - phase * .19) * cycle}s`,
				'--status-peak': status === 'running' ? .7 + noise * .3 : .4 + noise * .2,
				'--status-echo': status === 'running' ? .35 + noise * .3 : .2 + noise * .2,
				'--status-rest': status === 'running' ? .5 : .18 + noise * .42,
			} as CSSProperties;
			return <i key={index} style={style} />;
		})}
	</span>;
});
