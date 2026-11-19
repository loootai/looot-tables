import { COMPANY_SEARCH_MIN_LENGTH } from '@/lib/company-search';
import { searchCompanySuggestions } from '@/lib/server/company-search';
import { CredentialError, jsonError, NO_STORE_HEADERS } from '@/lib/server/credentials';
import { browserAccess } from '@/lib/server/provider-access';

/** Name/domain autocomplete, rather than the natural-language company discovery endpoint. */
export async function POST(request: Request) {
	try {
		const body = await request.json();
		if (typeof body?.query !== 'string' || body.query.trim().length < COMPANY_SEARCH_MIN_LENGTH || body.query.trim().length > 200) {
			return jsonError('Enter between 3 and 200 characters to search companies.', 400);
		}
		const access = await browserAccess(request);
		if (!access.key('context')) return jsonError('Connect Context.dev in Configuration to search companies.', 401);
		const companies = await searchCompanySuggestions(access.context(), body.query, request.signal);
		return Response.json({ companies }, { headers: NO_STORE_HEADERS });
	} catch (error) {
		if (error instanceof CredentialError) return jsonError(error.message, error.status);
		if (error instanceof SyntaxError) return jsonError('Provide a company search query.', 400);
		const status = (error as { status?: number }).status;
		return jsonError(status === 401 ? 'Context.dev rejected this key. Check your connection in Configuration.' : status === 429 ? 'Too many searches. Wait a moment and try again.' : 'Company search is unavailable. You can still enter a company manually.', status === 401 ? 401 : status === 429 ? 429 : 502);
	}
}
