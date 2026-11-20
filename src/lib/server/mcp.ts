import 'server-only';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { OrganizationStore } from './organization-store';
import { WorkspaceError } from '../workspace';
import { errorResponse, failureOf, newTrace, type RequestTrace } from './api-route';
import type { Database } from './database';
import { operationGuidance } from './mcp-tools';
import { mcpAccess } from './provider-access';
import type { McpStore } from './mcp-store';
import { SheetTools } from './sheet-tools';
import { AGENT_PROMPTS } from '../agent-prompts';
import { SHEET_TOOLS, TOOL_NAMES, toolDescription } from './tool-specs';
import type { WorkspaceStore } from './workspace-store';

export const MCP_INSTRUCTIONS = `${operationGuidance} Use create_sheet for all spreadsheet creation: choose a built-in template and enrichments, or custom columns. Work on the organization’s saved sheets. You coordinate the workflow: create or import rows (import_rows, quote_find_rows then find_rows), add columns (configure_column, add_contact_columns, add_looot_column), then run them. Money: every tool that spends looot credit (run_column, find_rows, enrich_cells on a paid column) needs a quote and a budget. Call quote_run or quote_find_rows first (free), show the user the label and the 5-row trial, and run only after they agree, with maxUsd no higher than they approved. New columns run 5 rows first. Read results with query_rows; get_cell_details shows a cell’s receipt (providers tried, outcome and cost of each). Read current revisions before edits. Repeat a run with its original idempotencyKey to retrieve its outcome; never automatically rerun uncertain attempts. Organization provider connections and settings are loaded automatically. Optional provider header overrides are never tool arguments. Formula sheets are read-only through MCP in this version.`;

export async function handleMcpRequest(request: Request, services: { keys: McpStore; sheets: WorkspaceStore; database: Database; organization?: OrganizationStore }) {
	const trace = newTrace('mcp');
	try {
		const origin = request.headers.get('origin');
		if (origin && origin !== new URL(request.url).origin) throw new WorkspaceError('Invalid origin.', 403);
		const actor = await services.keys.authenticate(request.headers.get('authorization'));
		const access = await mcpAccess(request.headers, actor, services.organization);
		return await serveMcp(request, new SheetTools(services, actor, access), trace);
	} catch (error) {
		const response = errorResponse(error, trace);
		if (response.status === 401) response.headers.set('WWW-Authenticate', 'Bearer realm="looot tables MCP"');
		return response;
	}
}

/** A tool's answer as MCP content: JSON text for every client, structured content for those that read it. */
const answer = (data: Record<string, unknown>, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data });

export function createMcpServer(tools: SheetTools, trace: RequestTrace = newTrace('mcp')) {
	const server = new McpServer({ name: 'looot-tables', version: '1.1.0' }, { instructions: MCP_INSTRUCTIONS });
	for (const name of TOOL_NAMES) {
		const spec = SHEET_TOOLS[name];
		server.registerTool(name, {
			title: spec.title,
			description: toolDescription(spec),
			inputSchema: spec.schema as z.ZodObject,
			annotations: { title: spec.title, readOnlyHint: spec.kind === 'read', destructiveHint: spec.kind === 'destructive' || name === 'delete_rows', idempotentHint: spec.kind === 'read', openWorldHint: Boolean(spec.external) },
		}, async (args) => {
			const started = performance.now();
			try { return answer(await tools.call(name, args)); }
			catch (error) { return answer(failureOf(error, { ...trace, operation: `mcp.${name}`, started, phase: 'tool' }), true); }
		});
	}
	// Each sheet as CSV, the same text export_sheet answers.
	server.registerResource('sheet-csv', new ResourceTemplate('looot-tables://sheets/{sheetId}.csv', {
		list: async () => ({ resources: ((await tools.call('list_sheets', {})).sheets as Array<{ id: string; name: string; rowCount: number }>).map((sheet) => ({ uri: `looot-tables://sheets/${encodeURIComponent(sheet.id)}.csv`, name: sheet.name, description: `${sheet.rowCount} rows`, mimeType: 'text/csv' })) }),
	}), { title: 'Sheet as CSV', description: 'A sheet’s visible columns as CSV.', mimeType: 'text/csv' }, async (uri, variables) => {
		const sheetId = decodeURIComponent(String(variables.sheetId));
		const exported = await tools.call('export_sheet', { sheetId, format: 'csv' });
		return { contents: [{ uri: uri.href, mimeType: 'text/csv', text: String(exported.content) }] };
	});
	for (const prompt of AGENT_PROMPTS) {
		server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description, argsSchema: prompt.args }, (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args as Record<string, string | undefined>) } }] }));
	}
	return server;
}

export async function serveMcp(request: Request, tools: SheetTools, trace?: RequestTrace) {
	const server = createMcpServer(tools, trace);
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	try {
		await server.connect(transport);
		const response = await transport.handleRequest(request);
		response.headers.set('Cache-Control', 'no-store');
		return response;
	} finally { await server.close(); }
}
