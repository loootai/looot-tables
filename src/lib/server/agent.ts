import 'server-only';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { convertToModelMessages, isStepCount, streamText, tool, type ToolSet, type UIMessage } from 'ai';
import { MODEL_ID } from '../organization-settings';
import { failureOf, newTrace } from './api-route';
import { CredentialError } from './credentials';
import type { Database } from './database';
import { McpStore } from './mcp-store';
import type { ProviderAccess } from './provider-access';
import { AGENT_TOOL_NAMES, SheetTools } from './sheet-tools';
import { WorkspaceStore } from './workspace-store';
import { SHEET_TOOLS, toolDescription } from './tool-specs';

/* The in-app agent: the same tools as the MCP server (SheetTools), minus every tool that spends or deletes. Paid work
   reaches the user as a quote card; their click runs it through /api/agent/run with the same quote and budget rules. */

/** The agent's Claude model when the workspace has an Anthropic key. */
export const AGENT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';
/** Steps one message may take: tool calls plus the final answer. */
const MAX_STEPS = 24;

/** The model the agent runs on: `x-agent-model` when it names one ("anthropic/<id>" or "openai/<id>"), else Claude on
    the caller's Anthropic key, else their OpenAI model. Never a key the caller has no access to. */
export function agentModel(access: ProviderAccess, requested?: string | null): { model: LanguageModelV4; id: string } {
	const slash = requested && MODEL_ID.test(requested) ? requested.indexOf('/') : -1;
	const [provider, id] = slash > 0 ? [requested!.slice(0, slash), requested!.slice(slash + 1)] : [null, null];
	if (provider === 'openai' && id) return { model: access.openai(id), id: `openai/${id}` };
	if (provider === 'anthropic' && id) return { model: access.anthropic(id), id: `anthropic/${id}` };
	if (access.key('anthropic')) return { model: access.anthropic(AGENT_ANTHROPIC_MODEL), id: `anthropic/${AGENT_ANTHROPIC_MODEL}` };
	if (access.key('openai')) return { model: access.openai(), id: `openai/${access.model}` };
	throw new CredentialError('Add an Anthropic or OpenAI API key in Configuration to use the agent.', 401, 'credential_missing', 'anthropic');
}

/** The AI SDK tools of the in-app agent. A tool that fails answers with its error, so the model can correct itself. */
export function agentTools(tools: SheetTools): ToolSet {
	return Object.fromEntries(AGENT_TOOL_NAMES.map((name) => {
		const spec = SHEET_TOOLS[name];
		return [name, tool({
			description: toolDescription(spec),
			inputSchema: spec.schema,
			execute: async (args: unknown) => {
				const started = performance.now();
				try { return await tools.call(name, args); }
				catch (error) { return { error: failureOf(error, { ...newTrace('agent'), operation: `agent.${name}`, started, phase: 'tool' }).error }; }
			},
		})];
	}));
}

export function agentInstructions(sheet: { id: string; name: string } | null) {
	return [
		'You are the agent inside looot tables, an enrichment spreadsheet. You build and fill sheets for the user with the tools you have: create sheets and columns, add and import rows, find rows, look things up in the looot catalog, quote runs, and read results.',
		sheet ? `The user has the sheet “${sheet.name}” open (sheetId ${sheet.id}). Work in it unless they ask for another sheet. Read its columns and revision with query_rows (limit 1) before editing.` : 'No sheet is open. Use list_sheets, or create one.',
		'Money: you cannot spend. Running a column (quote_run) or finding rows (quote_find_rows) only prices the work; the user sees each quote as a card with Run, Try 5 rows and Cancel, and their click runs it. After you quote, say in one sentence what the card will do and stop: never say a paid step has run until a message tells you it has. For a new column, suggest Try 5 rows first. Free actions (reading, adding rows the user gave you, adding a column without running it, catalog search) need no card.',
		'Plan: for people, use the people template, quote_find_rows with jobTitle and a description of the companies (or domains), then add_contact_columns for a verified work email, then quote_run on that column. For companies, use the companies template, company data columns, or an AI column with web research that cites sources. For a CSV, import_rows, then dedupe_rows (dry run first).',
		'When a message says a run finished, read its numbers (filled, empty, errors, spent), report them in one or two sentences, and offer the next step as a quote.',
		'Write short, plain sentences. No headings. Numbers over adjectives. Never invent people, emails or companies: only report what tools returned.',
	].join('\n\n');
}

export async function streamAgent(input: { model: LanguageModelV4; tools: SheetTools; messages: UIMessage[]; sheet: { id: string; name: string } | null; signal?: AbortSignal }) {
	const tools = agentTools(input.tools);
	return streamText({
		model: input.model,
		system: agentInstructions(input.sheet),
		messages: await convertToModelMessages(input.messages, { tools, ignoreIncompleteToolCalls: true }),
		tools,
		stopWhen: isStepCount(MAX_STEPS),
		maxRetries: 0,
		abortSignal: input.signal,
	});
}

/** The sheet tools for a signed-in browser caller, on their own keys. */
export function browserSheetTools(database: Database, access: ProviderAccess) {
	if (!access.account) throw new CredentialError('Sign in to use the agent.', 401);
	return new SheetTools({ database, sheets: new WorkspaceStore(database), keys: new McpStore(database) }, access.account, access);
}
