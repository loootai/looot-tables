import { z } from 'zod';

/* Recipes, served as MCP prompts and shown in the in-app agent's empty state. Each one names the tools in the order that
   keeps money behind a quote the user has seen. */

export interface AgentPrompt {
	name: string;
	title: string;
	description: string;
	/** What the in-app agent's starter button sends. */
	starter: string;
	args: Record<string, z.ZodOptional<z.ZodString>>;
	text(args: Record<string, string | undefined>): string;
}

const MONEY = 'Before anything that spends looot credit, quote it (quote_run or quote_find_rows), show me the price and the 5-row trial, and wait for my yes. Run new columns on 5 rows first.';

export const AGENT_PROMPTS: AgentPrompt[] = [
	{
		name: 'find-people-verify-emails',
		title: 'Find people and verify their emails',
		description: 'Build a list of people by role at a kind of company, then find and verify their work emails.',
		starter: 'Find heads of RevOps at 50-500 person SaaS companies, then get their work emails and verify them',
		args: { role: z.string().max(120).optional().describe('The job title, for example Head of RevOps.'), companies: z.string().max(400).optional().describe('What the employers are, for example B2B SaaS, 50 to 500 people, US.'), count: z.string().max(4).optional().describe('How many people, up to 100.') },
		text: ({ role, companies, count }) => `Find ${count ?? '25'} ${role ?? 'heads of RevOps'} at ${companies ?? '50-500 person SaaS companies'}, then get their work emails and verify them.

Steps: create a sheet with the people template (create_sheet), price the search with quote_find_rows (people, with jobTitle and the company description or domains), then find_rows. Add a verified work email column with add_contact_columns (email and verify on), quote it with quote_run, run 5 rows first, show me the fill rate, then the rest. ${MONEY}`,
	},
	{
		name: 'research-companies',
		title: 'Research a list of companies',
		description: 'Answer the same question for every company in a list, with sources.',
		starter: 'Research these companies: what do they sell, who do they sell to, and do they have a free plan? Stripe, Linear, Vercel, Notion, Figma',
		args: { companies: z.string().max(4000).optional().describe('Company names or websites, one per line or comma separated.'), question: z.string().max(1000).optional().describe('What to find out about each company.') },
		text: ({ companies, question }) => `Research these companies: ${companies ?? 'the companies in my sheet'}.
Question for each: ${question ?? 'what do they sell, who do they sell to, and do they have a free plan?'}

Steps: put the companies in a sheet (create_sheet with the companies template, then upsert_rows), add company data columns or an AI column with web research that cites its sources (configure_column, op kind "ai" with research "web"), quote it, run 5 rows, show me, then the rest. ${MONEY}`,
	},
	{
		name: 'enrich-my-csv',
		title: 'Enrich a CSV',
		description: 'Import a CSV and fill in what is missing: company data, emails, phones.',
		starter: 'Enrich the CSV I uploaded: add company size and industry, then find work emails for the people in it',
		args: { csvUrl: z.string().max(2000).optional().describe('A public https CSV URL, if the file is online.'), want: z.string().max(1000).optional().describe('What to add, for example headcount, industry and work email.') },
		text: ({ csvUrl, want }) => `Enrich ${csvUrl ? `the CSV at ${csvUrl}` : 'the CSV I uploaded (it is already in this sheet, or I will paste it)'}. Add: ${want ?? 'company size and industry, then work emails for the people in it'}.

Steps: import it with import_rows if it is not in a sheet yet, look at it with query_rows, remove duplicates with dedupe_rows (dry run first), add the columns (configure_column for company data, add_contact_columns for emails), quote each, run 5 rows first, then the rest. ${MONEY}`,
	},
];
