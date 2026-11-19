'use client';

import { DEFAULT_MODEL } from './types';
import { accountHeaders, accountStorageKey } from './account-storage';
import { providerField, type OrganizationSettings, type Provider } from './organization-settings';

/* Settings come from one of two adapters, chosen once at startup:
 * - browser-local: self-hosted workspaces (and hosted sessions without organization storage) keep keys in localStorage;
 * - organization: hosted sessions keep secrets in the encrypted server vault and hold only preferences and connection status here.
 * Only unsaved key verification sends secret request headers. Logo Link uses a public client ID. */

export interface Settings {
	companyDomain?: string;
	openaiKey: string;
	/** The looot token. One token runs every lookup: search, scraping, company and people data, emails and phones. */
	loootKey: string;
	typesafeKey: string;
	/** Optional MoltSets key (`ms_…`) for flat-fee contact data. Sent only to this app's own routes, which pass it to MoltSets and nowhere else. */
	moltsetsKey: string;
	/** Optional: the deployment's ENRICHABLE_PASSWORD, when the host set server-side keys. */
	accessPassword: string;
	model: string;
	/** Decisions API by default; otherwise an independent OpenAI model ID. */
	classifierModel: string;
	/** Optional OpenAI-compatible base URL (Azure, a proxy, a local server). Uses the Chat Completions API. */
	openaiBaseUrl: string;
	concurrency: number;
	/** When true, check/classify/score columns prefer Jev; otherwise OpenAI. */
	preferJev: boolean;
}

const STORAGE_KEY = 'enrichable.settings.v1';
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };

export const DEFAULT_SETTINGS: Settings = { openaiKey: '', loootKey: '', typesafeKey: '', moltsetsKey: '', accessPassword: '', model: DEFAULT_MODEL, classifierModel: 'decisions', openaiBaseUrl: '', concurrency: 4, preferJev: true };
const publicFields = ['model', 'classifierModel', 'openaiBaseUrl', 'concurrency', 'preferJev', 'companyDomain'] as const;

// Browser-local adapter.
let cached: Settings | null = null;
let cachedStorageKey: string | null = null;
let cachedRaw: string | null = null;

function loadLocalSettings(): Settings {
	if (typeof window === 'undefined') return DEFAULT_SETTINGS;
	try {
		const key = accountStorageKey(STORAGE_KEY);
		const raw = window.localStorage.getItem(key);
		if (cached && cachedStorageKey === key && cachedRaw === raw) return cached;
		const saved = raw ? JSON.parse(raw) as Partial<Settings> : {};
		cached = { ...DEFAULT_SETTINGS, ...saved, classifierModel: saved.classifierModel || (saved.preferJev === false ? saved.model || DEFAULT_MODEL : 'decisions') };
		cachedStorageKey = key;
		cachedRaw = raw;
		return cached;
	} catch {
		// Account initialization and temporary storage failures must not cache empty keys.
		return DEFAULT_SETTINGS;
	}
}

function saveLocalSettings(patch: Partial<Settings>) {
	const next = { ...loadLocalSettings(), ...patch };
	const key = accountStorageKey(STORAGE_KEY);
	const raw = JSON.stringify(next);
	window.localStorage.setItem(key, raw);
	cached = next;
	cachedStorageKey = key;
	cachedRaw = raw;
	publish();
}

// Organization adapter. A failed load is retryable: it never caches the rejected request.
type OrganizationState =
	| { kind: 'off' }
	| { kind: 'loading'; promise: Promise<boolean> }
	| { kind: 'failed'; error: string }
	| { kind: 'loaded'; organization: OrganizationSettings; snapshot: Settings };
let organizationState: OrganizationState = { kind: 'off' };
let legacySettings: Settings | null = null;
let pendingSave: Promise<unknown> = Promise.resolve();

export function loadSettings(): Settings {
	if (organizationState.kind === 'off') return loadLocalSettings();
	// Never fall back to browser secrets while the organization vault is loading or unavailable.
	return organizationState.kind === 'loaded' ? organizationState.snapshot : DEFAULT_SETTINGS;
}

export function saveSettings(patch: Partial<Settings>) {
	if (organizationState.kind !== 'off') return saveOrganizationSettings(patch);
	saveLocalSettings(patch);
}

export function subscribeSettings(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Headers for calls to this app's API routes. */
export function keyHeaders(settings: Settings = loadSettings()): Record<string, string> {
	const headers: Record<string, string> = { 'content-type': 'application/json', ...accountHeaders() };
	if (settings.openaiKey) headers['x-openai-key'] = settings.openaiKey;
	if (settings.loootKey) headers['x-looot-key'] = settings.loootKey;
	if (settings.typesafeKey) headers['x-typesafe-key'] = settings.typesafeKey;
	if (settings.moltsetsKey) headers['x-moltsets-key'] = settings.moltsetsKey;
	if (settings.accessPassword) headers['x-enrichable-password'] = settings.accessPassword;
	if (settings.model) headers['x-openai-model'] = settings.model;
	if (settings.classifierModel) headers['x-classifier-model'] = settings.classifierModel;
	if (settings.openaiBaseUrl) headers['x-openai-base-url'] = settings.openaiBaseUrl;
	return headers;
}

export function maskKey(key: string): string {
	if (!key) return '';
	if (key.length <= 10) return '•'.repeat(key.length);
	return `${key.slice(0, 7)}${'•'.repeat(12)}${key.slice(-4)}`;
}

export const organizationSettingsEnabled = () => organizationState.kind !== 'off';
export const organizationSettingsSnapshot = () => organizationState.kind === 'loaded' ? organizationState.organization : null;
export const localSettingsToImport = () => legacySettings;

function publishOrganization(organization: OrganizationSettings) {
	organizationState = { kind: 'loaded', organization, snapshot: { ...DEFAULT_SETTINGS, ...organization.preferences } };
	publish();
}
function loadedOrganization() {
	if (organizationState.kind !== 'loaded') throw new Error('Workspace settings are still loading. Try again in a moment.');
	return organizationState.organization;
}
async function organizationRequest(method: string, body?: unknown) {
	const response = await fetch('/api/organization-settings', { method, headers: { ...accountHeaders(), 'Content-Type': 'application/json' }, cache: 'no-store', ...(body ? { body: JSON.stringify(body) } : {}) });
	if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || (method === 'PATCH' ? 'Could not save workspace settings.' : 'Could not load workspace settings.'));
	return await response.json() as OrganizationSettings & { local?: boolean };
}

export function initializeOrganizationSettings(): Promise<boolean> {
	if (organizationState.kind === 'loading') return organizationState.promise;
	if (organizationState.kind === 'loaded') return Promise.resolve(true);
	const promise = connectOrganization(loadLocalSettings()).catch((error: unknown) => {
		organizationState = { kind: 'failed', error: error instanceof Error ? error.message : 'Could not load workspace settings.' };
		publish();
		throw error;
	});
	organizationState = { kind: 'loading', promise };
	publish();
	return promise;
}
async function connectOrganization(previous: Settings) {
	const data = await organizationRequest('POST', { action: 'connect-signin' });
	if (data.local) { organizationState = { kind: 'off' }; publish(); return false; }
	legacySettings = previous !== DEFAULT_SETTINGS && Object.values(providerField).some((field) => previous[field]) ? previous : null;
	// Public preferences can also be imported even when this browser has no manual keys.
	try { if (!legacySettings && window.localStorage.getItem(accountStorageKey(STORAGE_KEY))) legacySettings = previous; } catch {}
	publishOrganization(data);
	return true;
}

/** Reloads organization settings; after a failed first load this retries the whole initialization. */
export async function refreshOrganizationSettings() {
	if (organizationState.kind === 'failed') { await initializeOrganizationSettings(); return; }
	if (organizationState.kind === 'loading') { await organizationState.promise; return; }
	if (organizationState.kind !== 'loaded') return;
	await pendingSave.catch(() => {});
	publishOrganization(await organizationRequest('GET'));
}

export function saveOrganizationSettings(patch: Partial<Settings>, expectedRevision?: number) {
	const save = pendingSave.catch(() => {}).then(async () => {
		const organization = loadedOrganization();
		const preferences = Object.fromEntries(publicFields.filter((field) => patch[field] !== undefined).map((field) => [field, patch[field]]));
		const providers = Object.fromEntries(Object.entries(providerField).filter(([, field]) => Boolean(patch[field]?.trim())).map(([provider, field]) => [provider, patch[field]!.trim()]));
		try { publishOrganization(await organizationRequest('PATCH', { revision: expectedRevision ?? organization.revision, preferences, providers })); }
		catch (error) { await refreshAfterConflict(); throw error; }
	});
	pendingSave = save;
	return save.then(() => undefined);
}
async function refreshAfterConflict() {
	try { publishOrganization(await organizationRequest('GET')); } catch {}
}

export async function disconnectOrganizationProvider(provider: Provider) {
	await pendingSave.catch(() => {});
	const organization = loadedOrganization();
	publishOrganization(await organizationRequest('PATCH', { revision: organization.revision, providers: { [provider]: null } }));
}

export async function importLocalOrganizationSettings() {
	await pendingSave.catch(() => {});
	const organization = loadedOrganization();
	const legacy = legacySettings;
	if (!legacy) return;
	const preferences = Object.fromEntries(publicFields.map((field) => [field, legacy[field]]));
	const providers = Object.fromEntries(Object.entries(providerField).filter(([provider, field]) => !organization.providers[provider as Provider] && Boolean(legacy[field])).map(([provider, field]) => [provider, legacy[field]]));
	publishOrganization(await organizationRequest('PATCH', { revision: organization.revision, preferences, providers, importOnly: true }));
	try { window.localStorage.removeItem(accountStorageKey(STORAGE_KEY)); } catch { throw new Error('Settings imported. Clear this browser’s old saved provider settings to remove its local copy.'); }
	legacySettings = null;
	publish();
}
