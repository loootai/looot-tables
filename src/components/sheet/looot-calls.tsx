'use client';

import clsx from 'clsx';
import { formatUsd } from '@/lib/endpoint-map';
import type { LoootCallMeta, MoltSetsCallMeta } from '@/lib/types';
import { riskTitle, riskTone } from '@/lib/moltsets-risk';

const OUTCOME_TONE: Record<string, string> = { hit: 'text-success', weak: 'text-warning', miss: 'text-fg-subtle', error: 'text-danger', rejected: 'text-danger', skipped: 'text-fg-subtle', pending: 'text-fg-subtle', exhausted: 'text-warning' };
const MAX_CALLS = 10;

function Outcome({ outcome }: { outcome: string }) {
	return <span data-outcome={outcome} className={clsx('text-caption font-medium', OUTCOME_TONE[outcome] ?? 'text-fg-subtle')}>{outcome}</span>;
}

/** The MoltSets lookup that ran first: a flat-fee call on the user's own plan, so it never costs dollars. */
function MoltSetsAttempt({ attempt }: { attempt: MoltSetsCallMeta }) {
	return (
		<li data-moltsets-attempt className="flex flex-col gap-1 rounded-lg border border-line-subtle px-3 py-2">
			<div className="flex items-center justify-between gap-3 text-body-sm">
				<span data-looot-provider className="min-w-0 truncate text-fg">MoltSets · plan · $0</span>
				<Outcome outcome={attempt.outcome} />
			</div>
			<div className="flex items-center justify-between gap-3 text-caption text-fg-subtle tabular">
				<span className="min-w-0 truncate" title={attempt.tool}>{attempt.tool}</span>
				<span data-looot-cost>$0</span>
			</div>
			{attempt.riskScore && <span data-risk-score={attempt.riskScore} data-risk-tone={riskTone(attempt.riskScore)} className="text-caption text-fg-muted">{riskTitle(attempt.riskScore, attempt.lastValidatedAt)}</span>}
			{attempt.reason && <span className="text-caption text-fg-subtle">{attempt.reason}{attempt.outcome === 'exhausted' && attempt.retryAfterSeconds ? ` Reopens in about ${Math.max(1, Math.round(attempt.retryAfterSeconds / 60))} min.` : ''}</span>}
			{attempt.recordsLeft5h !== undefined && <span className="text-caption text-fg-subtle tabular">{attempt.recordsLeft5h.toLocaleString('en-US')} records left in this 5 hour window</span>}
		</li>
	);
}

/** Which provider answered, what the run cost, how it ended, and every provider a fallback route tried. A MoltSets
    lookup comes first when the column asked it. */
export function LoootCalls({ calls, moltsets }: { calls?: LoootCallMeta[]; moltsets?: MoltSetsCallMeta }) {
	if (!calls?.length && !moltsets) return null;
	const all = calls ?? [];
	const shown = all.slice(0, MAX_CALLS);
	const total = all.length + (moltsets ? 1 : 0);
	return (
		<section aria-label="looot runs" data-looot-calls className="flex flex-col gap-2">
			<h4 className="text-caption text-fg-subtle">{total === 1 ? 'Answered by' : moltsets ? `Attempts (${total})` : `looot runs (${total})`}</h4>
			<ul className="flex flex-col gap-2">
				{moltsets && <MoltSetsAttempt attempt={moltsets} />}
				{shown.map((call) => (
					<li key={call.runId} className="flex flex-col gap-1 rounded-lg border border-line-subtle px-3 py-2">
						<div className="flex items-center justify-between gap-3 text-body-sm">
							<span data-looot-provider className="min-w-0 truncate text-fg">{call.provider ?? 'No provider answered'}</span>
							<Outcome outcome={call.outcome} />
						</div>
						<div className="flex items-center justify-between gap-3 text-caption text-fg-subtle tabular">
							<span className="min-w-0 truncate" title={call.endpointId}>{call.job ? `job:${call.job}` : call.endpointId}</span>
							<span data-looot-cost>{formatUsd(call.costUsd)}</span>
						</div>
						{call.attempts && (call.attempts.length > 1 || call.attempts.some((attempt) => attempt.outcome !== 'hit')) && (
							<ol aria-label="Providers tried" className="mt-1 flex flex-col gap-0.5 border-t border-line-subtle pt-1.5">
								{call.attempts.map((attempt, index) => (
									<li key={`${attempt.endpointId ?? attempt.provider}-${index}`} className="flex items-baseline justify-between gap-3 text-caption text-fg-muted">
										<span className="min-w-0 truncate" title={attempt.reason}>{index + 1}. {attempt.provider}</span>
										<span className="flex shrink-0 items-baseline gap-2 tabular"><Outcome outcome={attempt.outcome} /><span className="text-fg-subtle">{formatUsd(attempt.costUsd)}</span></span>
									</li>
								))}
							</ol>
						)}
						{call.skipped ? <span className="text-caption text-fg-subtle">{call.skipped} other provider{call.skipped === 1 ? '' : 's'} skipped: they could not take this input.</span> : null}
						<span className="truncate text-caption text-fg-subtle" title={call.runId}>run {call.runId}</span>
					</li>
				))}
			</ul>
			{all.length > shown.length && <p className="text-caption text-fg-subtle">{all.length - shown.length} more runs not shown.</p>}
		</section>
	);
}
