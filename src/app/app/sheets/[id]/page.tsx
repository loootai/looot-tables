import { Suspense } from 'react';
import { SheetPage } from '@/components/sheet/sheet-page';
import { SheetLoadGate } from '@/components/sheet/sheet-load-gate';

export const instant = false;

export default function Page(props: PageProps<'/app/sheets/[id]'>) {
	return (
		<Suspense fallback={<div className="flex h-full flex-col gap-3 p-4"><div className="skeleton h-10 w-1/3" /><div className="skeleton flex-1" /></div>}>
			<Resolved params={props.params} />
		</Suspense>
	);
}

async function Resolved({ params }: { params: PageProps<'/app/sheets/[id]'>['params'] }) {
	const { id } = await params;
	return <SheetLoadGate sheetId={id}><SheetPage sheetId={id} /></SheetLoadGate>;
}
