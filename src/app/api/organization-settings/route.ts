import { cookies } from 'next/headers';
import { apiRoute, readJson } from '@/lib/server/api-route';
import { CONTEXT_CONNECTION_COOKIE, readContextConnection } from '@/lib/server/context-connection';
import { OrganizationStore, organizationPersistenceEnabled } from '@/lib/server/organization-store';

export const GET = apiRoute('organization-settings.get', async ({ account, database }) => organizationPersistenceEnabled(account) ? new OrganizationStore(database).get(account) : { local: true });

const write = apiRoute('organization-settings.save', async ({ account, database, request }) => {
	if (!organizationPersistenceEnabled(account)) return { local: true };
	const input = await readJson(request), store = new OrganizationStore(database);
	if ((input as { action?: unknown } | null)?.action !== 'connect-signin') return store.patch(account, input);
	// The pre-persistence sign-in left its Context.dev grant in a cookie; the workspace adopts it once, then the cookie goes.
	const jar = await cookies(), token = jar.get(CONTEXT_CONNECTION_COOKIE)?.value;
	const settings = await store.adoptSignin(account, token ? await readContextConnection(token, account).catch(() => null) : null);
	jar.delete(CONTEXT_CONNECTION_COOKIE);
	return settings;
});
export const PATCH = write;
export const POST = write;
