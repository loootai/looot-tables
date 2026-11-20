// End to end check of a running looot tables MCP server with the official MCP SDK client (the app's own pinned
// @modelcontextprotocol/sdk). It builds a people sheet, finds rows and runs a verified email column on 5 rows, each paid
// step behind a quote and a budget. Run it against the stand-ins in scripts/ so nothing is paid:
//   LOOOT_TABLES_MCP_URL=http://127.0.0.1:3000/mcp LOOOT_TABLES_MCP_KEY=lt_mcp_… LOOOT_TOKEN=any OPENAI_API_KEY=any node scripts/mcp-smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.LOOOT_TABLES_MCP_URL ?? 'http://127.0.0.1:3000/mcp');
const headers = { Authorization: `Bearer ${process.env.LOOOT_TABLES_MCP_KEY ?? ''}`, ...(process.env.LOOOT_TOKEN ? { 'x-looot-key': process.env.LOOOT_TOKEN } : {}), ...(process.env.OPENAI_API_KEY ? { 'x-openai-key': process.env.OPENAI_API_KEY } : {}) };
const client = new Client({ name: 'looot-tables-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));

const fail = (message) => { console.error(`FAIL ${message}`); process.exitCode = 1; };
async function call(name, args, { expectError = false } = {}) {
	const result = await client.callTool({ name, arguments: args });
	const text = result.content?.[0]?.text ?? '{}';
	let data;
	try { data = result.structuredContent ?? JSON.parse(text); } catch { data = { error: text }; }
	if (Boolean(result.isError) !== expectError) fail(`${name}: ${JSON.stringify(data).slice(0, 300)}`);
	console.log(`${expectError ? 'refused' : 'ok     '} ${name} ${JSON.stringify(data).slice(0, 140)}`);
	return data;
}
const key = (label) => `${label}-${Date.now().toString(36)}`;

const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
console.log(`tools ${tools.length} · prompts ${prompts.map((prompt) => prompt.name).join(', ')}`);
const sheetId = key('smoke');
await call('create_sheet', { sheetId, name: 'MCP smoke', template: 'people' });
await call('run_column', { maxUsd: 1, idempotencyKey: key('no-quote') }, { expectError: true });
const search = await call('quote_find_rows', { sheetId, entity: 'people', query: 'B2B SaaS, 50 to 500 people', employeesMin: 50, employeesMax: 500, jobTitle: 'Head of RevOps', limit: 10 });
const found = await call('find_rows', { quoteId: search.quoteId, maxUsd: search.maxUsd, idempotencyKey: key('find') });
const { sheet } = await call('get_sheet', { sheetId });
const columns = await call('add_contact_columns', { sheetId, revision: sheet.revision });
const columnId = columns.added[0].columnId;
const quote = await call('quote_run', { sheetId, columnId });
await call('run_column', { quoteId: quote.quoteId, maxUsd: quote.tryFirst.maxUsd / 10, idempotencyKey: key('tiny') }, { expectError: true });
const trial = await call('run_column', { quoteId: quote.quoteId, maxUsd: quote.tryFirst.maxUsd, idempotencyKey: key('trial'), rows: 5 });
const status = await call('get_run_status', { runId: trial.runId });
await call('query_rows', { sheetId, filters: [{ columnId, op: 'not_empty' }], columnIds: ['source_1', columnId] });
const csv = await client.readResource({ uri: `looot-tables://sheets/${sheetId}.csv` });
console.log(`resource ${csv.contents[0].text.split('\n').length - 1} rows of CSV`);
if (found.added !== 10) fail(`expected 10 found rows, got ${found.added}`);
if (trial.done !== 5 || trial.spentUsd > quote.tryFirst.maxUsd) fail(`trial ran ${trial.done} cells for $${trial.spentUsd}, budget $${quote.tryFirst.maxUsd}`);
console.log(`summary: ${found.added} people for $${found.spentUsd} (quote $${search.maxUsd}), emails ${trial.filled}/5 for $${trial.spentUsd} (budget $${quote.tryFirst.maxUsd}), fill rate ${status.column.fillRate}`);
await call('delete_sheet', { sheetId, revision: (await call('get_sheet', { sheetId })).sheet.revision, confirm: 'MCP smoke' });
await client.close();
