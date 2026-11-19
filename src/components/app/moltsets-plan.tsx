'use client';

import clsx from 'clsx';
import { LOOOT_REQUEST_EVENT } from '@/lib/looot-requests';
import { useSettings } from './settings-context';
import { isReady } from './providers';
import { usageResource, useUsage } from './use-usage';

interface Plan { recordsLeft5h?: number; recordsLimit5h?: number; resetsAt5h?: string | null; phoneTokens?: number }

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const parsePlan = (value: unknown): Plan | null => {
	const plan = value as Record<string, unknown> | null;
	if (!plan || typeof plan !== 'object') return null;
	return { recordsLeft5h: count(plan.recordsLeft5h), recordsLimit5h: count(plan.recordsLimit5h), resetsAt5h: typeof plan.resetsAt5h === 'string' ? plan.resetsAt5h : null, phoneTokens: count(plan.phoneTokens) };
};
const moltsetsPlan = usageResource('/api/moltsets/plan', parsePlan, { intervalMs: 60_000, minGapMs: 2_000, events: [LOOOT_REQUEST_EVENT] });

/** Records left in the current 5 hour window of the caller's MoltSets plan, shown next to the looot balance. MoltSets limits
    records per rolling window, so the number comes back when the window reopens. Hidden without a MoltSets key. */
export function MoltSetsPlanMeter() {
	const { settings, ready, connections } = useSettings();
	const connected = isReady(connections.moltsets);
	const { data: plan, error } = useUsage(moltsetsPlan, { enabled: ready && connected, identity: JSON.stringify([settings.moltsetsKey, settings.accessPassword, connections.moltsets.state]) });
	if (!ready || !connected) return null;
	const left = plan?.recordsLeft5h;
	const low = left !== undefined && plan?.recordsLimit5h ? left / plan.recordsLimit5h < 0.1 : false;
	const resets = plan?.resetsAt5h ? new Date(plan.resetsAt5h) : null;
	return (
		<div data-moltsets-plan className="px-3 py-2">
			<div className="flex items-center justify-between gap-2 text-caption"><span className="text-fg-subtle">MoltSets plan</span></div>
			<p className={clsx('mt-1 text-caption font-medium tabular', low ? 'text-warning' : 'text-fg-muted')} title={error ? 'Could not refresh the MoltSets plan. Check your MoltSets key.' : resets ? `The 5 hour window reopens ${resets.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : undefined}>
				{left !== undefined ? `${left.toLocaleString('en-US')} records left · 5h` : error ? 'Plan unavailable' : 'Loading plan…'}{left !== undefined && error ? ' · stale' : ''}
			</p>
			{plan?.phoneTokens !== undefined && <p className="mt-0.5 text-caption tabular text-fg-subtle">{plan.phoneTokens.toLocaleString('en-US')} phone tokens</p>}
		</div>
	);
}
