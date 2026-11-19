import { contextUsage } from '@/lib/server/context';
import { CredentialError, describeError, jsonError, NO_STORE_HEADERS } from '@/lib/server/credentials';
import { browserAccess } from '@/lib/server/provider-access';

export async function GET(request: Request) {
	try {
		const access = await browserAccess(request);
		const key = access.key('context');
		if (!key) return jsonError('Connect Context.dev to see your credits.', 401);
		return Response.json(await contextUsage(key, access.contextUserEmail), { headers: NO_STORE_HEADERS });
	} catch (error) {
		return jsonError(describeError(error), error instanceof CredentialError ? error.status : 502);
	}
}
