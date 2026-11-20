import { NO_STORE_HEADERS, jsonError } from '@/lib/server/credentials';
import { routeAccess } from '@/lib/server/provider-access';
import { checkMoltSets } from '@/lib/server/moltsets-plan';

/** The caller's own MoltSets plan: records left in the current 5 hour window and phone tokens. `get_account` is free. */
export async function GET(request: Request) {
	const access = await routeAccess(request);
	if (access instanceof Response) return access;
	if (!access.key('moltsets')) return jsonError('Add your MoltSets key in Configuration.', 401);
	const check = await checkMoltSets(access.moltsets());
	if (!check.plan) return jsonError(check.message ?? 'Could not read the MoltSets plan.', check.issue === 'key' ? 401 : 502);
	return Response.json(check.plan, { headers: NO_STORE_HEADERS });
}
