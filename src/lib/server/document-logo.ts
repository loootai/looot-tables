import 'server-only';

const MAX_LOGO_BYTES = 5_000_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);

export async function documentLogoData(url: string): Promise<string> {
	const parsed = new URL(url);
	if (parsed.protocol !== 'https:' || parsed.hostname !== 'media.brand.dev' || parsed.port || parsed.username || parsed.password) throw new Error('Unsupported brand image host');
	const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
	const mime = response.headers.get('content-type')?.split(';')[0].trim();
	if (!response.ok || !mime || !IMAGE_TYPES.has(mime) || !response.body) throw new Error('Brand image unavailable');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > MAX_LOGO_BYTES) throw new Error('Brand image too large');
			chunks.push(value);
		}
	} finally { await reader.cancel(); }
	if (!length) throw new Error('Empty brand image');
	return `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`;
}
