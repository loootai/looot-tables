import type { ServerKeys } from '@/lib/api';
import { LOOOT_TOKENS_URL } from '@/lib/constants';
import { maskKey, type Settings } from '@/lib/keys';
import { providerField, type OrganizationSettings, type Provider } from '@/lib/organization-settings';

export const CONNECTION_ORDER = ['looot', 'openai', 'typesafe'] as const satisfies readonly Provider[];
export const REQUIRED_PROVIDERS = ['looot', 'openai'] as const satisfies readonly Provider[];

export const PROVIDER_INFO: Record<Provider, { name: string; logo: string; description: string; link: string; placeholder: string; verifiable: boolean }> = {
	looot: { name: 'looot', logo: '/providers/looot.svg', description: 'One token for web search, page reads, company and people data, emails and phones. Billed to your own looot balance', link: LOOOT_TOKENS_URL, placeholder: 'cs_ms_…', verifiable: true },
	openai: { name: 'OpenAI', logo: '/providers/openai.svg', description: 'AI columns, research, and Find rows', link: 'https://platform.openai.com/api-keys', placeholder: 'sk-…', verifiable: true },
	typesafe: { name: 'TypeSafe', logo: '/providers/typesafe.png', description: 'Calibrated yes/no and category answers', link: 'https://console.typesafe.ai/', placeholder: 'ts_…', verifiable: true },
};

/** saved: a browser-local key; connected: a workspace vault connection; deployment: server environment keys. */
export type ConnectionState = 'connected' | 'saved' | 'expired' | 'deployment' | 'missing';
export interface Connection { state: ConnectionState; detail?: string; source?: 'manual'; expiresAt?: number }

export const isReady = (connection: Connection) => connection.state !== 'missing' && connection.state !== 'expired';
export const isConfigured = (connection: Connection) => connection.state === 'connected' || connection.state === 'saved';

export function deriveConnections({ settings, organization, server }: { settings: Settings; organization: OrganizationSettings | null; server: ServerKeys | null }): Record<Provider, Connection> {
	const derive = (provider: Provider): Connection => {
		const key = settings[providerField[provider]];
		if (key) return { state: 'saved', detail: maskKey(key) };
		const status = organization?.providers[provider];
		if (status?.reconnectRequired) return { state: 'expired', expiresAt: status.expiresAt };
		if (status?.configured) return { state: 'connected', expiresAt: status.expiresAt, detail: status.prefix ? `${status.prefix}${'•'.repeat(8)}` : 'API key' };
		if (server?.[provider]) return { state: 'deployment', detail: 'Provided by this deployment' };
		return { state: 'missing' };
	};
	return Object.fromEntries(CONNECTION_ORDER.map((provider) => [provider, derive(provider)])) as Record<Provider, Connection>;
}

export function formatExpiry(expiresAt: number, now = Date.now()) {
	const minutes = Math.round((expiresAt - now) / 60_000);
	if (minutes <= 0) return 'expired';
	if (minutes < 60) return `expires in ${minutes} min`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `expires in ${hours} h` : `expires in ${Math.round(hours / 24)} days`;
}

/** MCP client config. Self-hosted provider keys live only in the browser, so agents must send their own. */
export function mcpConfig(endpoint: string, secret: string | undefined, selfHosted: boolean) {
	return JSON.stringify({ mcpServers: { 'looot-tables': { url: endpoint, headers: { Authorization: `Bearer ${secret ?? 'YOUR_AGENT_KEY'}`, ...(selfHosted ? { 'x-openai-key': 'YOUR_OPENAI_API_KEY', 'x-looot-key': 'YOUR_LOOOT_TOKEN' } : {}) } } } }, null, 2);
}
