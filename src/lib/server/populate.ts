import { lookupPerson } from './person-lookup';
import { profileUrl } from '../profile-photo';
import { planPeopleInput, populatePeopleList } from './populate-people-list';
import { companyContextForQuery } from './company-context';
import 'server-only';
import { populateLimitError, promptResultCount } from '../populate-limit';
import { fundingLabel } from '../funding';

import { generateText, isStepCount, type StopCondition, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { foundRowKey, foundRowKeyField } from '../found-rows';
import type { CellValue, FoundRow, PopulateEvent, PopulateRequest } from '../types';
import { companySearch, webSearchCountries } from './context';
import type { ProviderAccess } from './provider-access';
import { createPopulateSearchQueue } from './populate-search-queue';
import { mapConcurrent } from './map-concurrent';
import { classifyFailure } from './enrich-failure';

/* The populate agent: OpenAI plans and paginates Context.dev searches; results stream straight to the sheet.
   The model only sees compact summaries (counts, cursors, a few names), never the full records, so a 1,000-row
   list costs a few thousand tokens of orchestration rather than copying every record through the model. */

const MAX_STEPS = 60;
/** Profile photos are a per-row extra lookup; a few in flight keeps a page of results fast without bursting Context.dev. */
const PHOTO_CONCURRENCY = 4;

export function populateStream(access: ProviderAccess, request: PopulateRequest): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let closed = false;
	const abort = new AbortController();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const emit = (event: PopulateEvent) => {
				if (closed) return;
				controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
			};
			const finish = () => {
				if (closed) return;
				closed = true;
				controller.close();
			};
			runPopulate(access, request, emit, abort.signal)
				.catch((error) => {
					if (!abort.signal.aborted) emit({ type: 'error', message: access.redact(error), failure: classifyFailure(error) });
				})
				.finally(finish);
		},
		// The client cancelled the stream: stop the agent so no further searches are billed.
		cancel() {
			closed = true;
			abort.abort();
		},
	});
}

async function runPopulate(access: ProviderAccess, request: PopulateRequest, emit: (event: PopulateEvent) => void, signal: AbortSignal) {
	const requestedTarget = promptResultCount(request.query) ?? request.target;
	const limitError = populateLimitError(requestedTarget);
	if (limitError) throw new Error(limitError);
	request = { ...request, target: Math.min(requestedTarget, request.availableRows ?? 100) };
	const model = access.openai();
	if (request.entity === 'people') {
		emit({ type: 'status', message: 'Checking for a supplied list of people…' });
		const plan = await planPeopleInput(access, request.query, signal);
		if (plan.mode === 'list') {
			if (plan.people.length > 100) throw new Error('Only 100 at a time. Provide 100 or fewer people.');
			await populatePeopleList(access, request, plan.people, emit, signal);
			return;
		}
	}
	const companyContext = await companyContextForQuery(access, request.query);
	const client = access.context();
	const seen = new Set((request.existingKeys ?? []).map(foundRowKey).filter(Boolean));
	const state = { added: 0, emptyStreak: 0, calls: 0 };
	const target = request.target;
	const countries = request.countries?.length ? request.countries.map((c) => c.toUpperCase()) : undefined;
	const searchInOrder = createPopulateSearchQueue(signal);

	const push = (rows: FoundRow[]) => {
		const accepted = rows.slice(0, Math.max(0, target - state.added));
		if (accepted.length) {
			state.added += accepted.length;
			emit({ type: 'rows', rows: accepted, key: foundRowKeyField(request.entity) });
		}
		return accepted;
	};
	const summarise = (added: number, names: string[], nextCursor: string | null, total: number) => {
		state.calls += 1;
		state.emptyStreak = added === 0 ? state.emptyStreak + 1 : 0;
		emit({ type: 'status', message: added ? `Added ${added} (${state.added} of ${target})` : `No new results (${state.added} of ${target})` });
		return { added_this_call: added, returned_this_call: total, total_added: state.added, target, remaining: Math.max(0, target - state.added), next_cursor: nextCursor, sample: names.slice(0, 5), hint: nextCursor ? 'Call again with next_cursor to continue this query.' : 'This query is exhausted; try a different angle.' };
	};

	const tools: ToolSet = {};
	if (request.entity === 'companies') {
		tools.searchCompanies = tool({
			description: 'Find companies matching a plain-language description. Results are added to the sheet automatically. Pass next_cursor from a previous call to get the next page of the same query (keep query and filters identical).',
			inputSchema: z.object({
				query: z.string().max(400).describe('What kind of companies: industry, location, size, business model. Natural language.'),
				employees_min: z.number().int().min(0).optional(),
				employees_max: z.number().int().min(0).optional(),
				cursor: z.string().max(64).optional().describe('next_cursor from the previous call of the same query'),
			}),
			execute: async ({ query, employees_min, employees_max, cursor }) => searchInOrder(async () => {
				if (state.added >= target) return summarise(0, [], null, 0);
				const result = await companySearch(client, { query, filters: { countries, employees_min, employees_max }, cursor });
				const rows: FoundRow[] = [];
				for (const hit of result.results) {
					const key = foundRowKey(hit.domain || hit.name);
					if (!key || seen.has(key)) continue;
					seen.add(key);
					rows.push(companyRow(hit));
				}
				const accepted = push(rows);
				return summarise(accepted.length, accepted.map((row) => String(row.Company ?? '')), result.next_cursor, result.results.length);
			}),
		});
	}
	if (request.entity === 'people') {
		tools.searchPeople = tool({
			description: 'Find people matching a description of role, employer, industry, location, skills, or background. Results are added to the sheet automatically. Pass next_cursor to continue the same query.',
			inputSchema: z.object({
				query: z.string().max(2000),
				mode: z.enum(['fast', 'ultra']).default('fast').describe('ultra judges each candidate against every criterion; slower and 5x the cost. Use it only for multi-criteria queries.'),
				years_of_experience_min: z.number().int().min(0).optional(),
				years_of_experience_max: z.number().int().min(0).optional(),
				cursor: z.string().optional(),
			}),
			execute: async ({ query, mode, years_of_experience_min, years_of_experience_max, cursor }) => searchInOrder(async () => {
				if (state.added >= target) return summarise(0, [], null, 0);
				const response = await client.people.search({ query, mode, filters: { countries, years_of_experience_min, years_of_experience_max }, cursor }, { signal });
				const hits: Array<{ hit: (typeof response.results)[number]; linkedin?: string }> = [];
				for (const hit of response.results) {
					if (hits.length >= target - state.added) break;
					const linkedin = hit.profiles.find((url) => url.includes('linkedin.com')) ?? hit.profiles[0];
					const key = foundRowKey(linkedin || `${hit.name}|${hit.role.company?.name ?? ''}`);
					if (!key || seen.has(key)) continue;
					seen.add(key);
					hits.push({ hit, linkedin });
				}
				const photo = async (hit: (typeof response.results)[number]) => {
					const profiles = hit.profiles.flatMap((url) => { const safe = profileUrl(url); return safe ? [safe] : []; });
					if (!profiles.length) return null;
					try {
						const enriched = await lookupPerson(client, { social_urls: profiles, timeoutOpts: { milliseconds: 60_000, behavior: 'return-partial' } }, hit.name ?? '', { signal });
						return enriched.match.status === 'candidate' ? profileUrl(enriched.match.person?.avatar_url) : null;
					} catch { signal.throwIfAborted(); return null; /* Keep the search result if photo enrichment is unavailable. */ }
				};
				const rows: FoundRow[] = await mapConcurrent(hits, PHOTO_CONCURRENCY, async ({ hit, linkedin }) => ({
					Name: hit.name,
					'Profile photo': await photo(hit),
					Title: hit.role.title,
					Company: hit.role.company?.name ?? null,
					'Company domain': hit.role.company?.domain ?? null,
					Location: [hit.location.city, hit.location.region, hit.location.country_code].filter(Boolean).join(', ') || null,
					LinkedIn: linkedin ?? null,
					Schools: hit.schools,
					Skills: hit.skills.slice(0, 15),
					'Years of experience': hit.years_of_experience,
					Summary: hit.description,
				}));
				const accepted = push(rows);
				return summarise(accepted.length, accepted.map((row) => String(row.Name ?? '')), response.next_cursor ?? null, response.results.length);
			}),
		});
	}
	if (request.entity === 'websites') {
		tools.searchWeb = tool({
			description: 'Search the web. Each result page becomes a row (URL, title, description). Vary the query to find more.',
			inputSchema: z.object({ query: z.string().max(400), numResults: z.number().int().min(1).max(50).default(20), includeDomains: z.array(z.string()).max(20).optional(), excludeDomains: z.array(z.string()).max(20).optional() }),
			execute: async ({ query, numResults, includeDomains }) => searchInOrder(async () => {
				if (state.added >= target) return summarise(0, [], null, 0);
				const result = await webSearchCountries(client, query, countries, { numResults: Math.min(numResults, target - state.added), includeDomains }, signal);
				const rows: FoundRow[] = [];
				for (const hit of result.results) {
					const key = foundRowKey(hit.url);
					if (!key || seen.has(key)) continue;
					seen.add(key);
					rows.push({ URL: hit.url, Title: hit.title, Description: hit.description });
				}
				const accepted = push(rows);
				return summarise(accepted.length, accepted.map((row) => String(row.Title ?? '')), null, result.results.length);
			}),
		});
	}

	const reachedTarget: StopCondition<ToolSet> = () => state.added >= target;
	const stalled: StopCondition<ToolSet> = () => state.emptyStreak >= 4;

	emit({ type: 'status', message: `Searching for ${request.entity}…` });
	const entityGuide = {
		companies: 'Write queries the way a market analyst would describe the segment (industry + geography + size + business model). To reach large targets, split the market into sub-segments (sub-industries, states or regions, company sizes, customer types) and run each as its own query; always follow next_cursor until it is null before moving on.',
		people: 'Describe the role, seniority, employer type, industry, location and background. Split large targets by geography, seniority, or employer segment. Use fast mode unless the query has several hard criteria.',
		websites: 'Use many distinct search phrasings, site: operators for directories, and synonyms. Each query returns at most 50 results, so vary queries to reach the target.',
	}[request.entity];
	const result = await generateText({
		model,
		system: [
			`You populate a spreadsheet with ${request.entity}. Goal: find up to ${target} ${request.entity} matching the request. The search tool adds matches to the sheet by itself; you only plan and run queries.`,
			entityGuide,
			`Rules: keep calling tools until total_added reaches the target, next_cursor is null for every reasonable query, or four consecutive calls add nothing. Do not repeat a query that returned nothing new. Do not write out the results; when finished, reply with one short sentence summarising what you found.`,
			countries ? (request.entity === 'websites' ? `Web searches are localized to ${countries.join(', ')}; localization is not a strict website headquarters filter.` : `Hard filter already applied: headquarters/location in ${countries.join(', ')}.`) : '',
		]
			.filter(Boolean)
			.join('\n'),
		prompt: `Request: ${request.query}${companyContext}\nTarget: ${target} ${request.entity}.${seen.size ? ` The sheet already has ${seen.size} rows; duplicates are skipped automatically.` : ''}`,
		tools,
		stopWhen: [isStepCount(MAX_STEPS), reachedTarget, stalled],
		// Each step is billed once processed; the transport resends a rate-limited request (see `openaiModel`).
		maxRetries: 0,
		abortSignal: signal,
	});
	const summary = result.text?.trim();
	emit({ type: 'done', total: state.added, message: summary && summary.length < 400 ? summary : undefined });
}

function companyRow(hit: Awaited<ReturnType<typeof companySearch>>['results'][number]): FoundRow {
	const hq = [hit.headquarters?.city, hit.headquarters?.region, hit.headquarters?.country_code].filter(Boolean).join(', ');
	const employees: CellValue = hit.employees?.count ?? hit.employees?.max ?? hit.employees?.min ?? null;
	return {
		Company: hit.name,
		Domain: hit.domain,
		Description: hit.description ?? null,
		Industry: hit.industries?.length ? hit.industries.slice(0, 3).join(', ') : null,
		Headquarters: hq || null,
		Employees: employees,
		Founded: hit.founded_year ?? null,
		Funding: hit.funding?.total_usd ?? null,
		Stage: fundingLabel(hit.funding?.stage ?? hit.funding?.latest_round?.type),
	};
}
