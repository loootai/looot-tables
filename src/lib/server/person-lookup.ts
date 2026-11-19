import 'server-only';
import type ContextDev from 'context.dev';
import type { PersonEnrichParams, PersonEnrichResponse } from 'context.dev/resources/people';
import { profileUrl } from '../profile-photo';

const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** Search only after a missing name match; never substitute an ambiguous namesake. */
export async function lookupPerson(client: ContextDev, params: PersonEnrichParams | null, name: string, options: { signal?: AbortSignal } = {}): Promise<PersonEnrichResponse> {
	const enrich = (input: PersonEnrichParams) => client.people.enrich(input, { signal: options.signal });
	const initial = params ? await enrich(params) : undefined;
	if (initial?.match.status === 'candidate' || params?.email || params?.social_urls?.length || !name.trim()) return initial ?? { request_id: '', match: { status: 'not_found', person: null, score: null } };
	const search = await client.people.search({ query: `Find this specific person, not similar people: ${JSON.stringify({ name, company: params?.company, location: params?.location, education: params?.education })}`, mode: 'fast' }, { signal: options.signal });
	const candidates = search.results.filter((hit) => {
		if (!hit.name || normalize(hit.name) !== normalize(name)) return false;
		if (params?.company?.domain && normalize(hit.role.company?.domain ?? '') !== normalize(params.company.domain)) return false;
		if (params?.company?.name && normalize(hit.role.company?.name ?? '') !== normalize(params.company.name)) return false;
		return hit.profiles.some((url) => profileUrl(url));
	});
	if (candidates.length !== 1) return initial ?? { request_id: search.request_id, match: { status: 'not_found', person: null, score: null } };
	const urls = candidates[0].profiles.flatMap((url) => { const safe = profileUrl(url); return safe ? [safe] : []; });
	return enrich({ ...params, social_urls: urls, timeoutOpts: { milliseconds: 60_000, behavior: 'return-partial' } });
}
