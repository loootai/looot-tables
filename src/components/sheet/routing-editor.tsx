'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { FloatingMenu } from '@/components/ui/menu';
import { Button } from '@/components/ui/button';
import { formatUsd } from '@/lib/endpoint-map';
import { PREFER_LABEL, routedJob, withRouting, type Prefer } from '@/lib/job-of';
import type { Column, ColumnOp } from '@/lib/types';
import { useJobStats } from './use-job-stats';

const CHOICES: Prefer[] = ['cheapest', 'reliable', 'fastest', 'balanced'];

/** A job column's route: the providers looot will try, in the order this routing tries them, with their measured answer
    rate, p50 and price per call. The pill re-sorts it (fallback.prefer); a switch skips a provider (fallback.exclude).
    looot decides the order inside a choice; the sheet never invents one. */
export function RoutingEditor({ column, anchor, onClose, onSave }: { column: Column; anchor: DOMRect; onClose: () => void; onSave: (op: ColumnOp) => Promise<void> }) {
	const routing = routedJob(column.op)!;
	const [prefer, setPrefer] = useState<Prefer>(routing.prefer);
	const [exclude, setExclude] = useState<string[]>(routing.exclude);
	const [saving, setSaving] = useState(false);
	const stats = useJobStats(routing.job, prefer);
	const providers = stats?.providers ?? [];
	const on = providers.filter((provider) => !exclude.includes(provider.endpointId));
	const toggle = (endpointId: string) => setExclude((current) => current.includes(endpointId) ? current.filter((entry) => entry !== endpointId) : [...current, endpointId]);
	const save = async () => {
		setSaving(true);
		try { const op = withRouting(column, { prefer, exclude }); if (op) await onSave(op); onClose(); }
		finally { setSaving(false); }
	};
	return (
		<FloatingMenu anchor={anchor} role="dialog" label={`Routing for ${column.name}`} width="w-[360px]" align="right" onClose={onClose}>
			<div data-routing-editor className="flex flex-col gap-3 p-3">
				<div className="flex items-baseline justify-between gap-2">
					<p className="text-body-sm font-medium text-fg">Routing</p>
					<p className="num text-[11px] text-fg-subtle">job:{routing.job}</p>
				</div>
				<div role="radiogroup" aria-label="Order providers by" className="grid grid-cols-4 gap-1 rounded-lg bg-neutral-5 p-1">
					{CHOICES.map((choice) => <button key={choice} type="button" role="radio" aria-checked={prefer === choice} onClick={() => setPrefer(choice)} className={clsx('h-7 rounded-md text-caption font-medium transition-colors', prefer === choice ? 'bg-surface text-fg shadow-sm' : 'text-fg-subtle hover:text-fg')}>{PREFER_LABEL[choice]}</button>)}
				</div>
				<ol aria-label="Providers in the order they are tried" className="flex flex-col">
					<li aria-hidden className="grid grid-cols-[16px_1fr_44px_44px_56px_32px] items-center gap-2 px-1 pb-1 text-[10.5px] text-fg-subtle"><span /><span>Provider</span><span className="text-right">Hits</span><span className="text-right">p50</span><span className="text-right">Per call</span><span /></li>
					{!stats && <li className="px-1 py-3 text-caption text-fg-subtle">Reading measured numbers from looot…</li>}
					{stats && !providers.length && <li className="px-1 py-3 text-caption text-fg-subtle">No provider for this job can run now.</li>}
					{providers.map((provider) => {
						const enabled = !exclude.includes(provider.endpointId);
						const order = on.findIndex((entry) => entry.endpointId === provider.endpointId);
						return <li key={provider.endpointId} data-route-provider={provider.provider} className={clsx('grid grid-cols-[16px_1fr_44px_44px_56px_32px] items-center gap-2 rounded-md px-1 py-1.5', !enabled && 'opacity-45')}>
							<span className="num text-[10.5px] text-fg-subtle">{enabled ? order + 1 : '–'}</span>
							<span className="truncate text-body-sm text-fg" title={provider.endpointId}>{provider.provider}</span>
							<span className="num text-right text-[11px] text-fg">{provider.rate !== null ? `${Math.round(provider.rate * 100)}%` : '—'}</span>
							<span className="num text-right text-[11px] text-fg-muted">{provider.p50Ms !== null ? `${(provider.p50Ms / 1000).toFixed(1)}s` : '—'}</span>
							<span className="num text-right text-[11px] text-fg">{provider.priceUsd !== null ? formatUsd(provider.priceUsd) : '—'}</span>
							<button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? 'Skip' : 'Use'} ${provider.provider}`} onClick={() => toggle(provider.endpointId)} disabled={enabled && on.length === 1} className={clsx('relative h-4 w-7 rounded-full transition-colors disabled:opacity-50', enabled ? 'bg-brand' : 'bg-neutral-20')}>
								<span aria-hidden className={clsx('absolute top-0.5 left-0.5 block size-3 rounded-full bg-surface shadow-sm transition-transform', enabled && 'translate-x-3')} />
							</button>
						</li>;
					})}
				</ol>
				<p className="text-caption text-fg-subtle">looot tries the next provider only on a miss. Hits are measured answer rates from the looot catalog; a route never spends past the cell’s cap.</p>
				<div className="flex justify-end gap-2">
					<Button size="xs" onClick={onClose}>Cancel</Button>
					<Button size="xs" variant="brand" loading={saving} onClick={() => void save()}>Save routing</Button>
				</div>
			</div>
		</FloatingMenu>
	);
}
