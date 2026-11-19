import { z } from 'zod';
import { documentBrand } from '@/lib/document-branding';
import { logoDomain } from '@/lib/organization-logo';
import { WorkspaceError } from '@/lib/workspace';
import { errorResponse, newTrace, readJson } from '@/lib/server/api-route';
import { CompanyContextStore } from '@/lib/server/company-context-store';
import { withDatabase } from '@/lib/server/database';
import { documentLogoData } from '@/lib/server/document-logo';
import { organizationPersistenceEnabled } from '@/lib/server/organization-store';
import { jsonError, NO_STORE_HEADERS } from '@/lib/server/credentials';
import { browserAccess } from '@/lib/server/provider-access';

const domain = z.string().max(253).transform((value) => value.trim() ? logoDomain(value) : '').refine((value) => value !== null, 'Enter a valid company website.');
const input = z.object({ primaryDomain: domain.optional(), secondaryDomain: domain.optional() });

export async function POST(request: Request) {
	const trace = newTrace('documents.branding');
	try {
		const parsed = input.safeParse(await readJson(request));
		if (!parsed.success) return jsonError('Enter valid company websites.', 400);
		const access = await browserAccess(request);
		const saved = !parsed.data.primaryDomain && organizationPersistenceEnabled(access.account)
			? await withDatabase((database) => new CompanyContextStore(database).get(access.account!)) : null;
		const primaryDomain = parsed.data.primaryDomain || saved?.brand?.domain;
		const secondaryDomain = parsed.data.secondaryDomain;
		if (!primaryDomain && !secondaryDomain) return Response.json({}, { headers: NO_STORE_HEADERS });
		if (!access.key('context')) return jsonError('Connect Context.dev to load document branding.', 401);
		const client = access.context();
		async function retrieve(domain: string) {
			try {
				const result = await client.brand.retrieve({ type: 'by_domain', domain }, { timeout: 20_000, maxRetries: 0, signal: request.signal });
				const brand = documentBrand(result.brand ?? {}, domain);
				if (brand.logoUrl) brand.logoUrl = await documentLogoData(brand.logoUrl);
				return brand;
			} catch { throw new WorkspaceError('Could not load document branding. Check the company websites and try again.', 502); }
		}
		const [primary, secondary] = await Promise.all([primaryDomain ? retrieve(primaryDomain) : undefined, secondaryDomain && secondaryDomain !== primaryDomain ? retrieve(secondaryDomain) : undefined]);
		return Response.json({ primary, secondary }, { headers: NO_STORE_HEADERS });
	} catch (error) { return errorResponse(error, trace); }
}
