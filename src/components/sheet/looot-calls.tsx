'use client';

import clsx from 'clsx';
import { formatUsd } from '@/lib/endpoint-map';
import type { LoootCallMeta } from '@/lib/types';

const OUTCOME_TONE: Record<string, string> = { hit: 'text-success', weak: 'text-warning', miss: 'text-fg-subtle', error: 'text-danger', rejected: 'text-danger', skipped: 'text-fg-subtle', pending: 'text-fg-subtle' };
const MAX_CALLS = 10;

function Outcome({ outcome }: { outcome: string }) {
	return <span data-outcome={outcome} className={clsx('text-caption font-medium', OUTCOME_TONE[outcome] ?? 'text-fg-subtle')}>{outcome}</span>;
}

/** Which provider answered, what the run cost, how it ended, and every provider a fallback route tried. */
export function LoootCalls({ calls }: { calls?: LoootCallMeta[] }) {
	if (!calls?.length) return null;
	const shown = calls.slice(0, MAX_CALLS);
	return (
		<section aria-label="looot runs" data-looot-calls className="flex flex-col gap-2">
			<h4 className="text-caption text-fg-subtle">{calls.length === 1 ? 'Answered by' : `looot runs (${calls.length})`}</h4>
			<ul className="flex flex-col gap-2">
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
			{calls.length > shown.length && <p className="text-caption text-fg-subtle">{calls.length - shown.length} more runs not shown.</p>}
		</section>
	);
}
