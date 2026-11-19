import 'server-only';

import { z } from 'zod';
import { renderTemplate, toDomain } from '../template';
import type { CellMeta, CellValue, ColumnOp, EnrichResponse } from '../types';
import { CredentialError } from './credentials';
import type { ProviderAccess } from './provider-access';
import { classifyFailure, EnrichError, failure, inputError } from './enrich-failure';

type Provider = 'hunter' | 'prospeo';
type ContactOp = Extract<ColumnOp, { kind: Provider }>;
const text = z.string().nullable().optional();
const hunterSchema = z.object({ data: z.object({ email: text, status: text, score: z.number().nullable().optional(), verification: z.object({ status: text }).nullable().optional(), sources: z.array(z.object({ uri: text })).optional() }).nullable() });
const contact = z.object({ revealed: z.boolean().optional(), email: text, mobile: text, status: text }).nullable().optional();
const prospeoSchema = z.object({ error: z.literal(false), free_enrichment: z.boolean().optional(), person: z.object({ full_name: text, current_job_title: text, linkedin_url: text, email: contact, mobile: contact, location: z.object({ city: text, state: text, country: text }).nullable().optional() }).nullable(), company: z.object({ name: text, website: text }).nullable().optional() });
const failureSchema = z.object({ error: z.boolean().optional(), error_code: z.string().optional(), errors: z.array(z.object({ id: z.string().optional() })).optional() });

const providerName = (provider: Provider) => provider === 'hunter' ? 'Hunter' : 'Prospeo';
const errorCode = (data: unknown) => {
	const parsed = failureSchema.safeParse(data);
	return parsed.success ? parsed.data.error_code ?? parsed.data.errors?.[0]?.id : undefined;
};

function providerError(provider: Provider, status: number, code?: string): EnrichError {
	const name = providerName(provider);
	if (status === 401 || code === 'INVALID_API_KEY') return new CredentialError(`${name} rejected this API key. Update it in Configuration.`, 401, 'credential_invalid', 'email');
	if (code === 'INSUFFICIENT_CREDITS' || code === 'not_enough_credits' || status === 402 || provider === 'hunter' && status === 429) return new EnrichError(`${name} credits or usage quota exhausted. Check your provider account.`, failure('credits_exhausted', 'email'));
	if (status === 429 || provider === 'hunter' && status === 403) return new EnrichError(`${name} rate limited (429). Wait a moment and try again.`, failure('rate_limited', 'email'));
	if (code === 'INVALID_DATAPOINTS' || code === 'INVALID_REQUEST') return inputError(`${name} could not use these inputs. Check the name, domain, email or LinkedIn URL.`, 'email');
	return new EnrichError(`${name} request failed (${status}). Check your provider account and inputs.`, failure('provider_error', 'email'));
}

/** Fixed provider hosts, header-only secrets, and errors that never echo upstream bodies. */
async function requestProvider(transport: typeof fetch, provider: Provider, key: string, path: string, body?: unknown): Promise<{ data: unknown; response: Response }> {
	let response: Response;
	try {
		response = await transport(`${provider === 'hunter' ? 'https://api.hunter.io/v2' : 'https://api.prospeo.io'}/${path}`, {
			method: body ? 'POST' : 'GET',
			headers: provider === 'hunter' ? { 'X-API-KEY': key } : { 'X-KEY': key, 'Content-Type': 'application/json' },
			...(body ? { body: JSON.stringify(body) } : {}),
			cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(25_000),
		});
	} catch (error) {
		throw new EnrichError(`${providerName(provider)} request timed out or could not connect. Try again.`, classifyFailure(error, 'email') ?? failure('provider_error', 'email'));
	}
	if (!response.ok) {
		const code = errorCode(await response.json().catch(() => null));
		if (provider === 'prospeo' && response.status === 400 && code === 'NO_MATCH') return { data: null, response };
		throw providerError(provider, response.status, code);
	}
	let data: unknown;
	try { data = await response.json(); } catch { throw new EnrichError(`${providerName(provider)} returned an unreadable response (${response.status}).`, failure('provider_error', 'email')); }
	const failed = failureSchema.safeParse(data);
	if (failed.success && (failed.data.error || failed.data.errors?.length)) throw providerError(provider, response.status, errorCode(data));
	return { data, response };
}

export async function verifyContactProvider(provider: Provider, key: string): Promise<{ ok: boolean; message?: string }> {
	try {
		const { data } = await requestProvider(fetch, provider, key, provider === 'hunter' ? 'account' : 'account-information');
		if (!data || typeof data !== 'object' || (provider === 'hunter' && !('data' in data))) return { ok: false, message: 'Provider returned an unexpected account response.' };
		return { ok: true };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : 'Could not check provider.' };
	}
}

/** The provider's own verification status travels beside the cell result, never inside its display text. */
export async function contactLookup(access: ProviderAccess, op: ContactOp, row: Record<string, CellValue>): Promise<{ result: EnrichResponse; verification: string | null }> {
	const key = access.requireKey(op.kind);
	const input = (value?: string) => renderTemplate(value ?? '', row);
	const fullName = input(op.name), domain = toDomain(input(op.domain)), email = input(op.email);
	const meta: CellMeta = { provider: op.kind };
	if (op.kind === 'hunter') {
		const params = new URLSearchParams();
		if (op.action === 'find') {
			if (!fullName || !domain) throw inputError('Hunter email finder needs a name and company domain for this row.', 'email');
			params.set('full_name', fullName); params.set('domain', domain);
		} else {
			if (!email) throw inputError('Hunter verification needs an email for this row.', 'email');
			params.set('email', email);
		}
		const { data, response } = await requestProvider(access.fetch('hunter'), 'hunter', key, `email-${op.action === 'find' ? 'finder' : 'verifier'}?${params}`);
		const parsed = hunterSchema.safeParse(data);
		if (!parsed.success) throw new EnrichError('Hunter returned an unexpected enrichment response.', failure('provider_error', 'email'));
		const result = parsed.data.data;
		const used = response.headers.get('x-credits-used');
		if (used !== null && Number.isFinite(Number(used)) && Number(used) >= 0) { meta.providerCredits = Number(used); meta.providerCreditUnit = response.headers.get('x-credits-unit') ?? 'credit'; }
		meta.sources = result?.sources?.flatMap((source) => source.uri && /^https?:\/\//i.test(source.uri) ? [source.uri] : []);
		if (result?.score != null) meta.confidence = Math.max(0, Math.min(1, result.score / 100));
		const verification = result?.status ?? result?.verification?.status ?? null;
		meta.reasoning = verification ?? (result?.email ? 'Email found by Hunter' : 'No email found');
		return { result: { value: op.action === 'find' ? result?.email ?? null : result?.status ?? null, meta }, verification };
	}
	const profileUrl = input(op.profileUrl);
	if (!email && !profileUrl && !(fullName && domain)) throw inputError('Prospeo needs an email, LinkedIn URL, or name and company domain for this row.', 'email');
	const identity = { ...(fullName ? { full_name: fullName } : {}), ...(domain ? { company_website: domain } : {}), ...(email ? { email } : {}), ...(profileUrl ? { linkedin_url: profileUrl } : {}) };
	const { data } = await requestProvider(access.fetch('prospeo'), 'prospeo', key, 'enrich-person', { data: identity, only_verified_email: op.onlyVerifiedEmail, enrich_mobile: op.field === 'mobile' });
	if (data === null) return { result: { value: null, meta: { ...meta, providerCredits: 0, reasoning: 'No matching person met the lookup requirements.' } }, verification: null };
	const parsed = prospeoSchema.safeParse(data);
	if (!parsed.success) throw new EnrichError('Prospeo returned an unexpected enrichment response.', failure('provider_error', 'email'));
	const { person, company, free_enrichment } = parsed.data;
	if (free_enrichment) meta.providerCredits = 0;
	if (person?.linkedin_url && /^https?:\/\//i.test(person.linkedin_url)) meta.sources = [person.linkedin_url];
	const values = {
		email: person?.email?.revealed ? person.email.email ?? null : null,
		mobile: person?.mobile?.revealed ? person.mobile.mobile ?? null : null,
		full_name: person?.full_name, title: person?.current_job_title,
		company: company?.name, company_domain: company?.website ? toDomain(company.website) : null,
		linkedin: person?.linkedin_url,
		location: person?.location ? [person.location.city, person.location.state, person.location.country].filter(Boolean).join(', ') || null : null,
	};
	const verification = op.field === 'email' ? person?.email?.status ?? null : null;
	meta.reasoning = op.field === 'email' ? verification ?? 'No email available' : op.field === 'mobile' ? person?.mobile?.status ?? 'No mobile available' : 'Person data from Prospeo';
	return { result: { value: values[op.field] ?? null, meta }, verification };
}

export async function runContactProvider(access: ProviderAccess, op: ContactOp, row: Record<string, CellValue>): Promise<EnrichResponse> {
	return (await contactLookup(access, op, row)).result;
}
