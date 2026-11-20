import { apiRoute, readJson } from '@/lib/server/api-route';
import { OrganizationStore, organizationPersistenceEnabled } from '@/lib/server/organization-store';

export const GET = apiRoute('organization-settings.get', async ({ account, database }) => organizationPersistenceEnabled(account) ? new OrganizationStore(database).get(account) : { local: true });

const write = apiRoute('organization-settings.save', async ({ account, database, request }) => {
	if (!organizationPersistenceEnabled(account)) return { local: true };
	const input = await readJson(request), store = new OrganizationStore(database);
	// A fresh client asks to connect once; there is no sign-in grant to adopt, so it just reads the settings.
	if ((input as { action?: unknown } | null)?.action === 'connect-signin') return store.get(account);
	return store.patch(account, input);
});
export const PATCH = write;
export const POST = write;
