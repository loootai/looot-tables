'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { Copy, Flag } from 'lucide-react';
import { formatUsd } from '@/lib/endpoint-map';
import { lookupsTotal } from '@/lib/run-cost';
import { ProviderMark } from './provider-mark';
import { reportBadResult } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import type { LoootCallMeta, MoltSetsCallMeta } from '@/lib/types';
import { riskTitle, riskTone } from '@/lib/moltsets-risk';

const OUTCOME_TONE: Record<string, string> = { hit: 'bg-success-soft text-success', weak: 'bg-warning-soft text-warning-strong', miss: 'bg-neutral-5 text-fg-subtle', error: 'bg-danger-soft text-danger-strong', rejected: 'bg-danger-soft text-danger-strong', skipped: 'bg-neutral-5 text-fg-subtle', pending: 'bg-neutral-5 text-fg-subtle', exhausted: 'bg-warning-soft text-warning-strong' };
const MAX_CALLS = 10;

function Outcome({ outcome }: { outcome: string }) {
	return <span data-outcome={outcome} className={clsx('rounded-full px-1.5 text-[10.5px] font-medium leading-[18px]', OUTCOME_TONE[outcome] ?? 'bg-neutral-5 text-fg-subtle')}>{outcome}</span>;
}

/** A provider's logo, or its monogram when none ships with the app. */
function ProviderTile({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
	return <ProviderMark name={name} size={size} />;
}

const ms = (value?: number) => value === undefined ? '' : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;

/** "Prospeo miss $0 → Hunter hit $0.0042, 610 ms": every provider the route tried, what each cost and took. */
export function routeLine(call: LoootCallMeta): string {
	return (call.attempts ?? []).map((attempt) => `${attempt.provider} ${attempt.outcome} ${formatUsd(attempt.costUsd)}${attempt.ms !== undefined ? `, ${ms(attempt.ms)}` : ''}`).join(' → ');
}

/** "search_business_email_v2" reads as "email lookup"; the raw tool name stays in the title. */
function toolLabel(tool: string | undefined) {
	const name = (tool ?? '').toLowerCase();
	for (const [word, label] of [['email', 'email lookup'], ['mobile', 'mobile lookup'], ['phone', 'mobile lookup'], ['profile', 'profile lookup']] as const) if (name.includes(word)) return label;
	return name.replace(/_/g, ' ') || 'lookup';
}

/** Attempt 1 when the column asked MoltSets first: a flat-fee call on the user's own plan, so it never costs dollars. */
function MoltSetsAttempt({ attempt }: { attempt: MoltSetsCallMeta }) {
	return (
		<li data-moltsets-attempt className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
			<div className="flex items-center gap-2.5">
				<span className="num w-3 text-[10.5px] text-fg-subtle">1</span>
				<ProviderTile name="MoltSets" />
				<div className="min-w-0 flex-1">
					<p data-looot-provider className="truncate text-body-sm font-medium text-fg">MoltSets</p>
					<p className="truncate text-[11px] text-fg-subtle" title={attempt.tool}>Your plan · {toolLabel(attempt.tool)}</p>
				</div>
				<div className="flex flex-col items-end gap-1">
					<Outcome outcome={attempt.outcome} />
					<span data-looot-cost className="num text-[11.5px] text-fg">$0{attempt.ms !== undefined ? ` · ${ms(attempt.ms)}` : ''}</span>
				</div>
			</div>
			{attempt.riskScore && <span data-risk-score={attempt.riskScore} data-risk-tone={riskTone(attempt.riskScore)} className="text-caption text-fg-muted">{riskTitle(attempt.riskScore, attempt.lastValidatedAt)}</span>}
			{attempt.reason && <span className="text-caption text-fg-subtle">{attempt.reason}{attempt.outcome === 'exhausted' && attempt.retryAfterSeconds ? ` Reopens in about ${Math.max(1, Math.round(attempt.retryAfterSeconds / 60))} min.` : ''}</span>}
			{attempt.recordsLeft5h !== undefined && <span className="num text-caption text-fg-subtle">{attempt.recordsLeft5h.toLocaleString('en-US')} records left in this 5 hour window</span>}
		</li>
	);
}

/** The receipt for a cell: who answered, the route looot walked, what each try cost and took, and a way to say it was
    wrong. A MoltSets lookup comes first when the column asked it. */
export function LoootCalls({ calls, moltsets }: { calls?: LoootCallMeta[]; moltsets?: MoltSetsCallMeta }) {
	if (!calls?.length && !moltsets) return null;
	const all = calls ?? [];
	const shown = all.slice(0, MAX_CALLS);
	const total = all.length + (moltsets ? 1 : 0);
	return (
		<section aria-label="looot runs" data-looot-calls className="flex flex-col gap-2">
			<h4 className="flex items-baseline justify-between gap-2 text-caption text-fg-subtle"><span>{total === 1 ? 'Receipt' : `Receipt · ${total} lookups`}</span>{total > 1 && <span data-lookups-total>Total <span className="num text-fg">{formatUsd(lookupsTotal(all))}</span></span>}</h4>
			<ul className="flex flex-col gap-2">
				{moltsets && <MoltSetsAttempt attempt={moltsets} />}
				{shown.map((call) => (
					<li key={call.runId} className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
						<div className="flex items-center gap-2.5">
							<ProviderTile name={call.provider ?? '?'} />
							<div className="min-w-0 flex-1">
								<p data-looot-provider className="truncate text-body-sm font-medium text-fg">{call.provider ?? 'No provider answered'}</p>
								<p className="num truncate text-[11px] text-fg-subtle" title={call.endpointId}>{call.job ? `job:${call.job}` : call.endpointId}</p>
							</div>
							<div className="flex flex-col items-end gap-1">
								<Outcome outcome={call.outcome} />
								<span data-looot-cost className="num text-[11.5px] text-fg">{formatUsd(call.costUsd)}</span>
							</div>
						</div>
						{call.attempts && call.attempts.length > 0 && (
							<ol aria-label="Providers tried" title={routeLine(call)} className="flex flex-col gap-1 border-t border-line-subtle pt-2">
								{call.attempts.map((attempt, index) => (
									<li key={`${attempt.endpointId ?? attempt.provider}-${index}`} className="flex items-center gap-2 text-caption text-fg-muted">
										<span className="num w-3 text-[10.5px] text-fg-subtle">{index + 1}</span>
										<ProviderTile name={attempt.provider} size="sm" />
										<span className="min-w-0 flex-1 truncate" title={attempt.reason}>{attempt.provider}</span>
										<Outcome outcome={attempt.outcome} />
										<span className="num w-14 text-right text-[11px] text-fg">{formatUsd(attempt.costUsd)}</span>
										<span className="num w-12 text-right text-[11px] text-fg-subtle">{ms(attempt.ms)}</span>
									</li>
								))}
							</ol>
						)}
						{call.capped && <p className="text-caption text-warning-strong">The route stopped at this cell’s cap before another provider was tried.</p>}
						{call.skipped ? <p className="text-caption text-fg-subtle">{call.skipped} other provider{call.skipped === 1 ? '' : 's'} skipped: they could not take this input.</p> : null}
						<div className="flex items-center justify-between gap-2">
							<CopyRunId runId={call.runId} />
							<ReportButton call={call} />
						</div>
					</li>
				))}
			</ul>
			{all.length > shown.length && <p className="text-caption text-fg-subtle">{all.length - shown.length} more runs not shown.</p>}
		</section>
	);
}

/** The run id, kept for support but quiet: its last characters and a copy button. */
function CopyRunId({ runId }: { runId: string }) {
	const { toast } = useToast();
	const copy = async () => {
		try { await navigator.clipboard.writeText(runId); toast('Run id copied'); } catch { toast('Could not copy the run id', 'error'); }
	};
	return <button type="button" data-run-id={runId} title={`Copy run id ${runId}`} aria-label={`Copy run id ${runId}`} onClick={() => void copy()} className="inline-flex min-w-0 items-center gap-1 text-caption text-fg-subtle hover:text-fg">
		<Copy aria-hidden className="size-3 shrink-0" strokeWidth={1.75} /><span className="truncate">Run id</span>
	</button>;
}

/** Free: tells looot this run's answer was wrong, with its runId. Sends nothing else from the sheet. */
function ReportButton({ call }: { call: LoootCallMeta }) {
	const { toast } = useToast();
	const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
	const send = async () => {
		setState('sending');
		try {
			await reportBadResult({ runId: call.runId, endpointId: call.endpointId, message: `looot tables user reports a bad ${call.outcome} from ${call.provider ?? 'the route'} on ${call.job ? `job:${call.job}` : call.endpointId}.` });
			setState('sent');
			toast('Reported to looot. Thank you.');
		} catch (error) {
			setState('idle');
			toast(error instanceof Error ? error.message : 'Could not send the report', 'error');
		}
	};
	return <button type="button" data-report-bad-result disabled={state !== 'idle'} onClick={() => void send()} className="inline-flex shrink-0 items-center gap-1 text-caption text-fg-subtle hover:text-danger disabled:opacity-60">
		<Flag aria-hidden className="size-3" strokeWidth={1.75} />{state === 'sent' ? 'Reported' : state === 'sending' ? 'Sending…' : 'Report bad result'}
	</button>;
}
