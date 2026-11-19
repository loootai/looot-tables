import { NO_STORE_HEADERS, jsonError } from '@/lib/server/credentials';
import { classifyFailure } from '@/lib/server/enrich-failure';
import { routeAccess } from '@/lib/server/provider-access';
import { parsePriceUsd } from '@/lib/server/looot-catalog';

/** Search the looot catalog in plain words. Free. */
export async function GET(request: Request) {
	const access = await routeAccess(request);
	if (access instanceof Response) return access;
	if (!access.key('looot')) return jsonError('Add your looot token in Configuration to search the catalog.', 401);
	const q = new URL(request.url).searchParams.get('q')?.trim();
	if (!q) return Response.json({ results: [] }, { headers: NO_STORE_HEADERS });
	if (q.length > 200) return jsonError('Search with up to 200 characters.', 400);
	try {
		const found = await access.looot().search(q, 20);
		return Response.json({
			results: found.endpoints.map((hit) => ({
				endpointId: hit.endpointId,
				provider: hit.provider ?? null,
				name: hit.name ?? hit.endpointId,
				category: hit.category ?? null,
				job: hit.job?.id ?? hit.capability ?? null,
				runnable: hit.access === undefined || hit.access === 'runs_now',
				priceUsd: parsePriceUsd(hit.estimatedPrice),
			})),
		}, { headers: NO_STORE_HEADERS });
	} catch (error) {
		const outcome = classifyFailure(error, 'looot');
		return jsonError(access.redact(error), outcome?.reason === 'credential_invalid' ? 401 : 502, outcome);
	}
}
