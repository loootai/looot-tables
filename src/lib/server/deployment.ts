import 'server-only';

/** Parses a configured URL, naming the variable when it is malformed rather than failing with a bare "Invalid URL". */
export function configuredUrl(name: string, value: string) {
	if (!URL.canParse(value)) throw new Error(`${name} must be an absolute URL.`);
	return new URL(value);
}

/** Every deployment is self-hosted: one workspace per browser cookie. Local development can opt into signed-in test
    accounts with LOOOT_TABLES_DEV_AUTH=true. */
export const selfHostedEnabled = () => !(process.env.NODE_ENV === 'development' && process.env.LOOOT_TABLES_DEV_AUTH === 'true');

/** Public origin for canonical and Open Graph URLs. */
export function siteUrl() {
	const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
	try {
		const url = new URL(process.env.NEXT_PUBLIC_SITE_URL || process.env.LOOOT_TABLES_APP_URL || (vercel ? `https://${vercel}` : 'http://localhost:3000'));
		return new URL(url.origin);
	} catch {
		return new URL('http://localhost:3000');
	}
}

/** Search engines index a deployment only when it opts in with LOOOT_TABLES_ALLOW_INDEXING=true; Vercel previews never index. */
export const indexingEnabled = () => process.env.VERCEL_ENV !== 'preview' && process.env.LOOOT_TABLES_ALLOW_INDEXING === 'true';
