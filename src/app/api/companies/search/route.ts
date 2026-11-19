import { COMPANY_SEARCH_MIN_LENGTH } from '@/lib/company-search';
import { searchCompanySuggestions } from '@/lib/server/looot-jobs';
import { CredentialError, jsonError, NO_STORE_HEADERS } from '@/lib/server/credentials';
import { classifyFailure } from '@/lib/server/enrich-failure';
import { browserAccess } from '@/lib/server/provider-access';

/** Name or domain suggestions for a company field, from one looot web search. */
export async function POST(request: Request) {
	try {
		const body = await request.json();
		if (typeof body?.query !== 'string' || body.query.trim().length < COMPANY_SEARCH_MIN_LENGTH || body.query.trim().length > 200) {
			return jsonError('Enter between 3 and 200 characters to search companies.', 400);
		}
		const access = await browserAccess(request);
		if (!access.key('looot')) return jsonError('Add your looot token in Configuration to search companies.', 401);
		const companies = await searchCompanySuggestions(access.looot(), body.query, request.signal);
		return Response.json({ companies }, { headers: NO_STORE_HEADERS });
	} catch (error) {
		if (error instanceof CredentialError) return jsonError(error.message, error.status);
		if (error instanceof SyntaxError) return jsonError('Provide a company search query.', 400);
		const outcome = classifyFailure(error, 'looot');
		return jsonError(outcome?.reason === 'credits_exhausted' ? 'Your looot balance is too low to search companies.' : outcome?.reason === 'rate_limited' ? 'Too many searches. Wait a moment and try again.' : 'Company search is unavailable. You can still enter a company manually.', outcome?.reason === 'rate_limited' ? 429 : 502);
	}
}
