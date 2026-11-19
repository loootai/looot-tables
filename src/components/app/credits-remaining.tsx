'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { CONTEXT_REQUEST_EVENT } from '@/lib/context-credits';
import { OPENAI_KEY_REQUIRED } from '@/lib/ai-trial';
import { useSettings } from './settings-context';
import { isReady, type Connection } from './providers';
import { usageResource, useUsage } from './use-usage';

const TOP_UP_URL = 'https://context.dev/dashboard/subscription';
interface Balance { credits: number; used?: number }
interface Trial { grantedUsd: number; remainingUsd: number; deploymentAvailable: boolean }

const parseBalance = (value: unknown): Balance | null => {
	const balance = value as Partial<Balance> | null;
	return balance && Number.isFinite(balance.credits) && balance.credits! >= 0 ? balance as Balance : null;
};
const parseTrial = (value: unknown): Trial | null => {
	const trial = value as (Partial<Trial> & { enabled?: boolean }) | null;
	if (!trial?.enabled || !Number.isFinite(trial.remainingUsd)) return null;
	return { grantedUsd: trial.grantedUsd && trial.grantedUsd > 0 ? trial.grantedUsd : 1, remainingUsd: Math.max(0, trial.remainingUsd!), deploymentAvailable: trial.deploymentAvailable !== false };
};
const usd = (value: number) => `$${value.toFixed(2)}`;
const contextUsage = usageResource('/api/context/usage', parseBalance, { events: [CONTEXT_REQUEST_EVENT] });

/** The share of the plan left, when the API reports usage; low at 10% or no credits. */
function balanceMeter(balance: Balance | undefined) {
	const total = balance && typeof balance.used === 'number' && balance.used >= 0 ? balance.credits + balance.used : undefined;
	const percent = balance && total !== undefined ? (total > 0 ? Math.round(balance.credits / total * 100) : 0) : undefined;
	return { percent, low: balance?.credits === 0 || (percent !== undefined && percent <= 10) };
}

function creditsLabel({ ready, connection, balance, error }: { ready: boolean; connection: Connection; balance?: Balance; error: boolean }) {
	if (!ready) return 'Checking credits…';
	if (!isReady(connection)) return connection.state === 'expired' ? 'Connection expired' : 'Not connected';
	if (balance) return `${balance.credits.toLocaleString()} credits left`;
	return error ? 'Credits unavailable' : 'Loading credits…';
}

function Meter({ label, percent, low }: { label: string; percent?: number; low?: boolean }) {
	return (
		<div role={percent !== undefined ? 'progressbar' : undefined} aria-label={label} aria-valuemin={percent !== undefined ? 0 : undefined} aria-valuemax={percent !== undefined ? 100 : undefined} aria-valuenow={percent} className="mt-2 h-1 overflow-hidden rounded-full bg-tint/[0.07]">
			<div className={clsx('h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none', low ? 'bg-warning' : 'bg-brand')} style={{ width: `${percent ?? 0}%` }} />
		</div>
	);
}

/** Static Context.dev balance with one explicit Manage link; hosted trials sit behind a disclosure. */
export function CreditsRemaining() {
	const { settings, server, ready, selfHosted, connections } = useSettings();
	const hasTrials = !selfHosted && Boolean(server?.openaiTrial || server?.typesafeTrial || server?.enrichmentTrial);
	const connected = isReady(connections.context);
	const { data: balance, error } = useUsage(contextUsage, { enabled: ready && connected, identity: JSON.stringify([settings.contextKey, settings.accessPassword, connections.context.state]) });
	const { percent, low } = balanceMeter(balance);
	return (
		<div className="flex flex-col">
			<div className="px-3 py-2">
				<div className="flex items-center justify-between gap-2 text-caption">
					<span className="text-fg-subtle">Context.dev</span>
					<Link href="/app/settings" className="text-fg-muted transition-colors hover:text-fg">Manage</Link>
				</div>
				<p className={clsx('mt-1 text-caption font-medium tabular', low || (ready && !connected) ? 'text-warning' : 'text-fg-muted')} title={error ? 'Could not refresh credits. Check your Context.dev connection.' : undefined}>
					{creditsLabel({ ready, connection: connections.context, balance, error })}{balance && error ? ' · stale' : ''}
					{low && <> · <a href={TOP_UP_URL} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Top up</a></>}
				</p>
				<Meter label="Context.dev credits remaining" percent={percent} low={low} />
			</div>
			{hasTrials && <IncludedTrials />}
		</div>
	);
}

function IncludedTrials() {
	const [expanded, setExpanded] = useState(false);
	const trialsId = useId();
	return <>
		<button type="button" aria-expanded={expanded} aria-controls={trialsId} onClick={() => setExpanded((value) => !value)} className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 text-left text-caption text-fg-subtle transition-colors hover:bg-tint/[0.04] hover:text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
			Included trials<ChevronDown aria-hidden="true" className={clsx('size-3.5 transition-transform motion-reduce:transition-none', expanded && 'rotate-180')} />
		</button>
		<div id={trialsId} hidden={!expanded} className="mx-1 mt-1 rounded-lg border border-hairline bg-surface py-1">
			<TrialCredit kind="ai" />
			<TrialCredit kind="typesafe" />
			<TrialCredit kind="email" />
			<p className="px-3 pt-1 pb-1.5 text-caption text-fg-subtle">Shared by your workspace</p>
		</div>
	</>;
}

const TRIALS = {
	ai: { usage: usageResource('/api/openai/usage', parseTrial, { intervalMs: 15_000, minGapMs: 1_000, events: [CONTEXT_REQUEST_EVENT] }), label: 'AI trial', exhausted: 'Limit reached · add an OpenAI key', ownKey: 'Using your own OpenAI key' },
	typesafe: { usage: usageResource('/api/typesafe/usage', parseTrial, { intervalMs: 15_000, minGapMs: 1_000 }), label: 'TypeSafe trial', exhausted: 'Used up · add a TypeSafe key', ownKey: 'Using your own TypeSafe key' },
	email: { usage: usageResource('/api/enrichment/usage', parseTrial, { intervalMs: 15_000, minGapMs: 1_000 }), label: 'Email credit', exhausted: 'Used up · add provider keys', ownKey: undefined },
};

function TrialCredit({ kind }: { kind: keyof typeof TRIALS }) {
	const { server, settings, reportTrialLimit, selfHosted } = useSettings();
	const trial = TRIALS[kind];
	const enabled = !selfHosted && Boolean({ ai: server?.openaiTrial, typesafe: server?.typesafeTrial, email: server?.enrichmentTrial }[kind]);
	const ownKey = { ai: settings.openaiKey, typesafe: settings.typesafeKey, email: '' }[kind];
	const { data, error } = useUsage(trial.usage, { enabled });
	const exhausted = Boolean(data && (data.remainingUsd <= 0 || !data.deploymentAvailable));
	useEffect(() => {
		if (kind !== 'ai' || !data || !exhausted) return;
		reportTrialLimit(`${data.remainingUsd <= 0 ? `Your workspace’s ${usd(data.grantedUsd)} AI trial limit has been reached.` : 'The shared AI trial spending limit has been reached.'} ${OPENAI_KEY_REQUIRED}`);
	}, [kind, data, exhausted, reportTrialLimit]);
	if (!enabled) return null;
	const percent = data ? Math.max(0, Math.min(100, Math.round(data.remainingUsd / data.grantedUsd * 100))) : undefined;
	return (
		<div className="px-3 py-1.5">
			<span className="block text-caption text-fg-subtle">{trial.label}</span>
			<span className="mt-0.5 block text-caption font-medium tabular text-fg-muted">{data ? `${usd(data.remainingUsd)} of ${usd(data.grantedUsd)} left` : error ? 'Balance unavailable' : 'Checking balance…'}</span>
			{data && <Meter label={`${trial.label} remaining`} percent={percent} low={exhausted} />}
			{ownKey && trial.ownKey ? <span className="mt-1 block text-caption text-fg-subtle">{trial.ownKey}</span> : exhausted ? <span className="mt-1 block text-caption text-warning">{trial.exhausted}</span> : null}
		</div>
	);
}
