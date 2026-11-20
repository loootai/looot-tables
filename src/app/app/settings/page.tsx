import type { Metadata } from 'next';
import { SettingsPage } from '@/components/app/settings-page';

export const metadata: Metadata = { title: 'Configuration' };
export const instant = false;

export default function Page() {
	return <SettingsPage />;
}
