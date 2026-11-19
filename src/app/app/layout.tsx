import type { Metadata } from 'next';
import { AppShell } from '@/components/app/app-shell';
import { ShellSkeleton } from '@/components/app/shell-skeleton';
import { currentAccount, DEV_ISSUER } from '@/lib/server/auth';
import { contextSignInEnabled } from '@/lib/server/deployment';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

export const metadata: Metadata = { title: 'Sheets', robots: { index: false, follow: false } };
export const instant = false;

async function AuthenticatedApp({ children }: { children: React.ReactNode }) {
	const account = await currentAccount();
	if (!account) redirect('/login');
	return <AppShell account={account} contextSignIn={contextSignInEnabled() && account.issuer !== DEV_ISSUER}>{children}</AppShell>;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
	return <Suspense fallback={<ShellSkeleton />}><AuthenticatedApp>{children}</AuthenticatedApp></Suspense>;
}
