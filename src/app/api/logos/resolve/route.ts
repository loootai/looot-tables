import { WorkspaceError } from '@/lib/workspace';
import { errorResponse, newTrace, readJson } from '@/lib/server/api-route';
import { jsonError, NO_STORE_HEADERS } from '@/lib/server/credentials';
import { browserAccess } from '@/lib/server/provider-access';
import { logoDomain } from '@/lib/organization-logo';

/** Resolve names only; Logo Link images are embedded directly from the provider CDN. */
export async function POST(request: Request) {
	const trace = newTrace('logos.resolve');
	try {
		const access = await browserAccess(request);
		if (!access.key('context')) return jsonError('Connect Context.dev to look up organization names.', 401);
		const body = await readJson(request) as { name?: unknown } | null;
		if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 300) return jsonError('Provide an organization name of up to 300 characters.', 400);
		const name = body.name.trim();
		const result = await access.context().brand.search({ query: name, autocomplete: false }, { timeout: 8_000, maxRetries: 0 }).catch((error: unknown) => { throw new WorkspaceError(access.redact(error), 502); });
		const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
		// Avoid substituting a similarly named organization when the search is ambiguous.
		const matches = result.results.filter((entry) => normalize(entry.name) === normalize(name));
		const domains = new Set(matches.map((entry) => logoDomain(entry.domain)).filter((value) => value !== null));
		return Response.json({ domain: domains.size === 1 ? [...domains][0] : null }, { headers: NO_STORE_HEADERS });
	} catch (error) { return errorResponse(error, trace); }
}
