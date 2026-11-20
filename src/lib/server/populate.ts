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
import { companySearch, peopleSearch, webSearchCountries, type CompanyHit, type PersonHit } from './looot-jobs';
import type { ProviderAccess } from './provider-access';
import { createPopulateSearchQueue } from './populate-search-queue';
import { classifyFailure } from './enrich-failure';

/* The populate agent: OpenAI plans and paginates looot searches; results stream straight to the sheet.
   The model only sees compact summaries (counts, cursors, a few names), never the full records, so a 1,000-row
   list costs a few thousand tokens of orchestration rather than copying every record through the model. */

const MAX_STEPS = 60;

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
	const client = access.looot();
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
				const result = await companySearch(client, { query, filters: { countries, employees_min, employees_max }, cursor }, signal);
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
		tools.findCompanies = tool({
			description: 'Find companies matching a description (industry, location, size, stage). Nothing is added to the sheet: use it to get company domains, then call searchPeople for each domain. Pass next_cursor for the next page of the same query.',
			inputSchema: z.object({ query: z.string().max(400), cursor: z.string().max(64).optional() }),
			execute: async ({ query, cursor }) => searchInOrder(async () => {
				const result = await companySearch(client, { query, filters: { countries }, cursor }, signal);
				state.calls += 1;
				emit({ type: 'status', message: `Found ${result.results.length} companies for "${query.slice(0, 60)}"` });
				return { companies: result.results.slice(0, 25).map((hit) => ({ name: hit.name, domain: hit.domain, description: hit.description?.slice(0, 140), employees: hit.employees?.count ?? hit.employees?.max, stage: hit.funding?.stage, headquarters: hit.headquarters })), next_cursor: result.next_cursor };
			}),
		});
		tools.searchPeople = tool({
			description: 'Find people at one company by job title. Pass the company domain (best) or name. Matches are added to the sheet automatically; only people whose title fits job_title are kept. Pass next_cursor for the next page of the same query.',
			inputSchema: z.object({
				job_title: z.string().max(120).optional().describe('The role, for example "VP of Sales". Titles are matched on every word, with VP read as Vice President.'),
				domain: z.string().max(253).optional().describe('The company website domain, for example acme.com.'),
				company: z.string().max(200).optional(),
				location: z.string().max(120).optional(),
				limit: z.number().int().min(1).max(50).default(10),
				cursor: z.string().optional(),
			}),
			execute: async ({ job_title, domain, company, location, limit, cursor }) => searchInOrder(async () => {
				if (state.added >= target) return summarise(0, [], null, 0);
				if (!domain && !company && !job_title) return { error: 'Pass a domain, a company or a job_title.' };
				const response = await peopleSearch(client, { jobTitle: job_title, domain, company, location, limit, cursor }, signal);
				const rows: FoundRow[] = [];
				for (const hit of response.results) {
					if (rows.length >= target - state.added) break;
					const key = foundRowKey(hit.linkedin || `${hit.name}|${hit.company ?? ''}`);
					if (!key || seen.has(key)) continue;
					seen.add(key);
					rows.push(personRow(hit, { company, domain }));
				}
				const accepted = push(rows);
				return { ...summarise(accepted.length, accepted.map((row) => String(row.Name ?? '')), response.next_cursor, response.returned), title_matches: response.results.length };
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
		people: 'People are found per company. Call findCompanies for the employer segment (industry, place, funding stage), then call searchPeople with each company domain and the requested job_title, one company at a time, until the target is reached. Use the next page of findCompanies for more employers.',
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

/** One found person as a row: their employer falls back to the company the search was for. */
export function personRow(hit: PersonHit, searched: { company?: string; domain?: string } = {}): FoundRow {
	return {
		Name: hit.name,
		'Profile photo': profileUrl(hit.avatarUrl),
		Title: hit.title,
		Company: hit.company ?? searched.company ?? null,
		'Company domain': hit.companyDomain ?? (searched.domain ? searched.domain.replace(/^www\./, '') : null),
		Location: hit.location,
		LinkedIn: hit.linkedin,
		Schools: hit.schools,
		Skills: hit.skills.slice(0, 15),
		'Years of experience': hit.yearsOfExperience,
		Summary: hit.bio,
	};
}

/** One found company as a row. */
export function companyRow(hit: CompanyHit): FoundRow {
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
