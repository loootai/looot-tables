import type { DateFormat } from './date-format';
import { z } from 'zod';

/* ───────────────────────────── Column operations ─────────────────────────────
   Every enriched column carries one operation. The same zod schemas validate the
   editor on the client and the request body on the server. */

export const OUTPUT_TYPES = ['text', 'document', 'number', 'boolean', 'url', 'date', 'list'] as const;
export const COLUMN_FORMATS = [...OUTPUT_TYPES, 'currency', 'percent', 'unit', 'year', 'checkbox', 'website', 'webpage', 'email-draft', 'email', 'category'] as const;
export type ColumnFormat = (typeof COLUMN_FORMATS)[number];
export type OutputType = (typeof OUTPUT_TYPES)[number];

/** Where a page-reading operation gets its page from. */
export const PageSourceSchema = z.discriminatedUnion('type', [
	/** A column that already holds a URL (or a domain). */
	z.object({ type: z.literal('column'), column: z.string().min(1) }),
	/** The homepage of a domain column. */
	z.object({ type: z.literal('homepage'), column: z.string().min(1) }),
	/** Find a specific page on the site (pricing, careers, about…) by guessing paths and mapping the site. */
	z.object({ type: z.literal('find'), column: z.string().min(1), page: z.string().min(1).max(60) }),
	/** A URL template such as https://{{Domain}}/pricing */
	z.object({ type: z.literal('template'), template: z.string().min(1).max(500) }),
]);
export type PageSource = z.infer<typeof PageSourceSchema>;

export const DECIDERS = ['jev', 'openai'] as const;
export type Decider = (typeof DECIDERS)[number];

const deciderField = z.enum(DECIDERS).default('jev');
const pageField = PageSourceSchema.optional();

export const EmailDraftSchema = z.object({
 to: z.string(), cc: z.string(), bcc: z.string(), subject: z.string(), body: z.string(),
});
export type EmailDraft = z.infer<typeof EmailDraftSchema>;

/** How looot orders the providers of a job: the cheapest first, the most reliable first, or a mix of both. */
export const EMAIL_PREFERENCES = ['balanced', 'cheapest', 'reliable', 'fastest'] as const;
export type EmailPreference = typeof EMAIL_PREFERENCES[number];
export const ColumnOpSchema = z.discriminatedUnion('kind', [
 z.object({
  kind: z.literal('email-enrichment'),
  name: z.string().trim().min(1).max(300),
  company: z.string().max(300).default(''),
  domain: z.string().trim().min(1).max(500),
  profileUrl: z.string().max(500).default(''),
  /** looot's job:people.email.find walks its providers in this order until one finds an email. */
  prefer: z.enum(EMAIL_PREFERENCES).default('balanced'),
  /** Check the found address with job:people.email.verify in the same cell. New columns turn it on. */
  verify: z.boolean().optional(),
 }),
 z.object({
  kind: z.literal('email-verify'),
  email: z.string().trim().min(1).max(300),
  prefer: z.enum(EMAIL_PREFERENCES).default('balanced'),
 }),
 z.object({
  kind: z.literal('phone-find'),
  name: z.string().max(300).default(''),
  company: z.string().max(300).default(''),
  domain: z.string().max(500).default(''),
  profileUrl: z.string().max(500).default(''),
  prefer: z.enum(EMAIL_PREFERENCES).default('balanced'),
 }).refine((op) => Boolean(op.profileUrl.trim() || op.name.trim()), { message: 'Provide a LinkedIn URL, or a name and company.' }),
 /** Any looot endpoint: a catalog endpoint with its inputs mapped from `{{Column}}` templates. */
 z.object({
  kind: z.literal('looot'),
  endpointId: z.string().trim().min(1).max(200),
  /** Endpoint input name -> template. A template that is only `{{Column}}` passes that cell's value as it is. */
  inputs: z.record(z.string().min(1).max(100), z.string().max(2000)).default({}),
  /** The JSON type each input declares (string, number, array...), read from the endpoint when the column was set up. */
  inputTypes: z.record(z.string().min(1).max(100), z.string().max(40)).default({}),
  /** The endpoint's estimated price per row in USD at setup, so a run can show its cost before it starts. */
  unitCostUsd: z.number().min(0).max(1000).nullable().default(null),
  /** Dotted path into the run's `normalized.fields` or `result` to keep, or empty for the whole answer. */
  path: z.string().max(200).default(''),
  /** The job's provider order. Only used when the endpoint is a job (job:<id>). */
  prefer: z.enum(EMAIL_PREFERENCES).default('balanced'),
 }),
 z.object({
  kind: z.literal('email-draft'),
  mode: z.enum(['ai', 'template']).default('ai'),
  prompt: z.string().max(4000).default('Draft a personalized email using this row.'),
  to: z.string().max(2000).default(''),
  cc: z.string().max(2000).default(''),
  bcc: z.string().max(2000).default(''),
  subject: z.string().max(2000).default(''),
  body: z.string().max(20000).default(''),
 }),
	/** OpenAI answers a question about the row; optionally researching the web through looot first. */
	z.object({
		kind: z.literal('ai'),
		prompt: z.string().min(1).max(4000),
		output: z.enum(OUTPUT_TYPES).default('text'),
		research: z.enum(['none', 'web']).default('web'),
		page: pageField,
	}),
	/** A true/false question decided by TypeSafe Jev (calibrated probability) or OpenAI, optionally after reading a page. */
	z.object({
		kind: z.literal('check'),
		question: z.string().min(1).max(2000),
		page: pageField,
		decider: deciderField,
		/** Probability above which the answer counts as true. */
		threshold: z.number().min(0.05).max(0.95).default(0.5),
		/** Exact-text mode: the answer is true when the page contains this text (case-insensitive). No model needed. */
		literal: z.string().max(200).optional(),
	}),
	/** Pick one option from a list (Jev choice). */
	z.object({
		kind: z.literal('classify'),
		question: z.string().min(1).max(2000),
		options: z.array(z.object({ label: z.string().min(1).max(80), description: z.string().max(300).optional() })).min(2).max(20),
		page: pageField,
		decider: deciderField,
	}),
	/** Rate on an ordered rubric (Jev score). */
	z.object({
		kind: z.literal('score'),
		question: z.string().min(1).max(2000),
		levels: z.array(z.string().min(1).max(120)).min(2).max(10),
		page: pageField,
		decider: deciderField,
	}),
	/** Read a page through looot and keep its text, relevant passages, or extracted fields. */
	z.object({
		kind: z.literal('scrape'),
		page: PageSourceSchema,
		mode: z.enum(['markdown', 'highlights', 'extract', 'title', 'url', 'links', 'map', 'html', 'images', 'emails', 'phone-numbers']).default('highlights'),
		query: z.string().max(500).optional(),
		fields: z.array(z.object({ name: z.string().min(1).max(60), description: z.string().max(300).optional() })).max(20).optional(),
		maxChars: z.number().int().min(100).max(20000).default(2000),
	}),
	/** Web search through looot; keep the first URL, title, snippet or a list. */
	z.object({
		kind: z.literal('search'),
		query: z.string().min(1).max(500),
		pick: z.enum(['url', 'title', 'snippet', 'list']).default('url'),
		numResults: z.number().int().min(1).max(10).default(3),
		includeDomains: z.array(z.string()).max(20).optional(),
	}),
	/** Company facts from looot's company.enrich and company.search jobs. */
	z.object({
		kind: z.literal('company'),
		domain: z.string().min(1).max(500),
		field: z.enum(['description', 'title', 'slogan', 'industry', 'employees', 'city', 'country', 'address', 'email', 'phone', 'ticker', 'linkedin', 'twitter', 'pricing_url', 'careers_url', 'blog_url', 'contact_url', 'logo_url', 'primary_color', 'language', 'funding_total', 'funding_stage', 'funding_latest_round', 'funding_latest_date', 'funding_latest_amount', 'funding_round_count']),
	}),
	/** Person facts from looot's people.enrich and linkedin.person.profile jobs. */
	z.object({
		kind: z.literal('person'),
		name: z.string().max(300).optional(),
		company: z.string().max(300).optional(),
		email: z.string().max(300).optional(),
		profileUrl: z.string().max(500).optional(),
		field: z.enum(['title', 'company', 'company_domain', 'location', 'bio', 'linkedin', 'email', 'skills', 'schools', 'degrees', 'experience', 'years_at_company', 'full_name']),
	}),
	/** Deep research: OpenAI searches the web and reads pages through looot, with a larger step budget. */
	z.object({
		kind: z.literal('answer'),
		task: z.string().min(1).max(4000),
		output: z.enum(OUTPUT_TYPES).default('text'),
		mode: z.enum(['fast', 'ultra']).default('fast'),
	}),
	/** A plain template over other columns; no network. */
	z.object({ kind: z.literal('template'), template: z.string().min(1).max(2000) }),
]);
export type ColumnOp = z.infer<typeof ColumnOpSchema>;
export type OpKind = ColumnOp['kind'];

/* ───────────────────────────── Sheet data model ───────────────────────────── */

export type ColumnType = 'source' | 'enriched';

export interface Column {
	id: string;
	name: string;
	type: ColumnType;
	op?: ColumnOp;
	width: number;
	hidden?: boolean;
	/** Column-wide value display and input format. */
	format?: ColumnFormat;
	/** Allowed values for a single-choice Category column. */
	categoryOptions?: string[];
	/** Background colors keyed by category label. */
	categoryColors?: Record<string, string>;
	currency?: string;
	unit?: string;
	useGrouping?: boolean;
	decimalPlaces?: number;
	dateFormat?: DateFormat;
	createdAt: number;
}

export type CellStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';
export type CellValue = string | number | boolean | null | string[];

/** One looot run, kept on the cell so the panel can show who answered and what it cost. */
export interface LoootCallMeta {
	runId: string;
	/** The job id (people.email.find) when the run was a job. */
	job?: string;
	/** The endpoint that answered, or the endpoint that was asked for. */
	endpointId?: string;
	/** The provider that answered. */
	provider?: string;
	outcome: 'hit' | 'weak' | 'miss' | 'error' | 'rejected' | 'skipped' | 'pending';
	costUsd: number;
	/** The providers a fallback route tried, in order, with what each cost and how long it took. */
	attempts?: Array<{ provider: string; endpointId?: string; outcome: string; costUsd: number; ms?: number; reason?: string }>;
	/** How many providers the route skipped without calling. */
	skipped?: number;
	/** The route hit its maxCostUsd before a provider answered. */
	capped?: boolean;
	/** looot's own field map for the job (`normalized.fields`), kept so sibling columns can be unpacked at $0. */
	normalized?: Record<string, unknown>;
	/** Priced follow-up jobs looot suggested after a hit. They never run without a click. */
	nextSteps?: NextStep[];
}

/** A follow-up job looot suggested after a hit: what it does, its price for this row's input, and the input it would use. */
export interface NextStep {
	suggestionId?: string;
	job: string;
	title: string;
	priceUsd: number | null;
	input: Record<string, unknown>;
}

export interface CellMeta {
	inputFingerprint?: string;
	/** Photo returned for this exact person name by enrichment. */
	person?: { name: string; avatarUrl: string | null };
	/** Full result retained from an already completed company lookup. Previewing never refetches it. */
	companyIntel?: { domain: string; input?: string; source: 'brand' | 'company-search'; data: Record<string, unknown> };
	/** Explicit company selected while editing; kept with its name to prevent stale logos. */
	organization?: { name: string; domain: string };
	sources?: string[];
	/** 0–1 probability (check) or confidence (classify/score). */
	probability?: number;
	confidence?: number;
	probabilities?: Record<string, number>;
	reasoning?: string;
	model?: string;
	/** What this cell's looot runs cost in USD. */
	costUsd?: number;
	/** The looot runs behind this cell, in order: which provider answered, the outcome, the price and any fallback attempts. */
	looot?: LoootCallMeta[];
	/** The email status a verify column keeps next to its value: valid, invalid, catch_all, risky or unknown. */
	verification?: string;
	durationMs?: number;
	pageUrl?: string;
	raw?: unknown;
}

export interface Cell {
	v: CellValue;
	/** Spreadsheet expression, including its leading '='. v is the cached result. */
	f?: string;
	s: CellStatus;
	e?: string;
	m?: CellMeta;
	/** Who is running it: a browser tab or an MCP request (see `startCell`). Only running cells carry one. */
	owner?: string;
	t: number;
}

export interface Row {
	id: string;
	sheetId: string;
	order: number;
	cells: Record<string, Cell>;
	createdAt: number;
}

export type FilterOp = 'contains' | 'not_contains' | 'equals' | 'not_equals' | 'empty' | 'not_empty' | 'true' | 'false' | 'gt' | 'lt' | 'error';
export interface Filter {
	id: string;
	columnId: string;
	op: FilterOp;
	value?: string;
}
export interface Sort {
	columnId: string;
	dir: 'asc' | 'desc';
}

export interface Sheet {
	/** Local-only list summary from the live metadata subscription; never persisted by the API. */
	cloudSummary?: { revision: number; rowCount: number; rows: Row[] };
	id: string;
	revision?: number;
	name: string;
	columns: Column[];
	/** The view saved before filters and sort became each viewer's own (sheet-view.ts). It starts a viewer's view; the
	    browser only drops a deleted column's entries from it. */
	filters: Filter[];
	sort: Sort | null;
	/** The last populate request, so "find more rows" can continue it. */
	populate?: PopulateRequest;
	/** `SHEET_DATA_VERSION` when created or upgraded; older sheets are upgraded once when they load. */
	dataVersion?: number;
	createdAt: number;
	updatedAt: number;
}

/* ───────────────────────────── Populate ───────────────────────────── */

export const ENTITY_KINDS = ['companies', 'people', 'websites'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const PopulateRequestSchema = z.object({
	query: z.string().min(3).max(2000),
	entity: z.enum(ENTITY_KINDS),
	target: z.number().int().min(1).max(100, 'Only 100 at a time. Ask for 100 or fewer.').default(20),
	countries: z.array(z.string().length(2)).max(20).optional(),
	/** Remaining sheet capacity. Explicit people lists use this rather than the discovery target. */
	availableRows: z.number().int().min(1).max(1000).optional(),
	/** Keys (domains, profile URLs, URLs) already in the sheet, so results are appended without duplicates. */
	existingKeys: z.array(z.string()).max(20000).optional(),
});
export type PopulateRequest = z.infer<typeof PopulateRequestSchema>;

/** One row found by the populate agent: field name → value; `found-rows.ts` places it in a sheet. */
export type FoundRow = Record<string, CellValue>;

export type PopulateEvent =
	| { type: 'status'; message: string }
	/** `key` is only read by tabs loaded before the found-rows Module; drop it after one release. */
	| { type: 'rows'; rows: FoundRow[]; key?: string }
	| { type: 'done'; total: number; message?: string }
	| { type: 'error'; message: string; failure?: EnrichFailure };

/** Column layouts the populate agent writes into. */
export const ENTITY_COLUMNS: Record<EntityKind, Array<{ name: string; format?: ColumnFormat; width?: number }>> = {
	companies: [
		{ name: 'Company', width: 200 },
		{ name: 'Website', format: 'website', width: 170 },
		{ name: 'Description', width: 320 },
		{ name: 'Industry', width: 160 },
		{ name: 'Headquarters', width: 170 },
		{ name: 'Employees', format: 'number', width: 110 },
		{ name: 'Founded', format: 'year', width: 90 },
		{ name: 'Funding', format: 'currency', width: 160 },
		{ name: 'Stage', width: 110 },
	],
	people: [
		{ name: 'Name', width: 180 },
		{ name: 'Title', width: 200 },
		{ name: 'Company', width: 170 },
		{ name: 'Company website', format: 'website', width: 160 },
		{ name: 'Location', width: 170 },
		{ name: 'LinkedIn', format: 'url', width: 220 },
		{ name: 'Schools', width: 200 },
		{ name: 'Skills', width: 220 },
		{ name: 'Years of experience', format: 'number', width: 120 },
		{ name: 'Summary', width: 320 },
	],
	websites: [
		{ name: 'Webpage', format: 'webpage', width: 260 },
		{ name: 'Title', width: 260 },
		{ name: 'Description', width: 400 },
	],
};

/* ───────────────────────────── API contracts ───────────────────────────── */

export const EnrichRequestSchema = z.object({
	op: ColumnOpSchema,
	/** Column name → current cell value for the row. */
	row: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())])),
	model: z.string().max(100).optional(),
	/** One cell run. Each looot run of it derives its idempotency key from it, so a resend of the same run never pays twice. */
	attempt: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional(),
	/** The sheet cell this run fills: the server holds its spend against the sheet's cap and counts its column's misses. */
	cell: z.object({ sheetId: z.string().min(1).max(128), rowId: z.string().min(1).max(128), columnId: z.string().min(1).max(128) }).optional(),
});

/** Why an enrichment failed. Set where the failure is understood; code branches on this, never on `error` text. */
export const FAILURE_REASONS = ['rate_limited', 'credits_exhausted', 'credential_missing', 'credential_invalid', 'timeout', 'provider_error', 'input_invalid', 'spend_capped', 'column_halted'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
export type FailureProvider = 'openai' | 'looot' | 'typesafe';
export interface EnrichFailure {
	reason: FailureReason;
	/** The same request may succeed if repeated later without user action. */
	retryable: boolean;
	provider?: FailureProvider;
}

export interface EnrichResponse {
	value: CellValue;
	meta?: CellMeta;
	/** Human-readable explanation; presentation only. */
	error?: string;
	failure?: EnrichFailure;
}

export const ComposeColumnRequestSchema = z.object({
	ask: z.string().min(1).max(2000),
	columns: z.array(z.object({ name: z.string(), type: z.enum(['source', 'enriched']), sample: z.string().optional() })).max(100),
	entity: z.enum(ENTITY_KINDS).optional(),
	hasJev: z.boolean().optional(),
	excludeFormula: z.boolean().optional(),
	model: z.string().max(100).optional(),
});
export type ComposeColumnRequest = z.infer<typeof ComposeColumnRequestSchema>;

export type FormulaSuggestion = { kind: 'formula'; request: string };

export interface ComposeColumnResponse {
	name: string;
	op: ColumnOp | FormulaSuggestion;
	rationale?: string;
}

export interface KeyVerification {
	openai: { ok: boolean; message?: string; issue?: 'key' | 'billing' | 'model' | 'rate-limit' | 'connection'; inference?: boolean };
	looot: { ok: boolean; message?: string; balanceUsd?: number; issue?: 'key' | 'balance' };
	typesafe: { ok: boolean; message?: string; configured: boolean };
}

export const DEFAULT_MODEL = 'gpt-6-luna';
export const SUGGESTED_MODELS = [DEFAULT_MODEL, 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.4-nano', 'gpt-5.5', 'gpt-4.1-mini', 'gpt-4.1'];
