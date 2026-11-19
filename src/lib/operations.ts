import type { Provider } from './organization-settings';
import { ColumnOpSchema, type ColumnOp, type FailureProvider, type OpKind, type PageSource } from './types';

/* The operation catalog: one record per operation kind, describing it to every caller (editor, runner, freshness,
   cost estimates, MCP, compose and the server executor). Add a kind here and the rest of the app picks it up. */

type Op<K extends OpKind> = Extract<ColumnOp, { kind: K }>;
type Field<K extends OpKind> = K extends OpKind ? Exclude<keyof Op<K>, 'kind'> & string : never;

/** Any one of these providers satisfies the need. */
export type ProviderNeed = readonly Provider[];
/** What a run reads besides its references: the whole row, only the references, or the whole row when its instruction references nothing. */
export type RowContext = 'row' | 'references' | 'row-unless-referenced';
export interface DefinitionIssue { field: string; message: string }

export interface Operation<K extends OpKind = OpKind> {
	label: string;
	short: string;
	description: string;
	/** Suggested name for a new column. */
	columnName: string;
	/** Fields holding `{{…}}` text or a page source. They drive dependencies and renames alike. */
	references: readonly Field<K>[];
	/** The field holding the user's instruction, which also selects company reference data. */
	instruction?: Field<K>;
	rowContext(op: Op<K>): RowContext;
	/** Evaluated in the browser without a request. */
	local(op: Op<K>): boolean;
	/** Keys the server executor needs before it can start. */
	requires(op: Op<K>): ProviderNeed[];
	/** Rough looot cost per cell in USD, for the confirmation before a run. A fallback route can cost more when providers miss. */
	costUsd(op: Op<K>): number;
	/** Slowest plausible single run, so MCP never starts a row it cannot finish. */
	worstCaseMs(op: Op<K>): number;
	/** Who answers failures that do not name their provider. Decisions may use TypeSafe or OpenAI. */
	bills?: FailureProvider;
	/** What a new or edited definition must satisfy beyond its stored shape. Stored definitions stay loadable. */
	issue?(op: Op<K>): DefinitionIssue | null;
}

const LOOOT: ProviderNeed = ['looot'];
const OPENAI: ProviderNeed = ['openai'];
const DECIDER: ProviderNeed = ['typesafe', 'openai'];
const pageNeeds = (page?: PageSource): ProviderNeed[] => page ? [LOOOT] : [];
/** One scrape is about a tenth of a cent; finding a named page tries up to three paths first. */
const SCRAPE_USD = 0.001;
const pageCost = (page?: PageSource) => !page ? 0 : page.type === 'find' ? 3 * SCRAPE_USD + SCRAPE_USD : SCRAPE_USD;
const remote = () => false;
const row = (): RowContext => 'row';
const references = (): RowContext => 'references';
const free = () => 0;
const typical = () => 90_000;
const decision = () => 120_000;

export const OPERATIONS: { readonly [K in OpKind]: Operation<K> } = {
	'email-enrichment': {
		label: 'Find email', short: 'Email', columnName: 'Work email',
		description: 'Asks looot for a work email. looot tries its email providers one after another, in the order you pick, and stops at the first address. With verify on, the same cell checks the address and shows Valid, Catch-all or Not found.',
		references: ['name', 'company', 'domain', 'profileUrl'], rowContext: references, local: remote,
		requires: () => [LOOOT], costUsd: (op) => 0.02 + (op.verify ? 0.003 : 0), worstCaseMs: () => 200_000, bills: 'looot',
	},
	'email-verify': {
		label: 'Verify email', short: 'Verify', columnName: 'Email status',
		description: 'Checks whether an email is deliverable. The cell holds valid, invalid, catch_all, risky or unknown.',
		references: ['email'], rowContext: references, local: remote,
		requires: () => [LOOOT], costUsd: () => 0.003, worstCaseMs: () => 120_000, bills: 'looot',
	},
	'phone-find': {
		label: 'Find phone', short: 'Phone', columnName: 'Phone',
		description: 'Asks looot for a phone number from a LinkedIn URL, or a name and company. looot walks its phone providers until one answers.',
		references: ['name', 'company', 'domain', 'profileUrl'], rowContext: references, local: remote,
		requires: () => [LOOOT], costUsd: () => 0.03, worstCaseMs: () => 200_000, bills: 'looot',
	},
	looot: {
		label: 'Any looot endpoint', short: 'looot', columnName: 'looot result',
		description: 'Pick any endpoint from the looot catalog, map its inputs from your columns, and keep its answer. Shows the estimated cost before it runs.',
		references: ['inputs'], rowContext: references, local: remote,
		requires: () => [LOOOT], costUsd: (op) => op.unitCostUsd ?? 0, worstCaseMs: () => 180_000, bills: 'looot',
		issue: (op) => Object.values(op.inputs).every((template) => !template.trim()) ? { field: 'inputs', message: 'Map at least one input to a column or a value.' } : null,
	},
	'email-draft': {
		label: 'Email draft', short: 'Email draft', columnName: 'Email draft',
		description: 'Draft a personalized email with AI, or fill an email template from columns.',
		references: ['prompt', 'to', 'cc', 'bcc', 'subject', 'body'], instruction: 'prompt',
		rowContext: (op) => op.mode === 'template' ? 'references' : 'row', local: (op) => op.mode === 'template',
		requires: (op) => op.mode === 'template' ? [] : [OPENAI], costUsd: free, worstCaseMs: (op) => op.mode === 'template' ? 1_000 : 90_000, bills: 'openai',
	},
	ai: {
		label: 'Ask AI', short: 'AI', columnName: 'AI answer',
		description: 'AI answers a question about each row, searching the web through looot when it needs to.',
		references: ['prompt', 'page'], instruction: 'prompt', rowContext: row, local: remote,
		// Web research uses looot only when a token is connected; reading a page needs it.
		requires: (op) => [OPENAI, ...pageNeeds(op.page)], costUsd: (op) => (op.research === 'web' ? 0.004 : 0) + pageCost(op.page), worstCaseMs: decision, bills: 'openai',
	},
	check: {
		label: 'True / false check', short: 'Check', columnName: 'Check',
		description: 'A yes-or-no answer with a probability. Can read a page first.',
		references: ['question', 'page'], instruction: 'question', rowContext: row, local: remote,
		// Exact-text checks match the row or page without a model.
		requires: (op) => [...pageNeeds(op.page), ...(op.literal?.trim() ? [] : [DECIDER])], costUsd: (op) => pageCost(op.page), worstCaseMs: decision,
	},
	classify: {
		label: 'Classify', short: 'Classify', columnName: 'Category',
		description: 'Pick one of your options for each row, with a probability for every option.',
		references: ['question', 'page'], instruction: 'question', rowContext: row, local: remote,
		requires: (op) => [...pageNeeds(op.page), DECIDER], costUsd: (op) => pageCost(op.page), worstCaseMs: decision,
	},
	score: {
		label: 'Score', short: 'Score', columnName: 'Score',
		description: 'Rate each row on levels you define, lowest to highest.',
		references: ['question', 'page'], instruction: 'question', rowContext: row, local: remote,
		requires: (op) => [...pageNeeds(op.page), DECIDER], costUsd: (op) => pageCost(op.page), worstCaseMs: decision,
	},
	scrape: {
		label: 'Read a page', short: 'Scrape', columnName: 'Page',
		description: 'Fetch a page and keep its text, relevant passages, links or extracted fields.',
		references: ['page', 'query'], rowContext: references, local: remote,
		requires: () => [LOOOT], costUsd: (op) => Math.max(SCRAPE_USD, pageCost(op.page)), worstCaseMs: typical, bills: 'looot',
		issue: (op) => op.mode === 'extract' && !op.fields?.length && !op.query?.trim() ? { field: 'fields', message: 'Add a field or instructions to extract.' } : null,
	},
	search: {
		label: 'Web search', short: 'Search', columnName: 'Search result',
		description: 'Search the web and keep the top URL, title or snippet.',
		references: ['query'], rowContext: references, local: remote,
		requires: () => [LOOOT], costUsd: () => 0.0005, worstCaseMs: typical, bills: 'looot',
	},
	company: {
		label: 'Company data', short: 'Company', columnName: 'Company info',
		description: 'Firmographics, funding, links and socials for a company domain.',
		references: ['domain'], rowContext: references, local: remote,
		requires: () => [LOOOT], costUsd: () => 0.002, worstCaseMs: typical, bills: 'looot',
	},
	person: {
		label: 'Person data', short: 'Person', columnName: 'Person info',
		description: 'Title, employer, education and profiles for a person, from their LinkedIn URL or name and company.',
		references: ['name', 'company', 'email', 'profileUrl'], rowContext: references, local: remote,
		requires: () => [LOOOT], costUsd: () => 0.016, worstCaseMs: typical, bills: 'looot',
	},
	answer: {
		label: 'Deep research', short: 'Research', columnName: 'Research',
		description: 'AI researches the live web through looot, reading as many pages as it needs, and returns a sourced answer. Slower and costs more.',
		references: ['task'], instruction: 'task', rowContext: () => 'row-unless-referenced', local: remote,
		requires: () => [OPENAI, LOOOT], costUsd: (op) => op.mode === 'ultra' ? 0.03 : 0.01, worstCaseMs: () => 240_000, bills: 'openai',
	},
	template: {
		label: 'Text template', short: 'Template', columnName: 'Text',
		description: 'Combine other columns with a template. No API calls.',
		references: ['template'], rowContext: references, local: () => true,
		requires: () => [], costUsd: free, worstCaseMs: () => 1_000,
	},
};

export const OP_KINDS = Object.keys(OPERATIONS) as OpKind[];

export function operation(kind: OpKind): Operation {
	return OPERATIONS[kind] as Operation;
}

/** The kinds as MCP and compose present them. */
export const operationSummaries = Object.fromEntries(OP_KINDS.map((kind) => [kind, { label: OPERATIONS[kind].label, short: OPERATIONS[kind].short, description: OPERATIONS[kind].description }])) as Record<OpKind, { label: string; short: string; description: string }>;

export const instructionField = (op: ColumnOp) => operation(op.kind).instruction;

export function instructionText(op: ColumnOp): string {
	const field = instructionField(op);
	const value = field ? (op as Record<string, unknown>)[field] : undefined;
	return typeof value === 'string' ? value : '';
}

const YES_NO = /^(?:is|are|was|were|does|do|did|has|have|can|could|will|would|should)\s+/i;
const ASKS = /^(?:please\s+)?(?:(?:who|what|which|where|when|how(?:\s+(?:many|much|big|old|long))?)(?:'s|’s|\s+(is|are|was|were|does|do|did|has|have|can|should|would))?|find|get|list|give|tell me|identify|determine|estimate|look up|extract)\s+/i;
const ARTICLE = /^(?:the|a|an|its|their|this|each|every|any)\s+/i;
const BOUNDARY = /\s+(?:of|for|at|in|on|from|by|with|about|does|do|did|is|are|was|were|has|have|that|which|who|whose|to|than|if)(?=\s|$)|[,;:(]/i;
const BEFORE_REFERENCE = /\s+(?:of|for|at|in|on|from|by|with|about|does|do|did|is|are|was|were|has|have|to)\s+\{\{/i;
const SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs']);
const NOT_A_NAME = /^(?:what|who|how|which|whether|if|why|when|where|it|they|this|that)\b/i;

/**
 * A short title-case column name from an AI column's question: "Who is the CEO of {{Company}}?" → "CEO",
 * "Does {{Domain}} offer a free tier?" → "Free Tier?". Empty when the question doesn't name a thing.
 */
export function columnNameFromQuestion(question: string): string {
	let text = (question.trim().split('\n')[0] ?? '').replace(/\{\{[^}]*\}\}(?:'s|’s)/g, ' ');
	// The words before "… of {{Company}}" name the column, even when they hold an "of" themselves ("head of sales").
	const cut = text.search(BEFORE_REFERENCE);
	if (cut > 0) text = text.slice(0, cut);
	text = text.replace(/\{\{[^}]*\}\}/g, ' ').replace(/\s+/g, ' ').trim();
	const yesNo = YES_NO.test(text);
	if (yesNo) text = text.replace(YES_NO, '');
	else {
		const asked = text.match(ASKS);
		// "What does … sell?" leaves a verb; "How mature is …?" an adjective.
		if (asked?.[1] && /^(?:does|do|did|can|should|would)$/i.test(asked[1]) || /^how\s+(?!many|much|big|old|long)/i.test(text)) return '';
		if (asked) text = text.slice(asked[0].length);
	}
	// "offer a free tier", "Draft a summary": the verb goes, its object names the column.
	text = text.replace(/^\w+\s+(?=(?:a|an|the|any|each|every)\s)/i, '').replace(ARTICLE, '');
	text = (cut > 0 ? text : text.split(BOUNDARY)[0]).replace(/[?.!]+$/, '').trim();
	const words = text.split(' ').filter(Boolean);
	if (!words.length || words.length > 4 || text.length > 32 || NOT_A_NAME.test(text)) return '';
	const name = words.map((word, index) => index && SMALL.has(word.toLowerCase()) ? word.toLowerCase() : /[A-Z]/.test(word.slice(1)) ? word : word[0].toUpperCase() + word.slice(1)).join(' ');
	return yesNo ? `${name}?` : name;
}

export const evaluatesLocally = (op: ColumnOp) => operation(op.kind).local(op);
export const requiredProviders = (op: ColumnOp) => operation(op.kind).requires(op);
export const costPerCell = (op: ColumnOp) => operation(op.kind).costUsd(op);
export const worstCaseMs = (op: ColumnOp) => operation(op.kind).worstCaseMs(op);
export const billingProvider = (op: ColumnOp) => operation(op.kind).bills;

/** The first provider of each unmet need; empty when the operation can run. */
export function missingProviders(op: ColumnOp, ready: (provider: Provider) => boolean): Provider[] {
	return requiredProviders(op).filter((need) => !need.some(ready)).map((need) => need[0]);
}

export function definitionIssue(op: ColumnOp): DefinitionIssue | null {
	return operation(op.kind).issue?.(op) ?? null;
}

/** New or edited definitions: the stored shape plus each operation's own rules. */
export const ColumnOpInputSchema = ColumnOpSchema.superRefine((op, context) => {
	const issue = definitionIssue(op);
	if (issue) context.addIssue({ code: 'custom', message: issue.message, path: [issue.field] });
});
