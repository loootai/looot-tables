import { BROWSER_POLICY, browserInputs, providerAccess, resolveGrant, type AccessAdapters, type AccessGrant } from '../../src/lib/server/provider-access';

/** Provider access built in memory. Custom OpenAI endpoints resolve to a public documentation address (TEST-NET-3), so the endpoint guard passes without DNS. */
export const testAccess = (grant: Partial<AccessGrant> = {}, adapters: AccessAdapters = {}) => providerAccess({ keys: {}, ...grant }, { lookup: async () => [{ address: '203.0.113.10' }], ...adapters });

/** What the browser policy resolves for a request, as plain data. */
export const requestGrant = async (request: Request) => resolveGrant(BROWSER_POLICY, await browserInputs(request));
