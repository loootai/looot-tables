import 'server-only';
import type { z } from 'zod';
import { foundRowColumns, foundRowKey } from '../found-rows';
import { logoDomain } from '../organization-logo';
import type { EntityKind, FoundRow } from '../types';
import { WorkspaceError } from '../workspace';
import { opHash } from './column-runs';
import { EnrichError, Spend } from './enrich-failure';
import { parsePriceUsd } from './looot-catalog';
import { companySearch, peopleSearch } from './looot-jobs';
import { companyRow, personRow } from './populate';
import type { SheetTools } from './sheet-tools';
import type { SHEET_TOOLS } from './tool-specs';

/* Find rows with a budget, for agents. The calling agent is the planner, so this is a plain search with filters, not the
   browser's populate agent: companies through company.search, people through people.search at each employer's domain.
   quote_find_rows prices the searches (free); find_rows runs them inside maxUsd, held against the sheet's spend cap. */

/** company.search answers about this many companies per page. */
const COMPANIES_PER_PAGE = 25;
/** What one search is assumed to cost when the catalog names no price. */
const FALLBACK_SEARCH_USD = 0.02;
const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

type QuoteArgs = z.infer<typeof SHEET_TOOLS.quote_find_rows.schema>;
type FindRequest = QuoteArgs & { domains: string[] };

/** The most one run of a job can cost: every provider of its fallback route, from the free catalog. */
async function routeMaxUsd(tools: SheetTools, job: string): Promise<number> {
	try {
		const { endpoints } = await tools.providerAccess.looot().search(job, 10, { capability: job });
		const prices = endpoints.filter((hit) => (hit.access === undefined || hit.access === 'runs_now') && (hit.job?.id ?? hit.capability) === job).map((hit) => parsePriceUsd(hit.estimatedPrice) ?? 0);
		return prices.length ? round(prices.reduce((sum, price) => sum + price, 0)) : FALLBACK_SEARCH_USD;
	} catch (error) {
		if (error instanceof EnrichError && error.failure.reason === 'credential_invalid') throw error;
		return FALLBACK_SEARCH_USD;
	}
}

const label = (entity: EntityKind, limit: number, maxUsd: number) => `Find up to ${limit} ${entity === 'people' ? (limit === 1 ? 'person' : 'people') : limit === 1 ? 'company' : 'companies'} · up to $${maxUsd < 0.01 ? maxUsd.toFixed(4) : maxUsd.toFixed(2)}`;

export async function quoteFindRows(tools: SheetTools, args: QuoteArgs) {
	tools.providerAccess.requireKey('looot');
	const { sheet, rows } = await tools.readSnapshot(args.sheetId);
	let domains = (args.domains ?? []).map((domain) => logoDomain(domain)).filter((domain): domain is string => Boolean(domain));
	if (args.domainColumnId) {
		const column = sheet.columns.find((entry) => entry.id === args.domainColumnId);
		if (!column) throw new WorkspaceError(`No column with id ${args.domainColumnId}.`, 404);
		domains = [...domains, ...rows.flatMap((row) => { const domain = logoDomain(String(row.cells[column.id]?.v ?? '')); return domain ? [domain] : []; })];
	}
	domains = [...new Set(domains)].slice(0, 25);
	if (args.entity === 'companies' && !args.query?.trim()) throw new WorkspaceError('Describe the companies in query, for example “B2B SaaS selling to finance teams”.', 400);
	if (args.entity === 'people' && !domains.length && !args.query?.trim()) throw new WorkspaceError('Give the employers: domains, a domainColumnId, or a query describing the companies.', 400);
	const companyUsd = args.entity === 'companies' || !domains.length ? await routeMaxUsd(tools, 'company.search') : 0;
	const peopleUsd = args.entity === 'people' ? await routeMaxUsd(tools, 'people.search') : 0;
	const companySearches = args.entity === 'companies' ? Math.ceil(args.limit / COMPANIES_PER_PAGE) : domains.length ? 0 : 1;
	const peopleSearches = args.entity === 'people' ? (domains.length || Math.min(args.limit, COMPANIES_PER_PAGE)) : 0;
	const maxUsd = round(companySearches * companyUsd + peopleSearches * peopleUsd);
	const request: FindRequest = { ...args, domains };
	const quote = await tools.ledger.saveQuote({ kind: 'find', sheetId: args.sheetId, columnId: null, request, opHash: opHash(request), cells: args.limit, perCellUsd: 0, maxUsd });
	const text = label(args.entity, args.limit, maxUsd);
	return {
		quoteId: quote.id, sheetId: args.sheetId, entity: args.entity, rowsUpTo: args.limit, searches: companySearches + peopleSearches, maxUsd, label: text,
		...(domains.length ? { domains } : {}), expiresAt: new Date(quote.expiresAt).toISOString(),
		next: `Show the user “${text}”. After they agree, call find_rows with this quoteId, maxUsd at most what they approved, and a fresh idempotencyKey.`,
	};
}

export async function runFindRows(tools: SheetTools, args: z.infer<typeof SHEET_TOOLS.find_rows.schema>) {
	const quote = await tools.ledger.quote(args.quoteId);
	if (quote.kind !== 'find') throw new WorkspaceError('This quote is for a column: run it with run_column.', 400);
	if (args.maxUsd <= 0) throw new WorkspaceError('Finding rows spends looot credit: pass the maxUsd the user approved.', 400);
	const guard = tools.spendGuard;
	if (!guard) throw new WorkspaceError('The spend guard is not available here, so nothing was run.', 503);
	const request = quote.request as FindRequest;
	const { run, started } = await tools.ledger.start(quote, args.idempotencyKey, args.maxUsd, request.limit);
	if (!started) return { runId: run.id, status: run.status, replayed: true, ...(run.result ?? {}), next: 'This idempotency key already ran. Use a new key to search again.' };
	try { await guard.admit({ sheetId: quote.sheetId, rowId: '*find', columnId: '*find' }, run.id, args.maxUsd); }
	catch (error) {
		const message = error instanceof EnrichError ? error.message : 'The spend guard refused this search.';
		await tools.ledger.finish(run.id, 'cancelled', 0, 0, { message });
		throw new WorkspaceError(message, 402);
	}
	const spend = new Spend();
	const client = tools.providerAccess.withSpend(spend, run.id, args.maxUsd).looot();
	const current = await tools.readSnapshot(quote.sheetId);
	const keyColumn = foundRowColumns(request.entity, current.sheet.columns).key;
	const existing = new Set(keyColumn ? current.rows.map((row) => foundRowKey(row.cells[keyColumn.id]?.v)).filter(Boolean) : []);
	const found: FoundRow[] = [];
	let stopped: string | undefined, searches = 0;
	const add = (row: FoundRow, key: string) => {
		const normalized = foundRowKey(key);
		if (!normalized || existing.has(normalized) || found.length >= request.limit) return;
		existing.add(normalized);
		found.push(row);
	};
	try {
		let domains = request.domains;
		if (request.entity === 'companies' || !domains.length) {
			for (let cursor: string | null | undefined = undefined, page = 0; found.length < request.limit && page < Math.ceil(request.limit / COMPANIES_PER_PAGE) + 1; page++) {
				const result = await companySearch(client, { query: request.query ?? '', filters: { countries: request.countries, employees_min: request.employeesMin, employees_max: request.employeesMax }, cursor: cursor ?? undefined });
				searches++;
				if (request.entity === 'companies') for (const hit of result.results) add(companyRow(hit), hit.domain || hit.name);
				else domains = result.results.flatMap((hit) => hit.domain ? [hit.domain] : []).slice(0, Math.min(request.limit, COMPANIES_PER_PAGE));
				cursor = result.next_cursor;
				if (!cursor || request.entity === 'people') break;
			}
		}
		if (request.entity === 'people') for (const domain of domains) {
			if (found.length >= request.limit) break;
			const result = await peopleSearch(client, { jobTitle: request.jobTitle, domain, location: request.location, limit: Math.min(10, request.limit - found.length) });
			searches++;
			for (const hit of result.results) add(personRow(hit, { domain }), hit.linkedin || `${hit.name}|${hit.company ?? domain}`);
		}
	} catch (error) {
		if (!(error instanceof EnrichError)) throw error;
		stopped = error.failure.reason === 'spend_capped' ? `Stopped at the budget of $${args.maxUsd}.` : error.message;
	} finally {
		await guard.settle(run.id, { chargedUsd: spend.costUsd, verdicts: [] });
	}
	const added = await tools.appendFound(quote.sheetId, request.entity, found);
	const result = { added: added.rows, newColumns: added.columns, searches, spentUsd: round(spend.costUsd), sample: found.slice(0, 5).map((row) => String(row.Name ?? row.Company ?? '')), ...(stopped ? { stopped } : {}) };
	const finished = await tools.ledger.finish(run.id, 'finished', added.rows, spend.costUsd, result);
	return { runId: finished.id, status: finished.status, ...result, next: added.rows ? 'Rows added. Read them with query_rows; add email and phone columns with add_contact_columns.' : 'Nothing new was found. Try a broader query, other titles or more companies.' };
}
