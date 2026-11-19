import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { z } from 'zod';
import type { Account } from '../auth-identity';
import { DECISIONS_CLASSIFIER, MODEL_ID, PROVIDERS, type OrganizationPreferences, type Provider } from '../organization-settings';
import { DEFAULT_MODEL, type Decider, type FailureProvider, type LoootCallMeta } from '../types';
import { readSession, SESSION_COOKIE } from './auth';
import { LoootClient } from './looot';
import { failureOf, newTrace } from './api-route';
import { clean, CredentialError, ensureSafeEndpoint, jsonError, redactError, safeBaseUrl } from './credentials';
import { classifyFailure, failure, Spend, spendMiddleware } from './enrich-failure';
import { typesafeClient, type Jev } from './jev';
import { openaiModel } from './openai';
import { withDatabase } from './database';
import { OrganizationStore, organizationPersistenceEnabled } from './organization-store';

/* Provider access: which key, model and endpoint a caller may use, and the clients built from them.
   Precedence is fixed (SOURCES order); a policy says which sources a caller may draw on:
   - request: explicit x-<provider>-key / model / endpoint headers, request-only (including verification of unsaved keys);
   - vault: the signed-in organization's encrypted provider vault and shared preferences;
   - server: OPENAI_API_KEY / LOOOT_TOKEN / ... on a self-hosted deployment. Anyone with the URL could spend
     those, so they are used only when ENRICHABLE_PASSWORD is set and matched, or when
     ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD=true is set deliberately.
   Every run is billed to the caller's own looot token. There is no shared token and no included credit. */

export const SOURCES = ['request', 'vault', 'server'] as const;
export type Source = typeof SOURCES[number];

/** Which sources a caller may draw on, and whether a malformed request override is rejected or ignored. */
export interface AccessPolicy { sources: readonly Source[]; strict: boolean }
export const BROWSER_POLICY: AccessPolicy = { sources: SOURCES, strict: false };
/** MCP callers hold only an organization API key: never browser cookies or deployment keys. */
export const MCP_POLICY: AccessPolicy = { sources: ['request', 'vault'], strict: true };

/** Per-provider server wiring. Keyed by Provider, so a provider added to PROVIDERS does not compile until wired here.
    `refuses`: the statuses a provider answers without processing a request, when not just 429. */
const PROVIDER_INFO: Record<Provider, { env: string; label: string; failure: FailureProvider }> = {
	openai: { env: 'OPENAI_API_KEY', label: 'OpenAI', failure: 'openai' },
	looot: { env: 'LOOOT_TOKEN', label: 'looot', failure: 'looot' },
	typesafe: { env: 'TYPESAFE_API_KEY', label: 'TypeSafe', failure: 'typesafe' },
};
const OPENAI_API = 'https://api.openai.com/v1';

type Keys = Partial<Record<Provider, string>>;
export interface Vault { keys: Keys; preferences: Partial<Pick<OrganizationPreferences, 'model' | 'classifierModel' | 'openaiBaseUrl' | 'preferJev'>> }
/** Deployment configuration. Keys count only when `unlocked`. */
export interface ServerEnv { unlocked: boolean; keys: Keys; model?: string | null; baseUrl?: string | null }
/** Everything the gathering I/O found. The resolver ignores what the policy excludes. */
export interface AccessInputs {
	/** Verified actor; never supplied by request JSON. */
	account?: Account;
	headers: Headers;
	vault?: Vault | null;
	server?: ServerEnv;
}

/** What a caller resolved to. Plain data, so tests can build one directly. */
export interface AccessGrant {
	account?: Account;
	keys: Keys;
	model?: string;
	classifierModel?: string;
	openaiBaseUrl?: string | null;
	preferJev?: boolean;
}

type Offer = { keys?: Partial<Record<Provider, string | null>>; model?: string | null; classifier?: string | null; endpoint?: string | null; preferJev?: boolean | null };
type Found<T> = { source: Source; value: T } | null;

const invalidOverride = () => new CredentialError('Invalid provider credential headers.', 400);
const validModel = (value: string) => value.length <= 100 && MODEL_ID.test(value);

/** What each permitted source offers, in precedence order. */
function offers(policy: AccessPolicy, { headers, vault, server }: AccessInputs): Array<[Source, Offer]> {
	const header = (name: string) => headers.get(name)?.trim() || null;
	const requestKey = (provider: Provider) => {
		const raw = header(`x-${provider}-key`);
		if (!raw || clean(raw)) return raw;
		if (policy.strict) throw invalidOverride();
		return null;
	};
	const preferJev = header('x-prefer-jev');
	const table: Record<Source, Offer> = {
		request: { keys: Object.fromEntries(PROVIDERS.map((provider) => [provider, requestKey(provider)])), model: header('x-openai-model'), classifier: header('x-classifier-model'), endpoint: header('x-openai-base-url'), preferJev: preferJev === null ? null : preferJev !== 'false' },
		vault: vault ? { keys: vault.keys, model: vault.preferences.model, classifier: vault.preferences.classifierModel, endpoint: vault.preferences.openaiBaseUrl, preferJev: vault.preferences.preferJev } : {},
		server: server ? { keys: server.unlocked ? server.keys : {}, model: server.model, endpoint: server.unlocked ? safeBaseUrl(server.baseUrl) : null } : {},
	};
	const permitted = new Set(policy.sources);
	return SOURCES.filter((source) => permitted.has(source)).map((source) => [source, table[source]]);
}

function first<T>(rows: Array<[Source, Offer]>, pick: (offer: Offer) => T | null | undefined): Found<T> {
	for (const [source, offer] of rows) {
		const value = pick(offer);
		if (value !== null && value !== undefined && value !== '') return { source, value };
	}
	return null;
}

/** Pure precedence: the highest permitted source wins per setting. Throws CredentialError for unusable combinations. */
export function resolveGrant(policy: AccessPolicy, inputs: AccessInputs): AccessGrant {
	const rows = offers(policy, inputs);
	const { account } = inputs;
	const keys: Keys = {};
	for (const provider of PROVIDERS) {
		const key = first(rows, (offer) => offer.keys?.[provider]);
		if (key) keys[provider] = key.value;
	}
	const openai = first(rows, (offer) => offer.keys?.openai);
	const modelId = (found: Found<string>) => {
		if (!found || validModel(found.value)) return found?.value;
		if (policy.strict && found.source === 'request') throw invalidOverride();
		return undefined;
	};
	const model = modelId(first(rows, (offer) => offer.model)) ?? DEFAULT_MODEL;
	const classifier = modelId(first(rows, (offer) => offer.classifier));
	const requested = first(rows, (offer) => offer.endpoint);
	const endpoint = requested ? safeBaseUrl(requested.value) : null;
	if (requested && !endpoint) throw new CredentialError('The OpenAI base URL must be a public http(s) URL.', 400);
	const preferJev = first(rows, (offer) => offer.preferJev)?.value ?? true;
	// A key goes only to its own source's endpoint unless the caller supplies the key too.
	if (openai && requested && SOURCES.indexOf(requested.source) < SOURCES.indexOf(openai.source)) {
		const own = safeBaseUrl(rows.find(([source]) => source === openai.source)?.[1].endpoint) ?? OPENAI_API;
		if (endpoint !== own) throw new CredentialError(`Supply an explicit OpenAI key when overriding the ${openai.source === 'vault' ? 'organization' : 'server'} provider endpoint.`, 400);
	}
	return { account, keys, model, classifierModel: classifier && classifier !== DECISIONS_CLASSIFIER ? classifier : undefined, openaiBaseUrl: endpoint, preferJev };
}

/** What every provider caller gets. */
export interface ProviderAccess {
	readonly account?: Account;
	/** Main model id. */
	readonly model: string;
	/** Independent decision model; undefined means the decision default. */
	readonly classifierModel?: string;
	/** What this access's clients spent. A run takes its own (`withSpend`), so its failures know whether it paid. */
	readonly spend: Spend;
	/** The same access, its clients recording into `spend`. `attempt` names one cell attempt: every looot run it makes
	    derives its idempotency key from it, so a resend of the same attempt never pays twice. */
	withSpend(spend: Spend, attempt?: string): ProviderAccess;
	/** The raw key, or null. */
	key(provider: Provider): string | null;
	/** The key, or a credential_missing CredentialError naming the provider. */
	requireKey(provider: Provider): string;
	/** An OpenAI model on the resolved endpoint; spend tracking and the endpoint guard run inside. */
	openai(model?: string): LanguageModelV4;
	/** The looot client of this access: every outside lookup is one looot run on the caller's own token. Memoized, so
	    its calls accumulate for the cell panel. */
	looot(): LoootClient;
	/** Every looot run this access made so far, in order. */
	readonly calls: readonly LoootCallMeta[];
	/** A TypeSafe client. */
	typesafe(): Jev;
	/** The engine a decision column should prefer: a classifier model or the caller's preference can force OpenAI. */
	decider(requested?: Decider): Decider;
	/** Fails early when the OpenAI endpoint is unsafe. Memoized; every OpenAI request awaits it too. */
	checkEndpoint(): Promise<void>;
	/** The OpenAI base URL (null for the default), only after the endpoint guard passes. */
	openaiEndpoint(): Promise<string | null>;
	/** Error text with every resolved key redacted, safe for cells and streams. */
	redact(error: unknown): string;
}

/** Replaceable SDK edges, so tests can back an access with in-memory fakes. A fake looot fetch sends no requests,
    so it records no spend. */
export interface AccessAdapters {
	openai?: typeof openaiModel;
	/** The fetch looot requests go through; the global one by default. */
	looot?: typeof fetch;
	lookup?: (host: string) => Promise<Array<{ address: string }>>;
}

export function providerAccess(grant: AccessGrant, adapters: AccessAdapters = {}): ProviderAccess {
	const keys = grant.keys;
	const model = grant.model ?? DEFAULT_MODEL;
	let checked: Promise<void> | undefined;
	const checkEndpoint = () => checked ??= ensureSafeEndpoint(grant.openaiBaseUrl, adapters.lookup);
	const requireKey = (provider: Provider) => {
		const key = keys[provider];
		if (!key) throw new CredentialError(`Add your ${PROVIDER_INFO[provider].label} API key in Configuration to run this column.`, 401, 'credential_missing', PROVIDER_INFO[provider].failure);
		return key;
	};
	const guard: LanguageModelMiddleware = { specificationVersion: 'v4', wrapGenerate: async ({ doGenerate }) => { await checkEndpoint(); return doGenerate(); }, wrapStream: async ({ doStream }) => { await checkEndpoint(); return doStream(); } };
	const build = (spend: Spend, attempt?: string): ProviderAccess => {
		let looot: LoootClient | undefined;
		return {
			account: grant.account, model, classifierModel: grant.classifierModel,
			spend,
			withSpend: build,
			key: (provider) => keys[provider] ?? null,
			requireKey,
			openai(requested) {
				const built = (adapters.openai ?? openaiModel)(requireKey('openai'), requested ?? model, grant.openaiBaseUrl ?? null);
				return wrapLanguageModel({ model: built, middleware: grant.openaiBaseUrl ? [spendMiddleware(spend), guard] : spendMiddleware(spend) });
			},
			looot: () => looot ??= new LoootClient({ token: requireKey('looot'), spend, attempt, fetch: adapters.looot }),
			get calls() { return looot?.calls ?? []; },
			typesafe: () => typesafeClient(requireKey('typesafe'), spend),
			decider: (requested = 'jev') => grant.classifierModel || requested === 'openai' || grant.preferJev === false ? 'openai' : 'jev',
			checkEndpoint,
			openaiEndpoint: async () => { await checkEndpoint(); return grant.openaiBaseUrl ?? null; },
			redact: (error) => redactError(error, Object.values(keys)),
		};
	};
	return build(new Spend());
}

export const resolveAccess = (policy: AccessPolicy, inputs: AccessInputs) => providerAccess(resolveGrant(policy, inputs));

/* ───────────── Gathering I/O: read only what each policy may use ───────────── */

// Compares fixed-length digests: timingSafeEqual throws on unequal lengths, and returning early would leak the password's length.
function samePassword(given: string, password: string): boolean {
	const digest = (value: string) => createHash('sha256').update(value).digest();
	return timingSafeEqual(digest(given), digest(password));
}

function serverEnv(request: Request): ServerEnv {
	const password = process.env.ENRICHABLE_PASSWORD;
	return {
		unlocked: password ? samePassword(request.headers.get('x-enrichable-password') ?? '', password) : process.env.ENRICHABLE_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD === 'true',
		keys: Object.fromEntries(PROVIDERS.flatMap((provider) => { const key = clean(process.env[PROVIDER_INFO[provider].env]); return key ? [[provider, key]] : []; })),
		model: clean(process.env.OPENAI_MODEL),
		baseUrl: process.env.OPENAI_BASE_URL,
	};
}

const vaultOf = ({ keys, settings }: Awaited<ReturnType<OrganizationStore['credentials']>>): Vault => ({ keys, preferences: settings.preferences });

function requestAccount(request: Request) {
	const cookie = (request.headers.get('cookie') ?? '').split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(`${SESSION_COOKIE}=`));
	return readSession(cookie?.slice(SESSION_COOKIE.length + 1)) ?? undefined;
}

export async function browserInputs(request: Request): Promise<AccessInputs> {
	const account = requestAccount(request);
	const vault = organizationPersistenceEnabled(account) ? vaultOf(await withDatabase((database) => new OrganizationStore(database).credentials(account!))) : null;
	return { account, headers: request.headers, vault, server: serverEnv(request) };
}

/** MCP inputs never include cookies or deployment configuration. */
export async function mcpInputs(headers: Headers, actor: Account, organization?: OrganizationStore): Promise<AccessInputs> {
	return { account: actor, headers, vault: organization ? vaultOf(await organization.credentials(actor)) : null };
}

export const browserAccess = async (request: Request) => resolveAccess(BROWSER_POLICY, await browserInputs(request));
export const mcpAccess = async (headers: Headers, actor: Account, organization?: OrganizationStore) => resolveAccess(MCP_POLICY, await mcpInputs(headers, actor, organization));

/** What the browser policy resolves without request overrides, so the client knows whether it must ask for keys. */
export async function serverKeyAvailability(request: Request) {
	const inputs = await browserInputs(request);
	const rows = offers(BROWSER_POLICY, { ...inputs, headers: new Headers() });
	const available = Object.fromEntries(PROVIDERS.map((provider) => [provider, Boolean(first(rows, (offer) => offer.keys?.[provider]))])) as Record<Provider, boolean>;
	return {
		...available,
		passwordRequired: Boolean(process.env.ENRICHABLE_PASSWORD),
	};
}

/* ───────────── Route preamble ───────────── */

/** Browser provider access with the OpenAI endpoint already checked, or the error response. */
export async function routeAccess(request: Request): Promise<ProviderAccess | Response> {
	try {
		const access = await browserAccess(request);
		await access.checkEndpoint();
		return access;
	} catch (error) {
		if (error instanceof CredentialError) return jsonError(error.message, error.status, error.failure);
		// Anything other than a credential problem is the server's own storage or configuration failing.
		const { status, error: message } = failureOf(error, newTrace('provider-access'));
		return jsonError(message, status, classifyFailure(error) ?? failure('provider_error', undefined, true));
	}
}

/** Parses the JSON body against `schema`, then resolves provider access. Every failure is a ready response. */
export async function routeInput<S extends z.ZodType>(request: Request, schema: S): Promise<{ input: z.output<S>; access: ProviderAccess } | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonError('Invalid JSON body', 400, failure('input_invalid'));
	}
	const parsed = schema.safeParse(body);
	if (!parsed.success) return jsonError(`Invalid request: ${parsed.error.issues[0]?.message ?? 'bad input'}`, 400, failure('input_invalid'));
	const access = await routeAccess(request);
	return access instanceof Response ? access : { input: parsed.data, access };
}
