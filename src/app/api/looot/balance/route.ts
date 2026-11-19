import { NO_STORE_HEADERS, jsonError } from '@/lib/server/credentials';
import { classifyFailure } from '@/lib/server/enrich-failure';
import { routeAccess } from '@/lib/server/provider-access';

/** The caller's own looot balance in USD. Free to read. */
export async function GET(request: Request) {
	const access = await routeAccess(request);
	if (access instanceof Response) return access;
	if (!access.key('looot')) return jsonError('Add your looot token in Configuration.', 401);
	try {
		const balance = await access.looot().balance();
		return Response.json({ available: balance.available, reserved: balance.reserved, topUpUrl: balance.topUpUrl ?? 'https://looot.ai/usage' }, { headers: NO_STORE_HEADERS });
	} catch (error) {
		const outcome = classifyFailure(error, 'looot');
		return jsonError(access.redact(error), outcome?.reason === 'credential_invalid' ? 401 : 502, outcome);
	}
}
