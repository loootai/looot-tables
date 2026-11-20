import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { buttonClassName } from '@/components/ui/button-class';
import { currentAccount, devAuthEnabled, safeReturnTo, sessionConfig } from '@/lib/server/auth';
import { Suspense } from 'react';
import { SigninNotice } from '@/components/app/signin-notice';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false, follow: false } };
export const instant = false;

async function Login({ searchParams }: { searchParams: Promise<{ error?: string; returnTo?: string }> }) {
	const params = await searchParams;
	if (await currentAccount()) redirect(safeReturnTo(params.returnTo ?? null));
	const showDevLogin = devAuthEnabled() && (await headers()).get('host') === new URL(sessionConfig().origin).host;
	return <main className="grid min-h-dvh place-items-center bg-canvas px-6">
		<SigninNotice />
		<div className="flex w-full max-w-sm flex-col gap-4">
			<div className="rounded-shell border border-line-subtle bg-surface p-8">
				<Logo size={30} />
				<h1 className="mt-6 text-h4 text-fg">Sign in to looot tables</h1>
				<p className="mt-2 text-body-sm text-fg-muted">This deployment has no accounts. Local development uses a developer session.</p>
				{params.error && <p role="alert" className="mt-4 text-body-sm text-danger">{params.error === 'configuration' ? 'Sign-in needs to be configured by the deployment owner.' : 'Sign-in was cancelled or expired. Please try again.'}</p>}
				{showDevLogin && <form action="/api/auth/dev" method="post" className="mt-6">
					<input type="hidden" name="returnTo" value={safeReturnTo(params.returnTo ?? null)} />
					<button type="submit" className={buttonClassName('outline', 'md', 'w-full')}>Sign in as developer</button>
					<p className="mt-2 text-caption text-fg-subtle">Local development workspace. Add your API keys in Configuration.</p>
				</form>}
			</div>
			<Link href="/" className="self-center text-caption text-fg-subtle transition-colors hover:text-fg">← Back to looot tables</Link>
		</div>
	</main>;
}

export default function LoginPage(props: { searchParams: Promise<{ error?: string; returnTo?: string }> }) {
	return <Suspense fallback={<main className="grid min-h-dvh place-items-center text-body-sm text-fg-muted">Loading sign-in…</main>}><Login {...props} /></Suspense>;
}
