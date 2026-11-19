'use client';

import { db, loadSheet, sheetSync, upgradeSheet } from '@/lib/db';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';

/**
 * A teammate's sheet can be cached from the live index without rows, or with older rows than the server.
 * Load it before the sheet renders, so it never shows an empty grid or edits a stale revision. An older sheet is
 * upgraded first, so its header never flips from a legacy name.
 */
export function SheetLoadGate({ sheetId, children }: { sheetId: string; children: ReactNode }) {
	const [check, setCheck] = useState<{ sheetId: string; attempt: number; status: 'checking' | 'ready' } | { sheetId: string; attempt: number; status: 'failed'; error: string }>({ sheetId, attempt: 0, status: 'checking' });
	const attempt = check.sheetId === sheetId ? check.attempt : 0;
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const sheet = await db.sheets.get(sheetId);
			const sync = sheet && sheetSync(sheet);
			if (sync === 'index-only' || sync === 'stale') await loadSheet(sheetId);
			// A failed upgrade keeps the legacy name; the next load tries again.
			await upgradeSheet(sheetId).catch(() => {});
		})().then(
			() => { if (!cancelled) setCheck({ sheetId, attempt, status: 'ready' }); },
			(error) => { if (!cancelled) setCheck({ sheetId, attempt, status: 'failed', error: error instanceof Error ? error.message : '' }); },
		);
		return () => { cancelled = true; };
	}, [sheetId, attempt]);

	if (check.sheetId === sheetId && check.status === 'ready') return children;
	if (check.sheetId === sheetId && check.status === 'failed') return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
			<p role="alert" className="text-body text-fg">Couldn&apos;t load this sheet. {check.error}</p>
			<Button onClick={() => setCheck({ sheetId, attempt: attempt + 1, status: 'checking' })}>Retry</Button>
			<Link href="/app" className="text-body-sm text-brand hover:underline">Back to sheets</Link>
		</div>
	);
	return <div className="flex h-full flex-col gap-3 p-4"><div className="skeleton h-10 w-1/3" /><div className="skeleton flex-1" /></div>;
}
