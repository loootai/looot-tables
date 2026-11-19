import type { ServerKeys } from '@/lib/api';
import { CONTEXT_API_KEYS_URL } from '@/lib/constants';
import { maskKey, type Settings } from '@/lib/keys';
import { providerField, type OrganizationSettings, type Provider } from '@/lib/organization-settings';

export const CONNECTION_ORDER = ['context', 'openai', 'typesafe', 'hunter', 'prospeo', 'quickenrich', 'apollo', 'contactout'] as const satisfies readonly Provider[];
export const REQUIRED_PROVIDERS = ['context', 'openai'] as const satisfies readonly Provider[];

export const PROVIDER_INFO: Record<Provider, { name: string; logo: string; description: string; link: string; placeholder: string; verifiable: boolean }> = {
	context: { name: 'Context.dev', logo: '/providers/context.svg', description: 'Web search, company and people data, logos', link: CONTEXT_API_KEYS_URL, placeholder: 'ctxt_…', verifiable: true },
	openai: { name: 'OpenAI', logo: '/providers/openai.svg', description: 'AI columns, research, and Find rows', link: 'https://platform.openai.com/api-keys', placeholder: 'sk-…', verifiable: true },
	typesafe: { name: 'TypeSafe', logo: '/providers/typesafe.png', description: 'Calibrated yes/no and category answers', link: 'https://console.typesafe.ai/', placeholder: 'ts_…', verifiable: true },
	hunter: { name: 'Hunter', logo: '/providers/hunter.png', description: 'Find and verify work emails', link: 'https://hunter.io/api-keys', placeholder: 'Paste your API key', verifiable: true },
	prospeo: { name: 'Prospeo', logo: '/providers/prospeo.png', description: 'Work emails, mobile numbers, and person data', link: 'https://app.prospeo.io/', placeholder: 'Paste your API key', verifiable: true },
	quickenrich: { name: 'QuickEnrich', logo: '/providers/quickenrich.png', description: 'Find email provider', link: 'https://app.quickenrich.io/settings/api-key', placeholder: 'Paste your API key', verifiable: false },
	apollo: { name: 'Apollo', logo: '/providers/apollo.svg', description: 'Find email provider', link: 'https://developer.apollo.io/', placeholder: 'Paste your API key', verifiable: false },
	contactout: { name: 'ContactOut', logo: '/providers/contactout.png', description: 'Find email provider', link: 'https://contactout.com/api', placeholder: 'Paste your API key', verifiable: false },
};
export const LOGOLINK_URL = 'https://www.context.dev/dashboard/logolink';

/** saved: a browser-local key; connected: a workspace vault connection; included: a hosted included trial (OpenAI or TypeSafe); deployment: server environment keys. */
export type ConnectionState = 'connected' | 'saved' | 'expired' | 'included' | 'deployment' | 'missing';
export interface Connection { state: ConnectionState; detail?: string; source?: 'manual' | 'signin'; expiresAt?: number }

export const isReady = (connection: Connection) => connection.state !== 'missing' && connection.state !== 'expired';
export const isConfigured = (connection: Connection) => connection.state === 'connected' || connection.state === 'saved';

export function deriveConnections({ settings, organization, server, selfHosted, trialLimited }: { settings: Settings; organization: OrganizationSettings | null; server: ServerKeys | null; selfHosted: boolean; trialLimited: boolean }): Record<Provider, Connection> {
	const derive = (provider: Provider): Connection => {
		const key = settings[providerField[provider]];
		if (key) return { state: 'saved', detail: maskKey(key) };
		const status = organization?.providers[provider];
		if (status?.reconnectRequired) return { state: 'expired', source: status.source, expiresAt: status.expiresAt, detail: status.source === 'signin' ? 'Context.dev sign-in' : undefined };
		if (status?.configured) return { state: 'connected', source: status.source, expiresAt: status.expiresAt, detail: status.source === 'signin' ? 'Context.dev sign-in' : status.prefix ? `${status.prefix}${'•'.repeat(8)}` : 'API key' };
		if (provider === 'openai' && !selfHosted && server?.openaiTrial) return trialLimited ? { state: 'missing', detail: 'Included AI trial used up' } : { state: 'included', detail: `Included AI trial · ${server.openaiTrial.model}` };
		// Once the TypeSafe trial is used up, decisions fall back to OpenAI; the trials menu shows its balance.
		if (provider === 'typesafe' && !selfHosted && server?.typesafeTrial) return { state: 'included', detail: 'Included TypeSafe trial' };
		if (provider === 'context' && server?.contextConnected) return { state: 'connected', source: 'signin', detail: 'Context.dev sign-in' };
		if ((provider === 'openai' || provider === 'context' || provider === 'typesafe' || provider === 'hunter' || provider === 'prospeo') && server?.[provider]) return { state: 'deployment', detail: 'Provided by this deployment' };
		return { state: 'missing' };
	};
	return Object.fromEntries(CONNECTION_ORDER.map((provider) => [provider, derive(provider)])) as Record<Provider, Connection>;
}

/** Starts Context.dev consent and returns to the same page; `reconnect` replaces a disconnected or manual connection. */
export function contextReconnectHref(returnTo: string) {
	return `/api/auth/start?${new URLSearchParams({ returnTo, reconnect: 'context' })}`;
}

/** Hosted Context.dev reconnect from the current page. */
export function reconnectContext() {
	window.location.assign(contextReconnectHref(window.location.pathname + window.location.search));
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
	return JSON.stringify({ mcpServers: { enrichable: { url: endpoint, headers: { Authorization: `Bearer ${secret ?? 'YOUR_AGENT_KEY'}`, ...(selfHosted ? { 'x-openai-key': 'YOUR_OPENAI_API_KEY', 'x-context-key': 'YOUR_CONTEXT_DEV_API_KEY' } : {}) } } } }, null, 2);
}
