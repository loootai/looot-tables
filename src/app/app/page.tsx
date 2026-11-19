import type { Metadata } from 'next';
import { SheetsPage } from '@/components/app/sheets-page';

export const metadata: Metadata = { title: 'Sheets' };
export const instant = false;

export default function Page() {
	return <SheetsPage />;
}
