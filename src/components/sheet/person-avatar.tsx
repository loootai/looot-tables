'use client';

import { useState } from 'react';
import { profileUrl } from '@/lib/profile-photo';

export function PersonAvatar({ src }: { src?: string | null }) {
	const url = profileUrl(src);
	const [loaded, setLoaded] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	return <span aria-hidden="true" className="relative inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full" data-person-avatar>
		{(!url || failed === url || loaded !== url) && <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-4" data-person-placeholder>
			<circle cx="10" cy="6" r="3" />
			<path d="M4 17v-1a6 4 0 0 1 12 0v1H4Z" />
		</svg>}
		{url && failed !== url && (
			// eslint-disable-next-line @next/next/no-img-element -- Enrichment photos use provider-hosted URLs.
			<img key={url} src={url} alt="" width={16} height={16} loading="lazy" referrerPolicy="no-referrer" className="absolute inset-0 size-full rounded-full object-cover" style={{ opacity: loaded === url ? 1 : 0 }} onLoad={() => setLoaded(url)} onError={() => setFailed(url)} />
		)}
	</span>;
}
