import 'server-only';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from './credentials';

const MAX_LOGO_BYTES = 5_000_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);

type Resolve = (host: string) => Promise<Array<{ address: string }>>;

/** A company logo as a data URL, so a PDF embeds it without browser CORS. looot providers host logos on many CDNs, so the
    host is not fixed. The URL must be https with no port or credentials, every address its host resolves to must be public
    (in development too), and no redirect is followed. */
export async function documentLogoData(url: string, resolve: Resolve = (host) => lookup(host, { all: true })): Promise<string> {
	const parsed = new URL(url);
	if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) throw new Error('Unsupported brand image host');
	const host = parsed.hostname.replace(/^\[|\]$/g, '');
	const addresses = isIP(host) ? [{ address: host }] : await resolve(host).catch(() => []);
	if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error('Brand image host is not public');
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
