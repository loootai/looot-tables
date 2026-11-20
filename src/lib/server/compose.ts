import { companyContextForQuery, explicitCompanyDomain } from './company-context';
import 'server-only';

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { type ColumnOp, type ComposeColumnRequest, type ComposeColumnResponse, OUTPUT_TYPES, type PageSource } from '../types';
import { ColumnOpInputSchema, instructionField, instructionText, OP_KINDS, OPERATIONS } from '../operations';
import type { ProviderAccess } from './provider-access';

const GUIDE = `You turn a plain-language request into one spreadsheet column definition. Pick the cheapest operation that answers it well:
- email-draft: when asked to draft, write or compose an email (e.g. draft an email to xyz). Set text to the drafting instructions and emailFields to recipient templates and any supplied subject/body. Use emailMode ai for writing, template for deterministic text from columns. Never use ai for an email draft.
- formula: prefer for basic manipulation of existing data: arithmetic, text cleanup, splitting, joining, extracting parts, dates, conditional logic, and building URLs or combining literal text with column values. For text assembly, request readable formulas using the single & concatenation operator with spaces, e.g. ="Hi " & A1 & ", welcome!"; never &&. Set text to instructions for the formula builder, preserving column names and references. No external data or subjective reasoning. The client builds and tests a spreadsheet formula on up to 10 rows before applying it.
- company: one of exactly these firmographic fields for a domain column: description, title, slogan, industry, employees, city, country, address, email, phone, ticker, linkedin, twitter, pricing_url, careers_url, blog_url, contact_url, logo_url, primary_color, language, funding_total, funding_stage, funding_latest_round, funding_latest_date, funding_latest_amount, funding_round_count. Nothing else (no people, investors, products, or tech stack): those need ai.
- person: a fact about a person (title, company, location, LinkedIn, schools, degrees, experience) from a name + company, email, or profile URL column.
- email-enrichment: for finding work emails from personName and domain, optionally personCompany and personProfileUrl. looot tries its email providers one after another until one finds an address, in the order set by emailPrefer (balanced, cheapest or reliable). The address is not verified: add an email-verify column when asked to check it.
- email-verify: check whether an email is deliverable. Set personEmail to the email template. The cell holds a status: valid, invalid, catch_all, risky or unknown.
- phone-find: find a phone number from personProfileUrl (LinkedIn), or personName with personCompany or domain. Costs more than an email.
- scrape: read a page. scrapeMode "highlights" with a query for passages, "extract" with fields for structured facts from a page, "title", or "url" (just find the page, e.g. the pricing page URL).
- check: a true/false question. Set page when the answer lives on a page (pricing page, homepage, careers page, a URL column). Use literal only when the user asks for an exact phrase match.
- classify: pick one of a fixed set of options (industry buckets, ICP fit, persona). Provide 2-8 clear options with short descriptions.
- score: rate on ordered levels (worst to best), 3-5 levels with descriptive labels.
- search: find a URL/title on the web for a query template, e.g. "{{Company}} crunchbase".
- For documents, company briefs, one-page briefs, reports, and longer research writeups, select ai with output "document". Use the row cells as context, reference relevant columns in the prompt, and preserve the requested length. Use research "none" when asked to use only row data; otherwise "web".
- ai: anything else that needs reasoning or multi-step research: who is the CEO or founder, what is the tech stack, when was the Series A, which investors, what products. research "web" lets it search and read pages; "none" answers from the row only.
- answer: deep research needing many sources; the agent takes more steps, so it costs more (fast, or ultra for the longest). Use sparingly.

Rules:
- "text" holds the operation's main input: the question (ai/check/classify/score), the research task (answer), the search query (search), the highlight query or extraction instructions (scrape), or the formula-building instructions (formula).
- Reference existing columns as {{Column Name}} using their exact names from the list.
- Also accept explicit cell and range references such as {{A1}}, {{$A$1}}, {{A$1}}, {{$A1}}, and {{A1:B3}}. Preserve these references and dollar signs exactly. Relative rows advance as the column fills down from sheet row 1; $ locks a coordinate. Prefer column names when adding new references. Use a template page source for a cell or range URL reference.
- References explicitly included in the request are dynamic per-row values, never sample literals. Preserve them in the operation input or its page/identity fields so the operation reads those columns for every row.
- For page sources prefer {type:"find", column:<domain column>, page:"pricing"} for named pages, {type:"homepage", column} for the homepage, {type:"column", column} for URL columns, {type:"template", template} for URL templates.
- Choose output types carefully (boolean for true/false, number for counts, url for links, date for dates, list for several items).
- Name the column like a spreadsheet header (short, Title case, under 40 characters).
- Fields you do not need must be null.`;

const COMPANY_FIELDS = ['description', 'title', 'slogan', 'industry', 'employees', 'city', 'country', 'address', 'email', 'phone', 'ticker', 'linkedin', 'twitter', 'pricing_url', 'careers_url', 'blog_url', 'contact_url', 'logo_url', 'primary_color', 'language', 'funding_total', 'funding_stage', 'funding_latest_round', 'funding_latest_date', 'funding_latest_amount', 'funding_round_count'] as const;
const PERSON_FIELDS = ['title', 'company', 'company_domain', 'location', 'bio', 'linkedin', 'email', 'skills', 'schools', 'degrees', 'experience', 'years_at_company', 'full_name'] as const;

/* OpenAI structured outputs reject oneOf, which a discriminated union would produce, so the model fills one flat
   shape and the server folds it into a ColumnOp. */
const FlatSchema = z.object({
	name: z.string().describe('Column header, Title case, under 40 characters.'),
	kind: z.enum(['email-enrichment', 'email-verify', 'phone-find', 'email-draft', 'ai', 'check', 'classify', 'score', 'scrape', 'search', 'company', 'person', 'answer', 'formula']),
	text: z.string().describe('Main input for the operation; see the rules.'),
	rationale: z.string().describe('One sentence on why this operation.'),
	output: z.enum(OUTPUT_TYPES).nullable().describe('ai and answer only.'),
	research: z.enum(['none', 'web']).nullable().describe('ai only.'),
	page: z
		.object({
			type: z.enum(['column', 'homepage', 'find', 'template']),
			column: z.string().nullable().describe('Column name holding the domain or URL.'),
			page: z.string().nullable().describe('For type find: pricing, careers, about, team, contact, blog, docs…'),
			template: z.string().nullable().describe('For type template: a URL template such as https://{{Domain}}/pricing'),
		})
		.nullable()
		.describe('Page to read first (ai, check, classify, score) or the page to read (scrape).'),
	literal: z.string().nullable().describe('check only: exact text to look for instead of asking a model.'),
	options: z.array(z.object({ label: z.string(), description: z.string().nullable() })).nullable().describe('classify only.'),
	levels: z.array(z.string()).nullable().describe('score only, lowest to highest.'),
	scrapeMode: z.enum(['markdown', 'highlights', 'extract', 'title', 'url']).nullable(),
	fields: z.array(z.object({ name: z.string(), description: z.string().nullable() })).nullable().describe('scrape extract only.'),
	pick: z.enum(['url', 'title', 'snippet', 'list']).nullable().describe('search only.'),
	domain: z.string().nullable().describe('company, email-enrichment or phone-find: a domain template such as {{Domain}}.'),
	companyField: z.enum(COMPANY_FIELDS).nullable(),
	personName: z.string().nullable(),
	personCompany: z.string().nullable(),
	personEmail: z.string().nullable(),
	personProfileUrl: z.string().nullable(),
	personField: z.enum(PERSON_FIELDS).nullable(),
	emailPrefer: z.enum(['balanced', 'cheapest', 'reliable']).nullable().describe('email-enrichment, email-verify and phone-find: how looot orders its providers.'),
	emailMode: z.enum(['ai', 'template']).nullable(),
	emailFields: z.object({ to: z.string(), cc: z.string(), bcc: z.string(), subject: z.string(), body: z.string() }).nullable(),
	answerMode: z.enum(['fast', 'ultra']).nullable(),
});
type Flat = z.infer<typeof FlatSchema>;

function toPage(page: Flat['page']): PageSource | undefined {
	if (!page) return undefined;
	switch (page.type) {
		case 'column':
			return page.column ? { type: 'column', column: page.column } : undefined;
		case 'homepage':
			return page.column ? { type: 'homepage', column: page.column } : undefined;
		case 'find':
			return page.column ? { type: 'find', column: page.column, page: page.page || 'pricing' } : undefined;
		case 'template':
			return page.template ? { type: 'template', template: page.template } : undefined;
	}
}

function toOp(flat: Flat, decider: 'jev' | 'openai'): ComposeColumnResponse['op'] {
	const page = toPage(flat.page);
	switch (flat.kind) {
		case 'formula':
			return { kind: 'formula', request: flat.text };
		case 'email-enrichment':
			return { kind: 'email-enrichment', name: flat.personName ?? '', domain: flat.domain ?? '', company: flat.personCompany ?? '', profileUrl: flat.personProfileUrl ?? '', prefer: flat.emailPrefer ?? 'balanced', verify: true };
		case 'email-verify':
			return { kind: 'email-verify', email: flat.personEmail ?? '', prefer: flat.emailPrefer ?? 'balanced' };
		case 'phone-find':
			return { kind: 'phone-find', name: flat.personName ?? '', company: flat.personCompany ?? '', domain: flat.domain ?? '', profileUrl: flat.personProfileUrl ?? '', prefer: flat.emailPrefer ?? 'balanced' };
		case 'email-draft':
			return { kind: 'email-draft', mode: flat.emailMode ?? 'ai', prompt: flat.text, to: '', cc: '', bcc: '', subject: '', body: '', ...flat.emailFields };
		case 'ai':
			return { kind: 'ai', prompt: flat.text, output: flat.output ?? 'text', research: flat.research ?? 'web', page };
		case 'check':
			return { kind: 'check', question: flat.text, page, decider, threshold: 0.5, literal: flat.literal ?? undefined };
		case 'classify':
			return { kind: 'classify', question: flat.text, options: (flat.options ?? []).map((option) => ({ label: option.label, description: option.description ?? undefined })), page, decider };
		case 'score':
			return { kind: 'score', question: flat.text, levels: flat.levels ?? [], page, decider };
		case 'scrape':
			return { kind: 'scrape', page: page ?? { type: 'template', template: '' }, mode: flat.scrapeMode ?? 'highlights', query: flat.text || undefined, fields: flat.fields?.map((field) => ({ name: field.name, description: field.description ?? undefined })), maxChars: 2000 };
		case 'search':
			return { kind: 'search', query: flat.text, pick: flat.pick ?? 'url', numResults: 3 };
		case 'company':
			return { kind: 'company', domain: flat.domain || flat.text || '{{Domain}}', field: flat.companyField ?? 'description' };
		case 'person':
			return { kind: 'person', name: flat.personName ?? undefined, company: flat.personCompany ?? undefined, email: flat.personEmail ?? undefined, profileUrl: flat.personProfileUrl ?? undefined, field: flat.personField ?? 'title' };
		case 'answer':
			return { kind: 'answer', task: flat.text, output: flat.output ?? 'text', mode: flat.answerMode ?? 'fast' };
	}
}

export async function composeColumn(access: ProviderAccess, request: ComposeColumnRequest): Promise<ComposeColumnResponse> {
	const model = access.openai(request.model);
	const companyContext = await companyContextForQuery(access, request.ask);
	const columns = request.columns.map((column) => `- {{${column.name}}} (${column.type}${column.sample ? `, e.g. "${column.sample.slice(0, 60)}"` : ''})`).join('\n');
	const decider = request.hasJev === false ? 'openai' : 'jev';
	const schema = request.excludeFormula ? FlatSchema.extend({ kind: FlatSchema.shape.kind.exclude(['formula']) }) : FlatSchema;
	const { output } = await generateText({
		model,
		system: `${GUIDE}\nWhen the request refers to my/our company, preserve that reference AND any explicit company domain in the generated operation so execution can load the same company context.${request.excludeFormula ? '\nFormula generation or preview was unsuccessful (or unavailable). Do not select formula. Choose the best other operation for the original request.' : ''}\n\nAvailable operations: ${request.excludeFormula ? '' : 'formula (Formula), '}${OP_KINDS
			.filter((kind) => kind !== 'template' && kind !== 'looot')
			.map((kind) => `${kind} (${OPERATIONS[kind].label})`)
			.join(', ')}.`,
		prompt: `Sheet rows are ${request.entity ?? 'records'}.\nColumns:\n${columns || '(none yet)'}\n\nRequest: ${request.ask}${companyContext}`,
		output: Output.object({ schema }),
		maxRetries: 0,
	});
	let suggested = toOp(output, decider);
	const domain = explicitCompanyDomain(request.ask);
	// Preserve the explicit company through model-generated instructions and later reruns.
	if (domain && suggested.kind !== 'formula') {
		const field = instructionField(suggested);
		if (field) suggested = { ...suggested, [field]: `My company is ${domain}.\n${instructionText(suggested)}` } as ColumnOp;
	}
	if (suggested.kind === 'formula' && !request.excludeFormula) return { name: output.name.trim() || 'Formula', op: suggested, rationale: output.rationale };
	const parsed = ColumnOpInputSchema.safeParse(suggested);
	if (!parsed.success) throw new Error(`The suggested column was incomplete (${parsed.error.issues[0]?.message ?? 'invalid'}). Try rephrasing, or configure it by hand.`);
	return { name: output.name.trim() || 'New column', op: parsed.data, rationale: output.rationale };
}
