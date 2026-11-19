import { NO_STORE_HEADERS, jsonError } from '@/lib/server/credentials';
import { classifyFailure } from '@/lib/server/enrich-failure';
import { routeAccess } from '@/lib/server/provider-access';
import { inspectSummary } from '@/lib/server/looot-catalog';

/** The inputs and price of one catalog endpoint. Free. */
export async function GET(request: Request) {
	const access = await routeAccess(request);
	if (access instanceof Response) return access;
	if (!access.key('looot')) return jsonError('Add your looot token in Configuration to inspect an endpoint.', 401);
	const id = new URL(request.url).searchParams.get('id')?.trim();
	if (!id || id.length > 200 || !/^[A-Za-z0-9:._-]+$/.test(id)) return jsonError('Provide an endpoint id.', 400);
	try {
		return Response.json(inspectSummary(id, await access.looot().inspect(id)), { headers: NO_STORE_HEADERS });
	} catch (error) {
		const outcome = classifyFailure(error, 'looot');
		return jsonError(access.redact(error), outcome?.reason === 'credential_invalid' ? 401 : outcome?.reason === 'input_invalid' ? 404 : 502, outcome);
	}
}
