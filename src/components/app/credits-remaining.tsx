'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { LOOOT_REQUEST_EVENT } from '@/lib/looot-requests';
import { LOOOT_USAGE_URL } from '@/lib/constants';
import { useSettings } from './settings-context';
import { isReady, type Connection } from './providers';
import { usageResource, useUsage } from './use-usage';

interface Balance { available: number; reserved: number; topUpUrl?: string }

const parseBalance = (value: unknown): Balance | null => {
	const balance = value as Partial<Balance> | null;
	return balance && Number.isFinite(balance.available) && balance.available! >= 0 ? { available: balance.available!, reserved: Number.isFinite(balance.reserved) ? balance.reserved! : 0, topUpUrl: balance.topUpUrl } : null;
};
const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;
const looootBalance = usageResource('/api/looot/balance', parseBalance, { intervalMs: 60_000, minGapMs: 2_000, events: [LOOOT_REQUEST_EVENT] });

function balanceLabel({ ready, connection, balance, error }: { ready: boolean; connection: Connection; balance?: Balance; error: boolean }) {
	if (!ready) return 'Checking balance…';
	if (!isReady(connection)) return connection.state === 'expired' ? 'Connection expired' : 'Not connected';
	if (balance) return `${usd(balance.available)} left`;
	return error ? 'Balance unavailable' : 'Loading balance…';
}

/** The caller's own looot balance, with one explicit top-up link. Every run is billed to it, never to a shared token. */
export function CreditsRemaining() {
	const { settings, ready, connections } = useSettings();
	const connected = isReady(connections.looot);
	const { data: balance, error } = useUsage(looootBalance, { enabled: ready && connected, identity: JSON.stringify([settings.loootKey, settings.accessPassword, connections.looot.state]) });
	const low = balance !== undefined && balance.available < 0.25;
	return (
		<div className="flex flex-col">
			<div className="px-3 py-2">
				<div className="flex items-center justify-between gap-2 text-caption">
					<span className="text-fg-subtle">looot balance</span>
					<Link href="/app/settings" className="text-fg-muted transition-colors hover:text-fg">Manage</Link>
				</div>
				<p className={clsx('mt-1 text-caption font-medium tabular', low || (ready && !connected) ? 'text-warning' : 'text-fg-muted')} title={error ? 'Could not refresh the balance. Check your looot token.' : undefined}>
					{balanceLabel({ ready, connection: connections.looot, balance, error })}{balance && error ? ' · stale' : ''}
					{(low || (balance && balance.available === 0)) && <> · <a href={balance?.topUpUrl ?? LOOOT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Top up</a></>}
				</p>
			</div>
		</div>
	);
}
