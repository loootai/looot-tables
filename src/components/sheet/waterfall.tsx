'use client';

import { useEffect, useState } from 'react';
import { routedJob } from '@/lib/job-of';
import type { Column } from '@/lib/types';
import { useJobStats } from './use-job-stats';
import { ProviderMark, providerLogo } from './provider-mark';

const STEP_MS = 600;
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A running job cell: the providers its route tries, in order, one at a time (about 600ms each). This is the planned
    fallback order from the catalog, not a live feed; the receipt shows who really answered once the cell settles. */
export function Waterfall({ column, seed }: { column: Column; seed: string }) {
	const routing = routedJob(column.op);
	const stats = useJobStats(routing?.job, routing?.prefer ?? 'balanced');
	const providers = (stats?.providers ?? []).filter((entry) => !routing?.exclude.includes(entry.endpointId)).slice(0, 4).map((entry) => entry.provider);
	const offset = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3;
	const [step, setStep] = useState(0);
	useEffect(() => {
		if (providers.length < 2 || reducedMotion()) return;
		const timer = setInterval(() => setStep((current) => current + 1), STEP_MS);
		return () => clearInterval(timer);
	}, [providers.length]);
	if (!providers.length) return <span className="waterfall text-body-sm"><span className="waterfall-dots"><i data-now /><i /><i /></span>{routing ? 'Asking looot…' : 'Running…'}</span>;
	const index = (step + offset) % providers.length;
	const name = providers[index];
	return (
		<span className="waterfall" aria-label={`Trying ${name}, ${index + 1} of ${providers.length}`}>
			{providerLogo(name) ? <ProviderMark key={`${name}-${step}`} name={name} size="xs" className="waterfall-tile !bg-white" /> : <span key={`${name}-${step}`} className="waterfall-tile">{name.slice(0, 1)}</span>}
			<span className="truncate text-body-sm">{name}</span>
			<span className="waterfall-dots" aria-hidden>{providers.map((provider, at) => <i key={provider} data-done={at < index ? '' : undefined} data-now={at === index ? '' : undefined} />)}</span>
			<span className="num text-[10.5px]">{index + 1}/{providers.length}</span>
		</span>
	);
}
