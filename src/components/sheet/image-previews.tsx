'use client';

import Image from 'next/image';
import { useState } from 'react';
import { keyedItems } from '@/lib/detail-value';
import { DetailValue } from './detail-value';

function ImagePreview({ url, index }: { url: string; index: number }) {
	const [failed, setFailed] = useState(false);
	return <li className="min-w-0 overflow-hidden rounded-lg border border-line">
		<a href={url} target="_blank" rel="noopener noreferrer" className="flex h-36 items-center justify-center bg-neutral-5 focus-visible:outline-2 focus-visible:outline-brand" aria-label={`Open image ${index + 1}`}>
			{failed ? <span className="text-caption text-fg-subtle">Preview unavailable</span> : <Image src={url} alt={`Image ${index + 1}`} width={400} height={144} unoptimized loading="lazy" referrerPolicy="no-referrer" className="size-full object-contain" onError={() => setFailed(true)} />}
		</a>
		<div className="break-all px-3 py-2 text-caption"><DetailValue value={url} /></div>
	</li>;
}

export function ImagePreviews({ value }: { value: unknown }) {
	if (!Array.isArray(value)) return <DetailValue value={value} />;
	return <ul aria-label="Image previews" className="flex min-w-0 flex-col gap-3">
		{keyedItems(value).map(({ key, item, index }) => <ImagePreviewItem key={key} value={item} index={index} />)}
		{!value.length && <li className="text-fg-subtle">No images found</li>}
	</ul>;
}

function ImagePreviewItem({ value, index }: { value: unknown; index: number }) {
	return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value) ? <ImagePreview key={value} url={value} index={index} /> : <li><DetailValue value={value} /></li>;
}
