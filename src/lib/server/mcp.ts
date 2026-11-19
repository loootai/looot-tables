import 'server-only';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { z } from 'zod';
import type { OrganizationStore } from './organization-store';
import { WorkspaceError } from '../workspace';
import { errorResponse, failureOf, newTrace, type RequestTrace } from './api-route';
import { mcpTools, McpOperations, operationGuidance } from './mcp-tools';
import { mcpAccess } from './provider-access';
import type { McpStore } from './mcp-store';
import type { WorkspaceStore } from './workspace-store';

export async function handleMcpRequest(request: Request, services: { keys: McpStore; sheets: WorkspaceStore; organization?: OrganizationStore }) {
	const trace = newTrace('mcp');
	try {
		const origin = request.headers.get('origin');
		if (origin && origin !== new URL(request.url).origin) throw new WorkspaceError('Invalid origin.', 403);
		const actor = await services.keys.authenticate(request.headers.get('authorization'));
		const access = await mcpAccess(request.headers, actor, services.organization);
		return await serveMcp(request, new McpOperations(services.sheets, services.keys, actor, access), trace);
	} catch (error) {
		const response = errorResponse(error, trace);
		if (response.status === 401) response.headers.set('WWW-Authenticate', 'Bearer realm="Enrichable MCP"');
		return response;
	}
}

export function createMcpServer(operations: McpOperations, trace: RequestTrace = newTrace('mcp')) {
	const server = new McpServer({ name: 'enrichable', version: '1.0.0' }, { instructions: operationGuidance + ' Use create_sheet for all spreadsheet creation: choose a built-in template and enrichments, or custom columns. Work on the organization’s saved sheets. You coordinate the workflow: create/import rows, configure columns, enrich prerequisites, then call enrich_cells in small batches. Read current revisions before edits. Repeat an enrichment request with its original idempotencyKey to retrieve its outcome; never automatically rerun uncertain attempts. Organization provider connections and settings are loaded automatically. Optional provider header overrides are never tool arguments. Formula sheets are read-only through MCP in this version.' });
	for (const [name, tool] of Object.entries(mcpTools)) {
		server.registerTool(name, { description: tool.description, inputSchema: tool.schema as z.ZodObject, annotations: { readOnlyHint: ['list_sheets', 'get_sheet', 'get_cell_details'].includes(name), destructiveHint: !['list_sheets', 'get_sheet', 'get_cell_details', 'create_sheet'].includes(name), openWorldHint: name === 'enrich_cells' } }, async (args) => {
			const started = performance.now();
			try {
				const data = await operations.call(name, args);
				return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
			} catch (error) {
				const data = failureOf(error, { ...trace, operation: `mcp.${name}`, started, phase: 'tool' });
				return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
			}
		});
	}
	return server;
}

export async function serveMcp(request: Request, operations: McpOperations, trace?: RequestTrace) {
	const server = createMcpServer(operations, trace);
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	try {
		await server.connect(transport);
		const response = await transport.handleRequest(request);
		response.headers.set('Cache-Control', 'no-store');
		return response;
	} finally { await server.close(); }
}
