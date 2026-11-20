'use client';

import Image from 'next/image';
import { brandAccent, type DocumentBrand } from '@/lib/document-branding';
import { liveResource, useLiveStore } from '@/lib/live-store';
import { Field, Input } from '@/components/ui/field';
import { loadBrand } from './brand-lookup';
import { useSettings } from './settings-context';

type BrandState = { brand?: DocumentBrand; error?: string };

/** The saved brand for exported documents, loaded once per saved domain while shown. */
const savedBrand = liveResource((domain: string) => domain, null as BrandState | null, (domain, { signal, set }) => {
	loadBrand(domain, signal).then((brand) => set({ brand }), (error: unknown) => set({ error: error instanceof Error ? error.message : 'Could not load branding.' }));
});

/** Document branding inside Defaults: the company website (saved with the other defaults) and a preview of its saved brand. */
export function CompanyBranding({ value, onChange }: { value: string; onChange: (value: string) => void }) {
	const { settings, ready } = useSettings();
	const current = useLiveStore(savedBrand(ready ? settings.companyDomain ?? '' : null));
	const brand = current?.brand;
	return <div className="flex flex-col gap-4" role="group" aria-labelledby="branding-title">
		<div className="flex flex-col gap-0.5">
			<h3 id="branding-title" className="text-body-sm font-medium text-fg">Document branding</h3>
			<p className="text-caption text-fg-subtle">Your logo and accent color on exported PDFs. Client logos appear alongside yours.</p>
		</div>
		<Field label="Company website" help="The default for all documents. Leave blank to use your signed-in company, when available.">{(id) => <Input id={id} value={value} placeholder="company.com" onChange={(event) => onChange(event.target.value)} spellCheck={false} />}</Field>
		{brand && <BrandPreview brand={brand} />}
		{ready && !current && <p role="status" className="text-caption text-fg-muted">Loading company branding…</p>}
		{current && !brand && !current.error && <p className="text-caption text-fg-muted">No company is set. Add your website to include your logo and accent color.</p>}
		{current?.error && <p role="alert" className="text-caption text-danger">{current.error}</p>}
	</div>;
}

function BrandPreview({ brand }: { brand: DocumentBrand }) {
	const accent = brandAccent(brand.accentColor);
	return <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-line-subtle p-3 sm:gap-4" style={{ borderLeft: `4px solid ${accent}` }}>
		{brand.logoUrl && <Image unoptimized src={brand.logoUrl} alt={`${brand.name} logo`} width={132} height={30} className="h-8 w-24 max-w-full shrink-0 object-contain sm:w-32" />}
		<div className="min-w-0 flex-1 break-words text-body-sm text-fg"><div>{brand.name}</div><div className="text-caption text-fg-muted">{brand.domain}</div></div>
		<span className="flex w-full items-center gap-2 text-caption text-fg-muted sm:ml-auto sm:w-auto sm:shrink-0"><span className="size-4 rounded-full border border-line-subtle" style={{ backgroundColor: accent }} />{accent}</span>
	</div>;
}
