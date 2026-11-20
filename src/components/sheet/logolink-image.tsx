'use client';

import { type ReactNode, useState } from 'react';
import './logolink-image.css';

export function LogoLinkImage({ src, size, className, fallback, loading = false, tile = false }: { src: string | null; size: number; className: string; fallback: ReactNode; loading?: boolean; tile?: boolean }) {
	const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const hasImage = Boolean(src && src !== failedUrl);
	const pending = hasImage ? loadedUrl !== src : loading;

	return (
		<span aria-hidden className={`logolink-image relative grid shrink-0 place-items-center overflow-hidden ${className}`} style={{ width: size, height: size }} data-loading={pending || undefined} data-tile={tile && hasImage ? '' : undefined}>
			{!hasImage && !pending ? fallback : null}
			{hasImage && src ? (
				// eslint-disable-next-line @next/next/no-img-element -- Logo Link requires direct CDN embedding.
				<img key={src} src={src} alt="" width={size} height={size} loading="lazy" className="absolute inset-0 size-full object-contain" style={{ opacity: loadedUrl === src ? 1 : 0 }} onLoad={() => setLoadedUrl(src)} onError={() => setFailedUrl(src)} />
			) : null}
		</span>
	);
}
