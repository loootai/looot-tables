import { verifyContactProvider } from '@/lib/server/contact-providers';
import type { KeyVerification } from '@/lib/types';
import type { Provider } from '@/lib/organization-settings';
import { NO_STORE_HEADERS } from '@/lib/server/credentials';
import { routeAccess, serverKeyAvailability, type ProviderAccess } from '@/lib/server/provider-access';
import { contextUsage } from '@/lib/server/context';
import { verifyTypesafeKey } from '@/lib/server/jev';
import { verifyOpenAI } from '@/lib/server/verify-openai';
import { generateText } from 'ai';
import { openaiLedger, typesafeLedger } from '@/lib/server/credit-ledger';

export const maxDuration = 30;

async function verifyTrial(access: ProviderAccess, inference: boolean): Promise<KeyVerification['openai']> {
	try {
		const balance = await openaiLedger((store) => store.balance(access.account!));
		if (!balance.deploymentAvailable || balance.remainingUsd <= 0) return { ok: false, issue: 'billing', message: 'AI trial credit is exhausted. Add your own OpenAI key to continue.' };
		if (!inference) return { ok: true, message: `This workspace has $${balance.remainingUsd.toFixed(2)} AI trial credit remaining.` };
		const result = await generateText({ model: access.openai(), prompt: 'Reply with OK.', maxOutputTokens: 64, maxRetries: 0 });
		return result.text.trim() ? { ok: true, inference: true, message: 'AI trial connection is ready.' } : { ok: false, message: 'The test did not return an answer. Try again.' };
	} catch {
		return { ok: false, message: 'The AI trial test could not complete. Check the trial balance or try again.' };
	}
}

/** The included TypeSafe trial is ready while its credit lasts; checking it never sends a decision. */
async function verifyTypesafeTrial(access: ProviderAccess): Promise<{ ok: boolean; message?: string }> {
	try {
		const balance = await typesafeLedger((store) => store.balance(access.account!));
		if (!balance.deploymentAvailable || balance.remainingUsd <= 0) return { ok: false, message: 'TypeSafe trial credit is exhausted. Add your own TypeSafe key to continue.' };
		return { ok: true, message: `This workspace has $${balance.remainingUsd.toFixed(2)} TypeSafe trial credit remaining.` };
	} catch {
		return { ok: false, message: 'The TypeSafe trial balance could not be checked. Try again.' };
	}
}

async function verifyContext(key: string, userEmail?: string): Promise<KeyVerification['context']> {
	try {
		const usage = await contextUsage(key, userEmail);
		return { ok: true, credits: usage.credits };
	} catch (error) {
		const status = (error as { status?: number }).status;
		const issue = status === 401 || status === 403 ? 'key' : status === 402 ? 'credits' : undefined;
		return { ok: false, issue, message: issue === 'key' ? 'Context.dev rejected this key.' : error instanceof Error ? error.message : 'Could not reach Context.dev' };
	}
}

/** Checks the keys the browser sent (or the server's own keys when allowed). Keys are never stored or logged. */
export async function POST(request: Request) {
	const access = await routeAccess(request);
	if (access instanceof Response) return access;
	const query = new URL(request.url).searchParams;
	// `only` limits checks to the providers being edited, so changing one key never calls the others.
	const only = query.get('openaiOnly') === 'true' ? ['openai'] : query.get('only')?.split(',');
	const check = (provider: string) => !only || only.includes(provider);
	const inference = query.get('inference') === 'true';
	const key = (provider: Provider) => check(provider) ? access.key(provider) : null;
	const openaiKey = access.key('openai'), contextKey = key('context'), typesafeKey = key('typesafe'), hunterKey = key('hunter'), prospeoKey = key('prospeo');
	const [openai, context, typesafe, hunter, prospeo] = await Promise.all([
		!check('openai') ? Promise.resolve({ ok: false, message: 'Not checked' }) : access.trial ? verifyTrial(access, inference) : openaiKey ? access.openaiEndpoint().then((endpoint) => verifyOpenAI(openaiKey, access.model, endpoint, inference)) : Promise.resolve({ ok: false, message: 'No OpenAI key' }),
		contextKey ? verifyContext(contextKey, access.contextUserEmail) : Promise.resolve({ ok: false, message: 'No Context.dev key' }),
		typesafeKey ? access.typesafeTrial ? verifyTypesafeTrial(access) : verifyTypesafeKey(typesafeKey) : Promise.resolve({ ok: false, message: 'No TypeSafe key' }),
		hunterKey ? verifyContactProvider('hunter', hunterKey) : Promise.resolve({ ok: false }),
		prospeoKey ? verifyContactProvider('prospeo', prospeoKey) : Promise.resolve({ ok: false }),
	]);
	const result: KeyVerification = { openai, context, hunter: { ...hunter, configured: Boolean(hunterKey) }, prospeo: { ...prospeo, configured: Boolean(prospeoKey) }, typesafe: { ...typesafe, configured: Boolean(typesafeKey) } };
	return new Response(JSON.stringify(result), { status: 200, headers: NO_STORE_HEADERS });
}

/** Which keys the server can supply on its own. Lets the app skip onboarding on self-hosted deployments. */
export async function GET(request: Request) {
	return new Response(JSON.stringify(await serverKeyAvailability(request)), { status: 200, headers: NO_STORE_HEADERS });
}
