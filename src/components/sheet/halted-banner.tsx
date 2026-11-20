'use client';

import { announce } from '@/components/ui/announcer';
import { Button, IconButton } from '@/components/ui/button';
import { buttonClassName } from '@/components/ui/button-class';
import { LOOOT_USAGE_URL } from '@/lib/constants';
import type { RunHalt } from '@/lib/runner';
import type { FailureProvider } from '@/lib/types';
import { CirclePause, ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';

const PROVIDER_NAMES: Record<FailureProvider, string> = { looot: 'looot', openai: 'OpenAI', typesafe: 'TypeSafe' };

/** What a fix needs to know: a halted run, a failed Find rows, or a failed key check. */
export type ConnectionIssue = { reason: string; provider?: FailureProvider };

const isCredential = (issue: ConnectionIssue) => issue.reason === 'credential_missing' || issue.reason === 'credential_invalid';

function headline(halt: RunHalt) {
	const name = halt.provider ? PROVIDER_NAMES[halt.provider] : 'A provider';
	switch (halt.reason) {
		case 'credits_exhausted': return halt.provider === 'looot' ? 'Your looot balance is too low' : `${halt.provider ? name : 'Your provider'} credits are used up`;
		case 'credential_missing': return `Add ${halt.provider ? `a ${name}` : 'an'} ${halt.provider === 'looot' ? 'token' : 'API key'} to keep enriching`;
		case 'credential_invalid': return `${name} rejected the ${halt.provider === 'looot' ? 'token' : 'API key'}`;		case 'save_failed': return 'Results couldn’t be saved';
		case 'spend_capped': return 'This sheet reached its spend cap';
		case 'column_halted': return 'A column stopped after 20 misses in a row';
	}
}

/** Open Connections: the fix for a missing or rejected credential. */
export function ConnectionFix({ halt, size = 'sm' }: { halt: ConnectionIssue; size?: 'xs' | 'sm'; onLeave?: () => void }) {
	void halt;
	return <Link href="/app/settings" className={buttonClassName('outline', size)}>Open Connections</Link>;
}

/** The one fix for a failure no retry solves: a balance to top up, or a key to add or replace. */
export function FailureFix({ issue, size = 'xs', onLeave }: { issue: ConnectionIssue; size?: 'xs' | 'sm'; onLeave?: () => void }) {
	if (issue.reason === 'credits_exhausted' && issue.provider === 'looot') return <a href={LOOOT_USAGE_URL} target="_blank" rel="noopener noreferrer" className={buttonClassName('outline', size)}>Top up looot<ExternalLink aria-hidden strokeWidth={1.75} /></a>;
	if (isCredential(issue) || issue.reason === 'credits_exhausted') return <ConnectionFix halt={issue} size={size} onLeave={onLeave} />;
	return null;
}

/** Shown when the runner paused this sheet because every further request would fail the same way. */
export function HaltedBanner({ halt, waiting, onRetry, onDismiss, onLeave }: { halt: RunHalt; waiting: number; onRetry: () => void; onDismiss: () => void; onLeave: () => void }) {
	const title = headline(halt);
	const detail = [
		'Enrichment paused',
		halt.failedCells > 0 && `${halt.failedCells.toLocaleString()} failed`,
		waiting > 0 && `${waiting.toLocaleString()} waiting`,
	].filter(Boolean).join(' · ');
	const announcement = `${title}. Enrichment paused.`;
	useEffect(() => announce(announcement), [announcement]);
	return (
		<div role="region" aria-label="Enrichment paused" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning-line bg-warning-soft py-2 pr-1.5 pl-3 text-body-sm text-warning-strong">
			<CirclePause aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
			<p className="min-w-0 flex-1 max-md:basis-[calc(100%-1.75rem)]" title={halt.message}>
				<span className="font-medium text-fg">{title}.</span>{' '}
				<span>{halt.reason === 'save_failed' || halt.reason === 'column_halted' || halt.reason === 'spend_capped' ? halt.message : detail}</span>
			</p>
			<div className="ml-auto flex shrink-0 items-center gap-1.5 max-md:ml-7 max-md:w-[calc(100%-1.75rem)]">
				<FailureFix issue={halt} onLeave={onLeave} />
				<Button size="xs" variant="brand" onClick={onRetry}>{halt.reason === 'credits_exhausted' ? 'Retry failed' : halt.reason === 'column_halted' ? 'Resume column' : 'Resume'}</Button>
				<IconButton size="sm" label={waiting > 0 ? 'Dismiss and stop waiting cells' : 'Dismiss'} onClick={onDismiss} className="text-warning-strong hover:text-fg max-md:ml-auto"><X /></IconButton>
			</div>
		</div>
	);
}
