import 'server-only';

import type { ContactSource, MoltSetsCallMeta } from '../types';
import { riskGrade } from '../moltsets-risk';
import type { MoltSetsAnswer, MoltSetsClient, MoltSetsTool } from './moltsets';

/* Contact lookups against a MoltSets plan, tried before looot. Each function makes one MoltSets lookup (two for a phone
   found by name) and returns what the cell keeps: the value, and the attempt for the receipt. A MoltSets hit is the
   answer and looot is never called; a miss, a spent window or an error leaves looot to answer. */

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Which sources a column may use, given whether a MoltSets key exists. An unset source is `moltsets-first`. */
export function sourcePlan(source: ContactSource | undefined, hasKey: boolean): { moltsets: boolean; looot: boolean } {
	if (source === 'looot') return { moltsets: false, looot: true };
	if (source === 'moltsets') return { moltsets: true, looot: false };
	return { moltsets: hasKey, looot: true };
}

/** What a column's source setting resolved to for one run: the plan, and the attempt once MoltSets was asked. */
export interface FlatFee<T> {
	attempt: MoltSetsCallMeta;
	/** Set only when MoltSets answered. */
	value?: T;
}

/** The receipt line of an answer that was not a hit. */
function attemptOf(tool: MoltSetsTool, answer: MoltSetsAnswer, hit?: Partial<MoltSetsCallMeta>): MoltSetsCallMeta {
	const reason = answer.outcome === 'exhausted' ? 'The MoltSets plan has no room left in this window.' : answer.outcome === 'error' ? `${answer.message ?? 'MoltSets could not answer.'}${answer.code ? ` (${answer.code})` : ''}` : answer.outcome === 'miss' ? 'Not found. MoltSets does not charge for a miss.' : undefined;
	return {
		tool,
		outcome: answer.outcome,
		...(reason ? { reason } : {}),
		...(answer.retryAfterSeconds !== undefined && answer.outcome === 'exhausted' ? { retryAfterSeconds: answer.retryAfterSeconds } : {}),
		...(answer.recordsLeft5h !== undefined ? { recordsLeft5h: answer.recordsLeft5h } : {}),
		...(answer.ms !== undefined ? { ms: answer.ms } : {}),
		...hit,
	};
}

const skipped = (tool: MoltSetsTool, reason: string): FlatFee<never> => ({ attempt: { tool, outcome: 'skipped', reason } });

export interface FoundEmail { email: string; riskScore: NonNullable<MoltSetsCallMeta['riskScore']>; lastValidatedAt?: string; linkedinUrl?: string }

const LINKEDIN_PROFILE = /^https:\/\/(www\.)?linkedin\.com\/(in|pub)\//i;

/** A work email from a LinkedIn URL when the row has one, else from a name and company domain. */
export async function moltsetsWorkEmail(client: MoltSetsClient, identity: { name: string; domain: string; profileUrl?: string }): Promise<FlatFee<FoundEmail>> {
	const byProfile = Boolean(identity.profileUrl && LINKEDIN_PROFILE.test(identity.profileUrl));
	const tool: MoltSetsTool = byProfile ? 'linkedin_to_business_email' : 'search_business_email_by_name';
	const answer = await client.call(tool, byProfile ? { linkedin_url: identity.profileUrl } : { name: identity.name, company: identity.domain });
	const results = object(answer.results);
	const email = answer.outcome === 'hit' ? text(results.email) : null;
	if (!email) return { attempt: attemptOf(tool, answer.outcome === 'hit' ? { ...answer, outcome: 'miss' } : answer) };
	const riskScore = riskGrade(results.risk_score);
	const lastValidatedAt = text(results.last_validated_at) ?? undefined;
	const linkedinUrl = text(results.linkedin_url) ?? undefined;
	return { attempt: attemptOf(tool, answer, { riskScore, ...(lastValidatedAt ? { lastValidatedAt } : {}) }), value: { email, riskScore, lastValidatedAt, linkedinUrl } };
}

export interface FoundPhone { phone: string; lastValidatedAt?: string }

const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z]/g, '') === b.toLowerCase().replace(/[^a-z]/g, '');

/** A carrier-verified mobile from a LinkedIn URL. Without one, MoltSets finds the profile from a name and company first,
    and the match must be the only candidate or carry the same name: a wrong person's phone is worse than none. */
export async function moltsetsMobile(client: MoltSetsClient, identity: { name: string; company: string; domain: string; profileUrl?: string }): Promise<FlatFee<FoundPhone>> {
	let linkedin = identity.profileUrl && LINKEDIN_PROFILE.test(identity.profileUrl) ? identity.profileUrl : '';
	if (!linkedin) {
		const company = identity.domain || identity.company;
		if (!identity.name || !company) return skipped('linkedin_to_mobile_phone', 'MoltSets finds a mobile from a LinkedIn URL, or a name and company.');
		const found = await client.call('search_linkedin_profile', { name: identity.name, company });
		const candidates = found.outcome === 'hit' && Array.isArray(found.results) ? found.results.map(object) : [];
		const match = candidates.length === 1 ? candidates[0] : candidates.find((entry) => sameName(text(entry.full_name) ?? '', identity.name));
		linkedin = text(match?.linkedin_url) ?? '';
		if (!linkedin) return { attempt: attemptOf('search_linkedin_profile', found.outcome === 'hit' ? { ...found, outcome: 'miss' } : found) };
	}
	const answer = await client.call('linkedin_to_mobile_phone', { linkedin_url: linkedin });
	const results = object(answer.results);
	const phone = answer.outcome === 'hit' ? text(results.mobile_phone) : null;
	if (!phone) return { attempt: attemptOf('linkedin_to_mobile_phone', answer.outcome === 'hit' ? { ...answer, outcome: 'miss' } : answer) };
	const lastValidatedAt = text(results.last_validated_at) ?? undefined;
	return { attempt: attemptOf('linkedin_to_mobile_phone', answer, lastValidatedAt ? { lastValidatedAt } : {}), value: { phone, lastValidatedAt } };
}

/** The person fields MoltSets can give from a reverse lookup. The other fields stay with looot. */
export type PersonField = 'full_name' | 'title' | 'company' | 'company_domain' | 'linkedin' | 'location' | 'email';

const domainOf = (url: string | null) => { if (!url) return null; try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, ''); } catch { return null; } };

/** One person field from an email (reverse email lookup, or email to LinkedIn for the profile URL) or a LinkedIn URL
    (reverse LinkedIn lookup). A reverse email lookup returns its emails hashed, so the email field comes only from the
    LinkedIn lookup. The two lookups name their fields differently, so each field is read under both names. */
export async function moltsetsPerson(client: MoltSetsClient, input: { email: string; profileUrl: string }, field: string): Promise<FlatFee<string>> {
	const known: readonly string[] = ['full_name', 'title', 'company', 'company_domain', 'linkedin', 'location', 'email'];
	const email = input.email, linkedin = LINKEDIN_PROFILE.test(input.profileUrl) ? input.profileUrl : '';
	if (!known.includes(field)) return skipped(email ? 'reverse_email_lookup' : 'reverse_linkedin_lookup', 'MoltSets does not return this field.');
	if (!email && !linkedin) return skipped('reverse_email_lookup', 'MoltSets looks a person up by email or LinkedIn URL.');
	if (field === 'email' && !linkedin) return skipped('reverse_linkedin_lookup', 'MoltSets returns an email for a person only from a LinkedIn URL.');
	if (email && field === 'linkedin') {
		const answer = await client.call('email_to_linkedin', { email });
		const url = answer.outcome === 'hit' ? text(object(answer.results).linkedin_url) : null;
		return url ? { attempt: attemptOf('email_to_linkedin', answer), value: url } : { attempt: attemptOf('email_to_linkedin', answer.outcome === 'hit' ? { ...answer, outcome: 'miss' } : answer) };
	}
	const useEmail = Boolean(email) && field !== 'email';
	const tool: MoltSetsTool = useEmail ? 'reverse_email_lookup' : 'reverse_linkedin_lookup';
	const answer = await client.call(tool, useEmail ? { email } : { linkedin_url: linkedin });
	const profile = answer.outcome === 'hit' ? object(answer.results) : {};
	const employer = object(profile.company);
	const value = ((): string | null => {
		switch (field as PersonField) {
			case 'full_name': return text(profile.full_name) ?? ([text(profile.first_name), text(profile.last_name)].filter(Boolean).join(' ') || null);
			case 'title': return text(profile.title);
			case 'company': return text(profile.current_company) ?? text(employer.name);
			case 'company_domain': return domainOf(text(profile.current_company_url) ?? text(employer.website_url));
			case 'linkedin': return text(profile.linkedinurl) ?? text(profile.linkedin_url);
			case 'location': return [text(profile.city), text(profile.state), text(profile.country)].filter(Boolean).join(', ') || null;
			case 'email': return text(profile.business_email);
		}
	})();
	return value ? { attempt: attemptOf(tool, answer), value } : { attempt: attemptOf(tool, answer.outcome === 'hit' ? { ...answer, outcome: 'miss' } : answer) };
}
