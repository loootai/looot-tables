import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Account } from '../../src/lib/auth-identity';
import { apiRoute, provideRouteContext, UNAVAILABLE } from '../../src/lib/server/api-route';
import { workspaceId } from '../../src/lib/server/database';
import { handleMcpRequest } from '../../src/lib/server/mcp';
import { McpStore } from '../../src/lib/server/mcp-store';
import { OrganizationStore } from '../../src/lib/server/organization-store';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import { parseInput, WorkspaceError } from '../../src/lib/workspace';
import { testDatabase } from '../support/database';

const actor: Account = { issuer: 'https://routes.invalid', organization: { id: 'org', name: 'Org' }, user: { id: 'alice', email: 'alice@example.com', email_verified: true }, partition: 'alice' };
const root = 'route-tests-shared-encryption-root-value';

/** Captures storage error logs as parsed JSON. */
function logs(t: TestContext) {
	const entries: Array<Record<string, unknown>> = [];
	t.mock.method(console, 'error', (line: string) => { entries.push(JSON.parse(line)); });
	return entries;
}

test('routes keep the status of our own errors, answer 400 only for unparseable input, and log anything else as 503 under the request id', async (t) => {
	const { database } = await testDatabase(t);
	t.after(provideRouteContext((run) => run({ account: actor, database })));
	const entries = logs(t);
	const call = async (handler: () => Promise<unknown>) => {
		const response = await apiRoute('test.route', handler)(new Request('https://enrichable.test/api/test'));
		return { status: response.status, body: await response.json(), id: response.headers.get('x-request-id'), cache: response.headers.get('cache-control') };
	};
	assert.deepEqual((await call(async () => ({ value: 1 }))).body, { value: 1 });
	assert.deepEqual((await call(async () => undefined)).body, { ok: true });
	const conflict = await call(async () => { throw new WorkspaceError('Sheet changed.', 409); });
	assert.deepEqual([conflict.status, conflict.body.error, conflict.cache], [409, 'Sheet changed.', 'no-store']);
	const invalid = await call(async () => parseInput(z.object({ name: z.string() }), {}));
	assert.equal(invalid.status, 400);
	assert.equal(entries.length, 0, 'answers the caller can act on are not logged');
	const stored = await call(async () => z.object({ concurrency: z.number() }).parse({ concurrency: 'lots' }));
	assert.equal(stored.status, 503, 'a schema failure on stored data is the server’s, not the caller’s');
	const crashed = await call(async () => { throw new Error('relation "enrichable.secret" does not exist'); });
	assert.deepEqual([crashed.status, crashed.body.error, crashed.cache], [503, UNAVAILABLE, 'no-store']);
	assert.deepEqual(entries.map((entry) => [entry.operation, entry.requestId]), [['test.route', stored.id], ['test.route', crashed.id]]);
	assert.match(JSON.stringify(entries[1].error), /does not exist/);
});

test('MCP answers corrupt stored settings as unavailable, never as a caller error, and logs tool failures under the tool name', async (t) => {
	const { db, database } = await testDatabase(t);
	const keys = new McpStore(database, () => root), organization = new OrganizationStore(database, () => root);
	const failing = new WorkspaceStore(database);
	t.mock.method(failing, 'list', async () => { throw new Error('connection terminated unexpectedly'); });
	const services = { keys, sheets: failing, organization };
	const key = await keys.issueKey(actor);
	const entries = logs(t);
	const client = new Client({ name: 'route-tests', version: '1' });
	await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { requestInit: { headers: { authorization: `Bearer ${key.secret}` } }, fetch: async (input, init) => handleMcpRequest(new Request(input, init), services) }));
	t.after(() => client.close());
	const listed = await client.callTool({ name: 'list_sheets', arguments: {} });
	assert.equal(listed.isError, true);
	assert.deepEqual(listed.structuredContent, { status: 503, error: UNAVAILABLE });
	assert.deepEqual(entries.map((entry) => entry.operation), ['mcp.list_sheets']);
	await db.query('INSERT INTO enrichable.organization_settings (workspace_id, preferences) VALUES ($1, $2::jsonb)', [workspaceId(actor), JSON.stringify({ concurrency: 'lots' })]);
	const response = await handleMcpRequest(new Request('http://localhost/mcp', { method: 'POST', headers: { authorization: `Bearer ${key.secret}` } }), services);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: UNAVAILABLE });
	assert.equal(entries.at(-1)?.requestId, response.headers.get('x-request-id'));
});
