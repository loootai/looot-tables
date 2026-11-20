import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Analytics } from '@/components/analytics';
import { SITE_DESCRIPTION, SITE_TITLE } from '@/lib/constants';
import { indexingEnabled, siteUrl } from '@/lib/server/deployment';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
	title: { default: SITE_TITLE, template: '%s · looot tables' },
	description: SITE_DESCRIPTION,
	applicationName: 'looot tables',
	metadataBase: siteUrl(),
	openGraph: { type: 'website', siteName: 'looot tables', locale: 'en_US' },
	twitter: { card: 'summary_large_image' },
	robots: indexingEnabled() ? { googleBot: { 'max-image-preview': 'large' } } : { index: false, follow: false },
	icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }], apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = { themeColor: [{ media: '(prefers-color-scheme: light)', color: '#fdfcf8' }, { media: '(prefers-color-scheme: dark)', color: '#0c1a15' }], width: 'device-width', initialScale: 1, viewportFit: 'cover', interactiveWidget: 'resizes-content' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={inter.variable} suppressHydrationWarning>
			<body>
				{children}
				<Analytics />
			</body>
		</html>
	);
}
