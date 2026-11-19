import type { KeyVerification } from '@/lib/types';
import type { Provider } from '@/lib/organization-settings';
import { NO_STORE_HEADERS } from '@/lib/server/credentials';
import { routeAccess, serverKeyAvailability, type ProviderAccess } from '@/lib/server/provider-access';
import { verifyTypesafeKey } from '@/lib/server/jev';
import { verifyOpenAI } from '@/lib/server/verify-openai';
import { verifyLoootToken } from '@/lib/server/looot-verify';

export const maxDuration = 30;

/** Checks the keys the browser sent (or the server's own keys when allowed). Keys are never stored or logged. The looot
    check reads the balance, which is free. */
export async function POST(request: Request) {
	const access: ProviderAccess | Response = await routeAccess(request);
	if (access instanceof Response) return access;
	const query = new URL(request.url).searchParams;
	const only = query.get('openaiOnly') === 'true' ? ['openai'] : query.get('only')?.split(',');
	const check = (provider: string) => !only || only.includes(provider);
	const inference = query.get('inference') === 'true';
	const key = (provider: Provider) => check(provider) ? access.key(provider) : null;
	const openaiKey = access.key('openai'), loootKey = key('looot'), typesafeKey = key('typesafe');
	const [openai, looot, typesafe] = await Promise.all([
		!check('openai') ? Promise.resolve({ ok: false, message: 'Not checked' }) : openaiKey ? access.openaiEndpoint().then((endpoint) => verifyOpenAI(openaiKey, access.model, endpoint, inference)) : Promise.resolve({ ok: false, message: 'No OpenAI key' }),
		loootKey ? verifyLoootToken(loootKey) : Promise.resolve({ ok: false, message: 'No looot token' }),
		typesafeKey ? verifyTypesafeKey(typesafeKey) : Promise.resolve({ ok: false, message: 'No TypeSafe key' }),
	]);
	const result: KeyVerification = { openai, looot, typesafe: { ...typesafe, configured: Boolean(typesafeKey) } };
	return new Response(JSON.stringify(result), { status: 200, headers: NO_STORE_HEADERS });
}

/** Which keys the server can supply on its own. Lets the app skip onboarding on self-hosted deployments. */
export async function GET(request: Request) {
	return new Response(JSON.stringify(await serverKeyAvailability(request)), { status: 200, headers: NO_STORE_HEADERS });
}
