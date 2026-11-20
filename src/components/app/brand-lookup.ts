import { accountStorageKey } from '@/lib/account-storage';
import type { DocumentBranding, DocumentBrand } from '@/lib/document-branding';
import { keyHeaders } from '@/lib/keys';
import { logoDomain } from '@/lib/organization-logo';

/** A looked-up brand is kept a day per domain, so opening Settings doesn't run a looot company lookup each time. */
const BRAND_TTL = 24 * 60 * 60_000;
const brandKey = (domain: string) => accountStorageKey(`looot-tables.brand.v1.${domain}`);

function cachedBrand(domain: string): { brand?: DocumentBrand } | undefined {
	try {
		const entry = JSON.parse(window.localStorage.getItem(brandKey(domain)) ?? 'null') as { at: number; brand: DocumentBrand | null } | null;
		return entry && Date.now() - entry.at < BRAND_TTL ? { brand: entry.brand ?? undefined } : undefined;
	} catch { return undefined; }
}

function cacheBrand(domain: string, brand: DocumentBrand | undefined) {
	try { window.localStorage.setItem(brandKey(domain), JSON.stringify({ at: Date.now(), brand: brand ?? null })); } catch { /* Looked up again next visit. */ }
}

/** The brand for a company website; throws for a site looot can't read, so a bad domain never saves. */
export async function loadBrand(primaryDomain: string, signal?: AbortSignal): Promise<DocumentBrand | undefined> {
	const cached = cachedBrand(primaryDomain);
	if (cached) return cached.brand;
	const response = await fetch('/api/documents/branding', { method: 'POST', headers: keyHeaders(), body: JSON.stringify({ primaryDomain }), signal });
	const result: DocumentBranding & { error?: string } = await response.json();
	if (!response.ok) throw new Error(result.error || 'Could not load company branding.');
	cacheBrand(primaryDomain, result.primary);
	return result.primary;
}

/** The website typed into the field, as saved: '' for none, null when it isn't a website. */
export const brandingDomain = (value: string) => value.trim() ? logoDomain(value) : '';
