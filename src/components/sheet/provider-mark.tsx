import clsx from 'clsx';

/** Provider logos shipped in public/providers. Any other provider gets a letter tile; nothing is fetched from elsewhere. */
const PROVIDER_LOGOS: Record<string, string> = {
	apollo: '/providers/apollo.svg',
	contactout: '/providers/contactout.png',
	hunter: '/providers/hunter.png',
	looot: '/providers/looot.svg',
	moltsets: '/providers/moltsets.svg',
	openai: '/providers/openai.svg',
	prospeo: '/providers/prospeo.png',
	quickenrich: '/providers/quickenrich.png',
	typesafe: '/providers/typesafe.png',
};

/** The logo path for a provider name or id ("Prospeo", "prospeo-people-email-find"), or null when none ships. */
export function providerLogo(provider: string): string | null {
	const key = provider.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')[0] ?? '';
	return PROVIDER_LOGOS[key] ?? null;
}

const SIZES = { xs: 'size-3.5 text-[8.5px]', sm: 'size-5 text-[10px]', md: 'size-7 text-caption' } as const;
/** Intrinsic size of the logo inside each tile (78% of it), so the browser reserves the space before it loads. */
const LOGO_PX = { xs: 11, sm: 16, md: 22 } as const;

/** A provider's logo on a white tile, or its first two letters when no logo ships with the app. */
export function ProviderMark({ name, size = 'md', className }: { name: string; size?: keyof typeof SIZES; className?: string }) {
	const logo = providerLogo(name);
	if (logo) return <span aria-hidden data-provider-logo={name} className={clsx('grid shrink-0 place-items-center overflow-hidden rounded-md border border-line-subtle bg-white', SIZES[size], className)}>
		{/* eslint-disable-next-line @next/next/no-img-element -- a local 14 to 28 px logo; next/image adds nothing here */}
		<img src={logo} alt="" width={LOGO_PX[size]} height={LOGO_PX[size]} className="size-[78%] object-contain" />
	</span>;
	return <span aria-hidden className={clsx('grid shrink-0 place-items-center rounded-md bg-blue-20 font-semibold uppercase text-brand', SIZES[size], className)}>{name.slice(0, 2)}</span>;
}
