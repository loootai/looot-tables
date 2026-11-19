import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Account } from '../../src/lib/auth-identity';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import { workspaceId, type Database, type Sql } from '../../src/lib/server/database';
import { MCP_ATTEMPT_LEASE_MS, McpStore, hashMcpSecret } from '../../src/lib/server/mcp-store';
import { ENTITY_COLUMNS, type Row, type Sheet } from '../../src/lib/types';
import { McpOperations } from '../../src/lib/server/mcp-tools';
import { MCP_POLICY, mcpAccess, resolveAccess } from '../../src/lib/server/provider-access';
import { handleMcpRequest } from '../../src/lib/server/mcp';
import type { runOp } from '../../src/lib/server/enrich';
import { BUSY_MESSAGE, STALLED_ENRICHMENT_MS } from '../../src/lib/enrichment-plan';
import { inputFingerprint, inputRecord } from '../../src/lib/enrichment-freshness';
import { canonicalJson } from '../../src/lib/cell-content';
import { SHEET_DATA_VERSION } from '../../src/lib/workspace';
import { testDatabase } from '../support/database';

const actor = (org = 'one', user = 'alice'): Account => ({ issuer: 'https://mcp-tests.invalid', organization: { id: org, name: org }, user: { id: user, email: `${user}@example.com`, email_verified: true }, partition: user });
const credentials = resolveAccess(MCP_POLICY, { account: actor(), headers: new Headers() });

async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const { db, database } = await testDatabase(t);
	return { db, database, keys: new McpStore(database, () => 'test-encryption-root-that-is-shared-across-environments'), sheets: new WorkspaceStore(database) };
}

async function seed(ops: McpOperations) {
	await ops.call('create_sheet', { sheetId: 'companies', name: 'Companies', columns: [{ id: 'domain', name: 'Domain', type: 'source' }, { id: 'answer', name: 'Answer', type: 'enriched', op: { kind: 'template', template: 'Hello {{Domain}}' } }, { id: 'dependent', name: 'Dependent', type: 'enriched', op: { kind: 'template', template: '{{Answer}}!' } }] });
	await ops.call('upsert_rows', { sheetId: 'companies', revision: 1, rows: [{ id: 'r1', cells: { domain: 'example.com' } }, { id: 'r2', cells: { domain: 'other.com' } }] });
}

test('one shared organization key: hashed storage, concurrent creation, rotation, stale rotation, and tenant isolation', async (t) => {
	const { db, keys, sheets } = await fixture(t);
	const creations = await Promise.allSettled([keys.issueKey(actor()), keys.issueKey(actor('one', 'bob'))]);
	assert.equal(creations.filter((r) => r.status === 'fulfilled').length, 1);
	const first = (creations.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<McpStore['issueKey']>>>).value;
	assert.equal((await keys.keyInfo(actor('one', 'bob')))?.version, first.version);
	assert.equal('secret' in (await keys.keyInfo(actor()))!, false);
	assert.equal((await keys.revealKey(actor('one', 'bob'))).secret, first.secret);
	const stored = (await db.query('SELECT * FROM enrichable.mcp_keys')).rows[0] as Record<string, unknown>;
	assert.equal(stored.key_hash, hashMcpSecret(first.secret));
	assert.ok(!JSON.stringify(stored).includes(first.secret));
	const authenticated = await keys.authenticate(`Bearer ${first.secret}`);
	assert.equal(authenticated.organization.id, 'one');
	await seed(new McpOperations(sheets, keys, authenticated, credentials));
	const other = await keys.issueKey(actor('two'));
	const stranger = await keys.authenticate(`Bearer ${other.secret}`);
	assert.deepEqual(await sheets.list(stranger), []);
	await assert.rejects(sheets.get(stranger, 'companies'), /not found/);
	const replacement = await keys.issueKey(actor('one', 'bob'), first.version);
	await assert.rejects(keys.authenticate(`Bearer ${first.secret}`), /Invalid/);
	assert.equal((await keys.authenticate(`Bearer ${replacement.secret}`)).organization.id, 'one');
	await assert.rejects(keys.issueKey(actor(), first.version), /changed/);
	await assert.rejects(keys.issueKey(actor()), /changed/);
	await assert.rejects(keys.authenticate(null), /required/);
	await assert.rejects(keys.authenticate('Bearer invalid'), /required/);
	assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM enrichable.mcp_keys')).rows[0].count, 2);
});

test('sheet tools preserve partial edits, validate revisions, reject cycles and formula writes, and support pagination', async (t) => {
	const { keys, sheets } = await fixture(t);
	const ops = new McpOperations(sheets, keys, actor(), credentials);
	await seed(ops);
	const repeated = await ops.call('create_sheet', { sheetId: 'companies', name: 'Companies', columns: [{ id: 'domain', name: 'Domain', type: 'source' }, { id: 'answer', name: 'Answer', type: 'enriched', op: { kind: 'template', template: 'Hello {{Domain}}' } }, { id: 'dependent', name: 'Dependent', type: 'enriched', op: { kind: 'template', template: '{{Answer}}!' } }] });
	assert.equal(repeated.existing, true);
	await assert.rejects(ops.call('update_cells', { sheetId: 'companies', revision: 1, cells: [{ rowId: 'r1', columnId: 'domain', value: 'stale' }] }), /changed/);
	await ops.call('upsert_rows', { sheetId: 'companies', revision: 2, rows: [{ id: 'r1', cells: { answer: '=literal' } }] });
	let snapshot = await sheets.get(actor(), 'companies');
	assert.equal(snapshot.rows[0].cells.domain.v, 'example.com');
	assert.equal(snapshot.rows[0].cells.answer.v, '=literal');
	assert.equal(snapshot.rows[0].cells.answer.f, undefined);
	await assert.rejects(ops.call('configure_column', { sheetId: 'companies', revision: 3, column: { id: 'answer', name: 'Answer', type: 'enriched', op: { kind: 'template', template: '{{Dependent}}' } } }), /Circular/);
	await ops.call('configure_column', { sheetId: 'companies', revision: 3, column: { id: 'answer', name: 'Answer renamed', type: 'enriched', op: { kind: 'template', template: '{{Domain}} changed' } } });
	snapshot = await sheets.get(actor(), 'companies');
	assert.deepEqual([snapshot.rows[0].cells.answer.v, snapshot.rows[0].cells.answer.s], ['=literal', 'done'], 'a changed operation keeps saved values');
	assert.deepEqual(snapshot.sheet.columns[2].op, { kind: 'template', template: '{{Answer renamed}}!' });
	await assert.rejects(ops.call('upsert_rows', { sheetId: 'companies', revision: 4, rows: [{ id: 'bad', cells: { unknown: 'x' } }] }), /Unknown column/);
	await ops.call('upsert_rows', { sheetId: 'companies', revision: 4, rows: Array.from({ length: 100 }, (_, i) => ({ id: `more${i}`, cells: { domain: `${i}.com` } })) });
	const page = await ops.call('get_sheet', { sheetId: 'companies' });
	assert.equal((page.rows as unknown[]).length, 100);
	assert.equal(page.nextOffset, 100);
	assert.equal(((await ops.call('get_sheet', { sheetId: 'companies', offset: 100, revision: 5 })).rows as unknown[]).length, 2);
	snapshot = await sheets.get(actor(), 'companies');
	await sheets.patch(actor(), 'companies', { revision: 5, sheet: snapshot.sheet, rows: [{ ...snapshot.rows[0], cells: { ...snapshot.rows[0].cells, domain: { v: 2, f: '=1+1', s: 'done', t: 1 } } }], deleted: [] });
	await assert.rejects(ops.call('update_cells', { sheetId: 'companies', revision: 6, cells: [{ rowId: 'r1', columnId: 'domain', value: 3 }] }), /formulas/);
	await ops.call('delete_sheet', { sheetId: 'companies', revision: 6 });
	assert.deepEqual(await sheets.list(actor()), []);
});

test('bounded enrichment persists evidence, blocks dependencies, skips completed cells, and replays without spending again', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0;
	const execute: typeof runOp = async (_credentials, _op, row) => { calls++; return { value: `answer ${row.Domain}`, meta: { sources: ['https://example.com'], confidence: 0.9 } }; };
	const ops = new McpOperations(sheets, keys, actor(), credentials, execute);
	await seed(ops);
	const blocked = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'dependent', rowIds: ['r1'], idempotencyKey: 'blocked' });
	assert.equal((blocked.outcomes as { status: string }[])[0].status, 'blocked');
	assert.equal(calls, 0);
	const args = { sheetId: 'companies', columnId: 'answer', rowIds: ['r1', 'r2'], idempotencyKey: 'batch1' };
	const result = await ops.call('enrich_cells', args);
	assert.equal(result.status, 'finished'); assert.equal(calls, 2);
	assert.deepEqual(await ops.call('enrich_cells', args), result);
	assert.equal(calls, 2);
	await assert.rejects(ops.call('enrich_cells', { ...args, rowIds: ['r1'] }), /different arguments/);
	const skipped = await ops.call('enrich_cells', { ...args, idempotencyKey: 'batch2' });
	assert.equal((skipped.outcomes as { status: string }[])[0].status, 'skipped'); assert.equal(calls, 2);
	const detail = await ops.call('get_cell_details', { sheetId: 'companies', rowId: 'r1', columnId: 'answer' });
	const { inputFingerprint, ...evidence } = (detail.cell as { m: { inputFingerprint: string; sources: string[]; confidence: number } }).m;
	assert.match(inputFingerprint, /^v2:[a-f0-9]{16}$/);
	assert.deepEqual(evidence, { sources: ['https://example.com'], confidence: 0.9 });
	await assert.rejects(ops.call('enrich_cells', { ...args, rowIds: Array.from({ length: 6 }, (_, i) => `r${i}`) }), /Too big/);
});

test('finished cells are skipped without overwrite, each saying whether it is outdated; overwrite reruns them and a failed rerun keeps the value', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0, refuse = false;
	const execute: typeof runOp = async (_credentials, op, row) => { calls++; return refuse ? { value: null, error: 'The provider refused this request.', failure: { reason: 'provider_error', retryable: false } } : { value: `${op.kind === 'template' ? op.template : ''} ${row.Domain}` }; };
	const ops = new McpOperations(sheets, keys, actor(), credentials, execute);
	await seed(ops);
	const run = async (idempotencyKey: string, overwrite = false) => ((await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1', 'r2'], idempotencyKey, overwrite })).outcomes as Array<{ status: string; outdated?: boolean }>).map(({ status, outdated }) => outdated === undefined ? status : `${status}${outdated ? ' outdated' : ''}`);
	assert.deepEqual(await run('first'), ['done', 'done']);
	assert.deepEqual(await run('again'), ['skipped', 'skipped']);
	let { sheet, rows } = await sheets.snapshot(actor(), 'companies');
	await ops.call('configure_column', { sheetId: 'companies', revision: sheet.revision, column: { ...sheet.columns[1], op: { kind: 'template', template: 'Hi {{Domain}}' } } });
	({ sheet, rows } = await sheets.snapshot(actor(), 'companies'));
	assert.deepEqual(rows.map((row) => [row.cells.answer.v, row.cells.answer.s]), [['Hello {{Domain}} example.com', 'done'], ['Hello {{Domain}} other.com', 'done']], 'values are kept');
	assert.deepEqual(await run('new-rule'), ['skipped outdated', 'skipped outdated'], 'nothing reruns without overwrite');
	assert.equal(calls, 2);
	assert.deepEqual(await run('new-rule-overwrite', true), ['done', 'done']);
	assert.equal(calls, 4);
	({ sheet } = await sheets.snapshot(actor(), 'companies'));
	await ops.call('update_cells', { sheetId: 'companies', revision: sheet.revision, cells: [{ rowId: 'r1', columnId: 'domain', value: 'changed.com' }] });
	assert.deepEqual(await run('new-input'), ['skipped outdated', 'skipped']);
	refuse = true;
	assert.deepEqual(await run('refused', true), ['error', 'error']);
	const saved = (await sheets.snapshot(actor(), 'companies')).rows[0].cells.answer;
	assert.deepEqual([saved.v, saved.s, saved.e], ['Hi {{Domain}} example.com', 'error', 'The provider refused this request.'], 'a failed rerun keeps the previous value');
	assert.equal(calls, 6);
});

test('a finished cell that cannot run is blocked without a write, even with overwrite', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0;
	const ops = new McpOperations(sheets, keys, actor(), credentials, async () => { calls++; return { value: 'ok' }; });
	await ops.call('create_sheet', { sheetId: 'people', name: 'People', columns: [{ id: 'company', name: 'Company', type: 'source' }, { id: 'notes', name: 'Notes', type: 'source' }, { id: 'ceo', name: 'CEO', type: 'enriched', op: { kind: 'ai', prompt: 'Who runs {{Company}}? {{Notes}}', research: 'none' } }] });
	await ops.call('upsert_rows', { sheetId: 'people', revision: 1, rows: ['a', 'b', 'c'].map((id) => ({ id, cells: { company: `Co ${id}`, notes: `note ${id}` } })) });
	await ops.call('enrich_cells', { sheetId: 'people', columnId: 'ceo', rowIds: ['a', 'b', 'c'], idempotencyKey: 'first' });
	const { sheet, rows } = await sheets.get(actor(), 'people');
	// As the browser deletes a column: its cells go too.
	await sheets.patch(actor(), 'people', { revision: sheet.revision, sheet: { ...sheet, columns: sheet.columns.filter((c) => c.id !== 'notes') }, rows: rows.map((row) => ({ ...row, cells: Object.fromEntries(Object.entries(row.cells).filter(([id]) => id !== 'notes')) })), deleted: [] });
	const before = await sheets.get(actor(), 'people');
	const result = await ops.call('enrich_cells', { sheetId: 'people', columnId: 'ceo', rowIds: ['a', 'b', 'c'], idempotencyKey: 'dangling', overwrite: true });
	assert.deepEqual((result.outcomes as Array<{ status: string; error: string }>).map(({ status, error }) => [status, error]), Array(3).fill(['blocked', '{{Notes}} doesn’t match any column. Edit this column to fix it.']));
	assert.equal(calls, 3);
	assert.deepEqual(await sheets.get(actor(), 'people'), before, 'no write: every value and the revision are intact');
});

test('whole-row AI columns do not outdate each other, and a rename keeps results current: enrich_cells skips them', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0;
	const execute: typeof runOp = async (_credentials, _op, row) => { calls++; return { value: `answer ${Object.values(row).filter(Boolean).length}` }; };
	const ops = new McpOperations(sheets, keys, actor(), credentials, execute);
	await ops.call('create_sheet', { sheetId: 'leads', name: 'Leads', columns: [
		{ id: 'domain', name: 'Domain', type: 'source' },
		{ id: 'ask', name: 'Ask', type: 'enriched', op: { kind: 'ai', prompt: 'Who runs {{Domain}}?', research: 'none' } },
		{ id: 'check', name: 'Check', type: 'enriched', op: { kind: 'check', question: 'Is it B2B?', decider: 'openai' } },
	] });
	await ops.call('upsert_rows', { sheetId: 'leads', revision: 1, rows: [{ id: 'r1', cells: { domain: 'example.com' } }] });
	const run = async (columnId: string, idempotencyKey: string) => ((await ops.call('enrich_cells', { sheetId: 'leads', columnId, rowIds: ['r1'], idempotencyKey })).outcomes as Array<{ status: string }>)[0].status;
	assert.deepEqual([await run('ask', 'ask-1'), await run('check', 'check-1')], ['done', 'done']);
	assert.deepEqual([await run('ask', 'ask-2'), await run('check', 'check-2')], ['skipped', 'skipped'], 'neither answer is an input to the other');
	// A result saved before fingerprints were keyed by column ID names the columns it read: the rename restamps it.
	const saved = await sheets.snapshot(actor(), 'leads');
	const op = saved.sheet.columns[1].op!;
	const legacy = inputFingerprint(canonicalJson({ op, record: inputRecord(saved.sheet.columns, saved.rows, 0, op, 'ask') })!).replace(/^v2:/, 'v1:');
	const { revision } = await sheets.patch(actor(), 'leads', { revision: saved.sheet.revision, sheet: saved.sheet, rows: [{ ...saved.rows[0], cells: { ...saved.rows[0].cells, ask: { ...saved.rows[0].cells.ask, m: { inputFingerprint: legacy } } } }], deleted: [] });
	await ops.call('configure_column', { sheetId: 'leads', revision, column: { ...saved.sheet.columns[0], name: 'Website' } });
	const renamed = await sheets.snapshot(actor(), 'leads');
	assert.deepEqual(renamed.sheet.columns[1].op, { kind: 'ai', prompt: 'Who runs {{Website}}?', output: 'text', research: 'none' });
	assert.deepEqual([await run('ask', 'ask-3'), await run('check', 'check-3')], ['skipped', 'skipped'], 'a rename changes no input');
	assert.equal(calls, 2);
	await ops.call('update_cells', { sheetId: 'leads', revision: renamed.sheet.revision, cells: [{ rowId: 'r1', columnId: 'domain', value: 'changed.com' }] });
	const outdated = async (columnId: string, idempotencyKey: string) => ((await ops.call('enrich_cells', { sheetId: 'leads', columnId, rowIds: ['r1'], idempotencyKey })).outcomes as Array<{ outdated?: boolean }>)[0].outdated;
	assert.deepEqual([await outdated('ask', 'ask-4'), await outdated('check', 'check-4')], [true, true], 'a source value is an input to both');
	assert.equal(calls, 2);
});

test('a write landing while MCP reads a sheet of more than 100 rows neither fails the batch nor loses its result', async (t) => {
	const { database, keys } = await fixture(t);
	// Another tab saves a cell right after MCP's next read of the sheet's rows: paged reads used to straddle it and fail with 409.
	let interleave: (() => Promise<unknown>) | undefined, interleaved: Promise<unknown> | undefined;
	const sheets = new WorkspaceStore({ ...database, read: async (text, values) => {
		const result = await database.read(text, values);
		if (interleave && /^\s*SELECT/.test(text) && text.includes('enrichable.sheet_rows')) { interleaved = interleave(); interleave = undefined; }
		return result;
	} });
	const tab = actor('one', 'bob');
	const raw = new WorkspaceStore(database);
	const execute: typeof runOp = async (_credentials, _op, row) => {
		interleave = async () => {
			const { sheet, rows: [other] } = await raw.get(tab, 'companies');
			return raw.patch(tab, 'companies', { revision: sheet.revision, sheet, rows: [{ ...other, cells: { ...other.cells, domain: { v: 'tab.example', s: 'done', t: Date.now() } } }], deleted: [] });
		};
		return { value: `answer ${row.Domain}` };
	};
	const ops = new McpOperations(sheets, keys, actor(), credentials, execute);
	await seed(ops);
	await ops.call('upsert_rows', { sheetId: 'companies', revision: 2, rows: Array.from({ length: 100 }, (_, i) => ({ id: `more${i}`, cells: { domain: `${i}.example` } })) });
	const result = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['more99'], idempotencyKey: 'interleaved' });
	await interleaved;
	assert.ok(interleaved, 'the other tab wrote during the batch');
	assert.equal(result.status, 'finished');
	assert.deepEqual((result.outcomes as Array<{ status: string }>).map((outcome) => outcome.status), ['done']);
	const { rows } = await sheets.snapshot(actor(), 'companies');
	assert.equal(rows.length, 102);
	assert.deepEqual([rows[0].cells.domain.v, rows[101].cells.answer.v], ['tab.example', 'answer 99.example'], 'both the tab’s write and the result are saved');
});

test('concurrent MCP batches are limited and a human edit during execution is preserved', async (t) => {
	const { keys, sheets } = await fixture(t);
	let started!: () => void, release!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const wait = new Promise<void>((resolve) => { release = resolve; });
	const execute: typeof runOp = async () => { started(); await wait; return { value: 'old result' }; };
	const ops = new McpOperations(sheets, keys, actor(), credentials, execute);
	await seed(ops);
	const running = ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1'], idempotencyKey: 'inflight' });
	await ready;
	assert.equal((await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1'], idempotencyKey: 'other' })).status, 'busy');
	const { sheet } = await sheets.get(actor(), 'companies');
	await ops.call('update_cells', { sheetId: 'companies', revision: sheet.revision, cells: [{ rowId: 'r1', columnId: 'answer', value: 'human edit' }] });
	release();
	const result = await running;
	assert.equal((result.outcomes as { status: string }[])[0].status, 'conflict');
	assert.equal((await sheets.get(actor(), 'companies')).rows[0].cells.answer.v, 'human edit');
});

test('interrupted requests become uncertain once the function limit has passed and cannot be replayed automatically', async (t) => {
	const { keys } = await fixture(t);
	assert.ok(MCP_ATTEMPT_LEASE_MS > 300_000 && MCP_ATTEMPT_LEASE_MS < 600_000, 'the lease follows the route maxDuration');
	assert.equal((await keys.claim(actor(), 'lost', 'hash', 1)).claimed, true);
	assert.equal((await keys.claim(actor(), 'lost', 'hash', 300_001)).status, 'running', 'a request may still be alive within maxDuration');
	assert.equal((await keys.claim(actor(), 'other', 'hash3', 300_001)).status, 'busy');
	assert.equal((await keys.claim(actor(), 'lost', 'hash', MCP_ATTEMPT_LEASE_MS + 2)).status, 'uncertain');
	assert.equal((await keys.claim(actor(), 'next', 'hash2', MCP_ATTEMPT_LEASE_MS + 3)).claimed, true);
});

test('agents get the browser’s retry rule: a provider failure after the request was sent is not retryable', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: 'upstream failed' }, { status: 503 }); });
	const access = resolveAccess(MCP_POLICY, { account: actor(), headers: new Headers({ 'x-looot-key': 'test-looot' }) });
	const ops = new McpOperations(sheets, keys, actor(), access);
	await seed(ops);
	await ops.call('configure_column', { sheetId: 'companies', revision: 2, column: { id: 'site', name: 'Site', type: 'enriched', op: { kind: 'search', query: 'retry rule {{Domain}}', pick: 'url', numResults: 1 } } });
	const result = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'site', rowIds: ['r1'], idempotencyKey: 'provider-failure' });
	const [outcome] = result.outcomes as Array<{ status: string; failure?: unknown }>;
	assert.deepEqual([outcome.status, outcome.failure, calls], ['error', { reason: 'provider_error', retryable: false, provider: 'looot' }, 1]);
});

test('rows start only when their worst case ends before the function limit, and failures stay structured', async (t) => {
	const { keys, sheets } = await fixture(t);
	let clock = 0, step = 100_000;
	const execute: typeof runOp = async (_credentials, _op, row) => {
		clock += step;
		return row.Domain === 'example.com' ? { value: null, error: 'Rate limited (429). Wait a moment and try again.', failure: { reason: 'rate_limited', retryable: true } } : { value: `answer ${row.Domain}` };
	};
	const ops = new McpOperations(sheets, keys, actor(), credentials, execute, () => clock);
	await seed(ops);
	await ops.call('upsert_rows', { sheetId: 'companies', revision: 2, rows: ['r3', 'r4'].map((id) => ({ id, cells: { domain: `${id}.example` } })) });
	const result = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1', 'r2', 'r3', 'r4'], idempotencyKey: 'deadline' });
	const outcomes = result.outcomes as Array<{ rowId: string; status: string; failure?: unknown }>;
	assert.deepEqual(outcomes.map((o) => o.status), ['error', 'done', 'done', 'not_started']);
	assert.deepEqual(outcomes[0].failure, { reason: 'rate_limited', retryable: true });
	assert.equal(outcomes[1].failure, undefined);
	const { sheet } = await sheets.get(actor(), 'companies');
	await ops.call('configure_column', { sheetId: 'companies', revision: sheet.revision, column: { id: 'research', name: 'Research', type: 'enriched', op: { kind: 'answer', task: 'About {{Domain}}' } } });
	clock = 0; step = 160_000;
	const slow = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'research', rowIds: ['r2', 'r3', 'r4'], idempotencyKey: 'slow' });
	assert.deepEqual((slow.outcomes as Array<{ status: string }>).map((o) => o.status), ['done', 'not_started', 'not_started'], 'a 130 s operation cannot start after 160 s');
});

test('real MCP client discovers and calls tools over stateless HTTP; auth and origin checks apply', async (t) => {
	const services = await fixture(t);
	const key = await services.keys.issueKey(actor());
	const url = new URL('http://localhost/mcp');
	const noAuth = await handleMcpRequest(new Request(url, { method: 'POST' }), services);
	assert.equal(noAuth.status, 401); assert.ok(noAuth.headers.get('www-authenticate'));
	const badOrigin = await handleMcpRequest(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${key.secret}`, origin: 'https://evil.invalid' } }), services);
	assert.equal(badOrigin.status, 403);
	const client = new Client({ name: 'mcp-integration-test', version: '1.0.0' });
	const transport = new StreamableHTTPClientTransport(url, {
		requestInit: { headers: { Authorization: `Bearer ${key.secret}` } },
		fetch: async (input, init) => handleMcpRequest(new Request(input, init), services),
	});
	await client.connect(transport);
	t.after(() => client.close());
	const tools = await client.listTools();
	assert.equal(tools.tools.length, 10);
	assert.ok(tools.tools.find((tool) => tool.name === 'configure_column')?.inputSchema.properties);
	const created = await client.callTool({ name: 'create_sheet', arguments: { sheetId: 'native', name: 'Agent created', columns: [{ id: 'name', name: 'Name', type: 'source' }] } });
	assert.ok(!created.isError);
	const written = await client.callTool({ name: 'upsert_rows', arguments: { sheetId: 'native', revision: 1, rows: [{ id: 'r1', cells: { name: 'From the agent' } }] } });
	assert.ok(!written.isError);
	const listed = await client.callTool({ name: 'get_sheet', arguments: { sheetId: 'native' } });
	assert.equal(((listed.structuredContent as { rows: { cells: { name: { v: string } } }[] }).rows[0].cells.name.v), 'From the agent');
	const configured = await client.callTool({ name: 'configure_column', arguments: { sheetId: 'native', revision: 2, column: { id: 'greeting', name: 'Greeting', type: 'enriched', op: { kind: 'template', template: 'Hello {{Name}}' } } } });
	assert.ok(!configured.isError);
	const enrichmentArgs = { sheetId: 'native', columnId: 'greeting', rowIds: ['r1'], idempotencyKey: 'native-enrichment' };
	const enriched = await client.callTool({ name: 'enrich_cells', arguments: enrichmentArgs });
	assert.equal((enriched.structuredContent as { outcomes: { cell: { v: string } }[] }).outcomes[0].cell.v, 'Hello From the agent');
	const replayed = await client.callTool({ name: 'enrich_cells', arguments: enrichmentArgs });
	assert.deepEqual(replayed.structuredContent, enriched.structuredContent);
	const invalid = await client.callTool({ name: 'update_cells', arguments: { sheetId: 'native', revision: 1, cells: [{ rowId: 'r1', columnId: 'name', value: 'stale' }] } });
	assert.equal(invalid.isError, true);
	const preset = await client.callTool({ name: 'create_sheet', arguments: { sheetId: 'preset', name: 'Preset over SDK', template: 'companies', enrichments: [{ id: 'industry', name: 'Industry', op: { kind: 'company', domain: '{{Website}}', field: 'industry' } }] } });
	assert.ok(!preset.isError);
	assert.equal((preset.structuredContent as { sheet: { columns: { id: string }[] } }).sheet.columns.length, ENTITY_COLUMNS.companies.length);
	assert.match(client.getInstructions() ?? '', /Prefer Enrichable built-in operations/);
	await services.keys.issueKey(actor(), key.version);
	const revoked = await handleMcpRequest(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${key.secret}` } }), services);
	assert.equal(revoked.status, 401);
});

test('MCP credentials never inherit browser cookies or deployment keys and reject unsafe URLs', async () => {
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = 'deployment-secret';
	try {
		const credentials = await mcpAccess(new Headers({ cookie: 'enrichable.session=browser-credential', 'x-enrichable-password': 'deployment-password' }), actor());
		assert.equal(credentials.key('openai'), null);
		assert.equal(credentials.key('looot'), null);
		assert.equal((await mcpAccess(new Headers({ 'x-openai-key': 'caller-key' }), actor())).key('openai'), 'caller-key');
		await assert.rejects(mcpAccess(new Headers({ 'x-openai-base-url': 'http://169.254.169.254/latest' }), actor()), /public/);
		await assert.rejects(mcpAccess(new Headers({ 'x-openai-base-url': 'file:///etc/passwd' }), actor()), /public/);
	} finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});


test('keys sealed before the shared envelope still reveal', async (t) => {
	const { db, keys } = await fixture(t);
	// Written by the previous McpStore.encrypt for actor('legacy') under the fixture root.
	const secret = `enr_mcp_${'L'.repeat(43)}`, version = '00000000-0000-4000-8000-000000000001';
	const sealed = 'v1.-JCHFggS9xkWAr7Y.6FPcTsLE1wD7xzg0k2jBAA.nYrBkzrU39PYiQsOP1FkcWsM_6Z6oPDV3e19BYpnvGNWDTZDE7uSo6psO3l9R2OwTPKU';
	await db.query("INSERT INTO enrichable.workspaces (id,issuer,organization_id,name) VALUES ($1,'https://mcp-tests.invalid','legacy','legacy')", [workspaceId(actor('legacy'))]);
	await db.query('INSERT INTO enrichable.mcp_keys (workspace_id,key_hash,prefix,version,created_at,encrypted_secret) VALUES ($1,$2,$3,$4,1,$5)', [workspaceId(actor('legacy')), hashMcpSecret(secret), secret.slice(0, 16), version, sealed]);
	assert.equal((await keys.revealKey(actor('legacy'))).secret, secret);
});

test('recoverable keys survive server reload, isolate tenants, authenticate ciphertext and preserve hash-only keys during backfill', async (t) => {
	const { db, keys, database } = await fixture(t);
	const first = await keys.issueKey(actor());
	const reloaded = new McpStore(database, () => 'test-encryption-root-that-is-shared-across-environments');
	assert.equal((await reloaded.revealKey(actor('one', 'bob'))).secret, first.secret);
	await assert.rejects(keys.revealKey(actor('two')), /No organization key/);
	await assert.rejects(new McpStore(database, () => 'wrong-secret-that-is-at-least-32-characters').revealKey(actor()), /could not be decrypted/);
	await assert.rejects(new McpStore(database, () => undefined).issueKey(actor('unconfigured')), /Configure the shared/);
	await db.query('UPDATE enrichable.mcp_keys SET encrypted_secret=NULL');
	assert.equal((await keys.keyInfo(actor()))?.recoverable, false);
	await assert.rejects(keys.revealKey(actor()), /legacy key/);
	await assert.rejects(keys.backfillKey(actor(), 'incorrect'), /not the active/);
	await keys.backfillKey(actor('one', 'bob'), first.secret);
	assert.equal((await keys.revealKey(actor())).secret, first.secret);
	assert.equal((await keys.keyInfo(actor()))?.version, first.version);
	assert.equal((await keys.authenticate(`Bearer ${first.secret}`)).organization.id, 'one');
	const other = await keys.issueKey(actor('two'));
	await db.query('UPDATE enrichable.mcp_keys SET encrypted_secret=(SELECT encrypted_secret FROM enrichable.mcp_keys WHERE key_hash=$1) WHERE key_hash=$2', [hashMcpSecret(other.secret), hashMcpSecret(first.secret)]);
	await assert.rejects(keys.revealKey(actor()), /could not be decrypted/);
});

test('invalid references and targets fail before execution and validation replay retains its error', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0;
	const ops = new McpOperations(sheets, keys, actor(), credentials, async () => { calls++; return { value: 'ok' }; });
	await seed(ops);
	await assert.rejects(ops.call('configure_column', { sheetId: 'companies', revision: 2, column: { id: 'bad', name: 'Bad', type: 'enriched', op: { kind: 'template', template: '{{Missing}}' } } }), /Unresolved column/);
	const args = { sheetId: 'companies', columnId: 'answer', rowIds: ['r1', 'missing'], idempotencyKey: 'invalid-targets' };
	await assert.rejects(ops.call('enrich_cells', args), /Unknown row/);
	await assert.rejects(ops.call('enrich_cells', args), /Unknown row/);
	assert.equal(calls, 0);
	assert.equal((await sheets.get(actor(), 'companies')).sheet.revision, 2);
});


test('a reference left dangling by a browser deletion blocks only its own column, and new definitions follow each operation’s rules', async (t) => {
	const { keys, sheets } = await fixture(t);
	const ops = new McpOperations(sheets, keys, actor(), credentials, async () => ({ value: 'ok' }));
	await seed(ops);
	const { sheet, rows } = await sheets.get(actor(), 'companies');
	// As the browser deletes a column: its cells go too.
	const stripped = rows.map((row) => ({ ...row, cells: Object.fromEntries(Object.entries(row.cells).filter(([id]) => id !== 'domain')) }));
	await sheets.patch(actor(), 'companies', { revision: 2, sheet: { ...sheet, columns: sheet.columns.filter((c) => c.id !== 'domain') }, rows: stripped, deleted: [] });
	await ops.call('configure_column', { sheetId: 'companies', revision: 3, column: { id: 'greeting', name: 'Greeting', type: 'enriched', op: { kind: 'template', template: 'Hi {{Dependent}}' } } });
	const rejected: Array<[Record<string, unknown>, RegExp]> = [
		[{ id: 'answer', name: 'Answer', type: 'enriched', op: { kind: 'template', template: 'Hello {{Domain}}' } }, /Unresolved column reference: Domain/],
		[{ id: 'page', name: 'Page', type: 'enriched', op: { kind: 'scrape', page: { type: 'template', template: 'https://example.com' }, mode: 'extract' } }, /Add a field or instructions to extract/],
		[{ id: 'copy', name: ' greeting ', type: 'source' }, /unique/],
	];
	for (const [column, error] of rejected) await assert.rejects(ops.call('configure_column', { sheetId: 'companies', revision: 4, column }), error);
	// As in the browser: the cell fails with the same message, and nothing runs.
	const result = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1'], idempotencyKey: 'dangling' });
	const [outcome] = result.outcomes as Array<{ status: string; error: string; cell: { s: string; e: string } }>;
	assert.equal(outcome.status, 'error');
	assert.equal(outcome.error, '{{Domain}} doesn’t match any column. Edit this column to fix it.');
	const saved = (await sheets.get(actor(), 'companies')).rows[0].cells.answer;
	assert.deepEqual([saved.s, saved.e], ['error', outcome.error]);
});

test('one create_sheet tool reuses app layouts, merges built-in enrichments, validates references and retries safely', async (t) => {
	const { keys, sheets } = await fixture(t);
	const ops = new McpOperations(sheets, keys, actor(), credentials);
	for (const template of ['companies', 'people', 'websites'] as const) {
		const args = { sheetId: template, name: template, template };
		const created = await ops.call('create_sheet', args);
		const sheet = created.sheet as { columns: { id: string; name: string; format?: string }[] };
		assert.deepEqual(sheet.columns.map(({ name, format }) => ({ name, format })), ENTITY_COLUMNS[template].map(({ name, format }) => ({ name, format })));
		assert.equal((await ops.call('create_sheet', args)).existing, true);
	}
	// Agent sheets are stamped as current, so the browser never renames a Domain column an agent chose.
	const blank = (await ops.call('create_sheet', { sheetId: 'blank', name: 'Blank' })).sheet as { columns: { name: string }[]; dataVersion?: number };
	assert.deepEqual([blank.columns.map(({ name }) => name), blank.dataVersion], [['Name', 'Website'], SHEET_DATA_VERSION]);
	const own = (await ops.call('create_sheet', { sheetId: 'own', name: 'Own', columns: [{ id: 'domain', name: 'Domain', type: 'source' }] })).sheet as { dataVersion?: number };
	assert.equal(own.dataVersion, SHEET_DATA_VERSION);
	const args = { sheetId: 'builtins', name: 'Built-in flow', template: 'companies', enrichments: [
		{ id: 'industry', name: 'Industry', op: { kind: 'company', field: 'industry', domain: '{{Website}}' } },
		{ id: 'greeting', name: 'Greeting', op: { kind: 'template', template: 'Hello {{Company}}' } },
		{ id: 'dependent', name: 'Dependent', op: { kind: 'template', template: '{{Greeting}}!' } },
	] };
	const created = await ops.call('create_sheet', args);
	const columns = (created.sheet as { columns: { id: string; name: string; type: string }[] }).columns;
	assert.equal(columns.length, ENTITY_COLUMNS.companies.length + 2);
	assert.equal(columns.filter((c) => c.name === 'Industry').length, 1);
	assert.equal(columns.find((c) => c.id === 'industry')?.type, 'enriched');
	assert.match(String(created.operationGuidance), /Prefer Enrichable built-in operations/);
	assert.ok((created.availableOperations as Record<string, unknown>).company);
	assert.equal((await ops.call('create_sheet', args)).existing, true);
	await assert.rejects(ops.call('create_sheet', { ...args, name: 'Changed' }), /different configuration/);
	await ops.call('upsert_rows', { sheetId: 'builtins', revision: 1, rows: [{ id: 'builtin-row', cells: { source_1: 'Acme' } }] });
	const run = await ops.call('enrich_cells', { sheetId: 'builtins', columnId: 'greeting', rowIds: ['builtin-row'], idempotencyKey: 'built-in-template' });
	assert.equal((run.outcomes as { cell: { v: string } }[])[0].cell.v, 'Hello Acme');
	const listed = await ops.call('list_sheets', {});
	const summary = (listed.sheets as { id: string; columns: unknown[]; sheet?: unknown }[]).find((s) => s.id === 'builtins')!;
	assert.equal(summary.sheet, undefined);
	assert.equal('op' in (summary.columns[0] as object), false);
	const detailed = await ops.call('list_sheets', { includeDefinitions: true });
	assert.ok((detailed.sheets as { sheet: { id: string } }[]).some((entry) => entry.sheet.id === 'builtins'));
	await assert.rejects(ops.call('create_sheet', { sheetId: 'invalid-preset', name: 'Invalid', template: 'companies', enrichments: [{ id: 'bad', name: 'Bad', op: { kind: 'template', template: '{{Unknown}}' } }] }), /Unresolved/);
	await assert.rejects(ops.call('create_sheet', { sheetId: 'duplicate-enrichments', name: 'Invalid', enrichments: [{ id: 'a', name: 'Greeting', op: { kind: 'template', template: 'A' } }, { id: 'b', name: 'Greeting', op: { kind: 'template', template: 'B' } }] }), /must be unique/);
});

test('pagination ends at exactly 100 and 200 rows without advertising an empty next page', async (t) => {
	const { keys, sheets } = await fixture(t);
	const ops = new McpOperations(sheets, keys, actor(), credentials);
	await ops.call('create_sheet', { sheetId: 'pages', name: 'Pages' });
	assert.equal((await ops.call('get_sheet', { sheetId: 'pages' })).nextOffset, null);
	for (const [batch, expectedRevision] of [[0, 1], [1, 2]]) {
		await ops.call('upsert_rows', { sheetId: 'pages', revision: expectedRevision, rows: Array.from({ length: 100 }, (_, i) => ({ id: `page-${batch * 100 + i}`, cells: { source_1: String(i) } })) });
		const last = await ops.call('get_sheet', { sheetId: 'pages', offset: batch * 100 });
		assert.equal((last.rows as unknown[]).length, 100);
		assert.equal(last.nextOffset, null);
	}
	assert.equal((await ops.call('get_sheet', { sheetId: 'pages' })).nextOffset, 100);
});


test('MCP column inputs preserve shared column refinements and support category columns', async (t) => {
	const { keys, sheets } = await fixture(t);
	const ops = new McpOperations(sheets, keys, actor(), credentials);
	await assert.rejects(ops.call('create_sheet', { sheetId: 'bad-category', name: 'Category', columns: [{ id: 'status', name: 'Status', type: 'source', format: 'category' }] }), /Add at least one category/);
	await ops.call('create_sheet', { sheetId: 'categories', name: 'Category', columns: [{ id: 'status', name: 'Status', type: 'source', format: 'category', categoryOptions: ['New', 'Done'] }] });
	await assert.rejects(ops.call('configure_column', { sheetId: 'categories', revision: 1, column: { id: 'status', name: 'Status', type: 'source', format: 'category' } }), /Add at least one category/);
	await assert.rejects(ops.call('create_sheet', { sheetId: 'bad-enrichment-category', name: 'Category', enrichments: [{ id: 'status', name: 'Status', format: 'category', op: { kind: 'template', template: 'New' } }] }), /Add at least one category/);
	const result = await ops.call('get_sheet', { sheetId: 'categories' });
	assert.deepEqual((result.sheet as { columns: { categoryOptions: string[] }[] }).columns[0].categoryOptions, ['New', 'Done']);
});

test('MCP enriches source names in place, preserves supplied spelling, and replays without spending again', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0;
	const execute: typeof runOp = async (_credentials, op, row) => {
		calls++;
		assert.deepEqual(op, { kind: 'person', field: 'full_name', name: '{{Name}}', company: '{{Company}}', email: undefined, profileUrl: '{{LinkedIn}}' });
		assert.equal(row.Name, 'Dominik Koch');
		return { value: 'Dominik K.', meta: { person: { name: 'Dominik K.', avatarUrl: 'https://cdn.example/dominik.png' }, sources: ['https://linkedin.com/in/dominikkoch'] } };
	};
	const ops = new McpOperations(sheets, keys, actor(), credentials, execute);
	await ops.call('create_sheet', { sheetId: 'people', name: 'People', template: 'people' });
	const initial = await sheets.get(actor(), 'people');
	const column = (name: string) => initial.sheet.columns.find(c => c.name === name)!.id;
	await ops.call('upsert_rows', { sheetId: 'people', revision: initial.sheet.revision, rows: [{ id: 'dominik', cells: { [column('Name')]: 'Dominik Koch', [column('Company')]: 'Notra', [column('LinkedIn')]: 'https://linkedin.com/in/dominikkoch' } }] });
	const args = { sheetId: 'people', columnId: column('Name'), rowIds: ['dominik'], idempotencyKey: 'person-photo' };
	const result = await ops.call('enrich_cells', args);
	assert.equal(result.status, 'finished');
	assert.deepEqual(await ops.call('enrich_cells', args), result);
	await ops.call('enrich_cells', { ...args, idempotencyKey: 'already-enriched' });
	assert.equal(calls, 1);
	const current = await sheets.get(actor(), 'people');
	assert.equal(current.sheet.columns.length, initial.sheet.columns.length);
	assert.equal(current.sheet.columns[0].name, 'Name');
	assert.equal(current.rows[0].cells[column('Name')].v, 'Dominik Koch');
	assert.deepEqual(current.rows[0].cells[column('Name')].m?.person, { name: 'Dominik Koch', avatarUrl: 'https://cdn.example/dominik.png' });
});

test('MCP marks cells running while it works, so browser tabs see agent progress, and restores them when a run breaks', async (t) => {
	const { keys, sheets } = await fixture(t);
	const seen: Array<{ v: unknown; s: string }> = [];
	let fail = false;
	const execute: typeof runOp = async (_credentials, _op, row) => {
		const cell = (await sheets.get(actor(), 'companies')).rows[0].cells.answer;
		seen.push({ v: cell.v, s: cell.s });
		if (fail) throw new Error('Provider connection dropped');
		return { value: `fresh ${row.Domain}` };
	};
	const ops = new McpOperations(sheets, keys, actor(), credentials, execute);
	await seed(ops);
	await ops.call('update_cells', { sheetId: 'companies', revision: 2, cells: [{ rowId: 'r1', columnId: 'answer', value: 'previous' }] });
	const result = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1'], idempotencyKey: 'marker', overwrite: true });
	assert.deepEqual(seen, [{ v: 'previous', s: 'running' }], 'the running cell keeps its previous value while the agent works');
	assert.equal((result.outcomes as Array<{ status: string }>)[0].status, 'done');
	assert.equal((await sheets.get(actor(), 'companies')).rows[0].cells.answer.v, 'fresh example.com');
	fail = true;
	const broken = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1'], idempotencyKey: 'broken', overwrite: true });
	assert.equal(broken.status, 'uncertain');
	const restored = (await sheets.get(actor(), 'companies')).rows[0].cells.answer;
	assert.deepEqual([restored.s, restored.v], ['done', 'fresh example.com'], 'a broken run does not leave the cell running');
});

test('a running cell blocks MCP until the shared expiry rule says its run was abandoned', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0;
	const ops = new McpOperations(sheets, keys, actor(), credentials, async (_credentials, _op, row) => { calls++; return { value: `answer ${row.Domain}` }; });
	await seed(ops);
	const { sheet, rows } = await sheets.get(actor(), 'companies');
	const abandoned = Date.now() - STALLED_ENRICHMENT_MS - 1;
	const running = (rowIndex: number, t: number) => ({ ...rows[rowIndex], cells: { ...rows[rowIndex].cells, answer: { v: 'before', s: 'running' as const, t } } });
	// A closed browser tab left r1 running long ago; r2 is running right now somewhere else.
	await sheets.patch(actor(), 'companies', { revision: sheet.revision, sheet, rows: [running(0, abandoned), running(1, Date.now())], deleted: [] });
	const result = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1', 'r2'], idempotencyKey: 'expiry', overwrite: true });
	const outcomes = result.outcomes as Array<{ status: string; error?: string; cell?: { v: string } }>;
	assert.deepEqual(outcomes.map((o) => o.status), ['done', 'blocked']);
	assert.equal(outcomes[0].cell?.v, 'answer example.com');
	assert.equal(outcomes[1].error, BUSY_MESSAGE);
	assert.equal(calls, 1);
	// A dependency that was abandoned mid-run counts as failed, as it does in the browser.
	const current = await sheets.get(actor(), 'companies');
	await sheets.patch(actor(), 'companies', { revision: current.sheet.revision, sheet: current.sheet, rows: [running(1, abandoned)], deleted: [] });
	const dependent = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'dependent', rowIds: ['r2'], idempotencyKey: 'expired-dependency' });
	assert.deepEqual((dependent.outcomes as Array<{ status: string; error: string }>)[0], { rowId: 'r2', status: 'error', error: 'Waiting on "Answer", which failed', cell: (await sheets.get(actor(), 'companies')).rows[1].cells.dependent });
	assert.equal(calls, 1);
});

test('a sheet an agent created before Website replaced Domain is upgraded when MCP reads it, so references and retries match', async (t) => {
	const { keys, sheets } = await fixture(t);
	let calls = 0;
	const ops = new McpOperations(sheets, keys, actor(), credentials, async () => { calls++; return { value: 'ok' }; });
	const column = (id: string, name: string, extra: object = {}) => ({ id, name, type: 'source', width: 180, createdAt: 1, ...extra });
	// As create_sheet made a blank sheet before this release: unstamped, with a Domain column.
	await sheets.create(actor(), { sheet: { id: 'blank', name: 'Blank', columns: [column('source_1', 'Name'), column('source_2', 'Domain', { format: 'url' })], filters: [], sort: null, createdAt: 1, updatedAt: 1 }, rows: [] });
	const retried = await ops.call('create_sheet', { sheetId: 'blank', name: 'Blank' });
	assert.equal(retried.existing, true, 'a retry of the same create_sheet call matches');
	assert.deepEqual([(retried.sheet as Sheet).columns.map((c) => c.name), (retried.sheet as Sheet).dataVersion], [['Name', 'Website'], SHEET_DATA_VERSION]);
	// A greeting saved by the previous implementation, fingerprinted by column name.
	const op = { kind: 'template' as const, template: 'Hi {{Domain}}' };
	const legacy = inputFingerprint(canonicalJson({ op, record: { Domain: 'acme.com' } })!).replace(/^v2:/, 'v1:');
	await sheets.create(actor(), { sheet: { id: 'greetings', name: 'Greetings', columns: [column('domain', 'Domain', { format: 'url' }), { ...column('greeting', 'Greeting'), type: 'enriched', op }], filters: [], sort: null, createdAt: 1, updatedAt: 1 }, rows: [{ id: 'r1', sheetId: 'greetings', order: 0, createdAt: 1, cells: { domain: { v: 'acme.com', s: 'done', t: 1 }, greeting: { v: 'Hi acme.com', s: 'done', m: { inputFingerprint: legacy }, t: 2 } } }] });
	const read = await ops.call('get_sheet', { sheetId: 'greetings' });
	assert.deepEqual((read.sheet as Sheet).columns.map((c) => [c.name, c.op]), [['Website', undefined], ['Greeting', { kind: 'template', template: 'Hi {{Website}}' }]]);
	assert.match((read.rows as Row[])[0].cells.greeting.m!.inputFingerprint!, /^v2:/);
	await ops.call('configure_column', { sheetId: 'greetings', revision: (read.sheet as Sheet).revision, column: { id: 'welcome', name: 'Welcome', type: 'enriched', op: { kind: 'template', template: 'Welcome {{Website}}' } } });
	const outcome = ((await ops.call('enrich_cells', { sheetId: 'greetings', columnId: 'greeting', rowIds: ['r1'], idempotencyKey: 'upgraded' })).outcomes as Array<{ status: string; outdated?: boolean }>)[0];
	assert.deepEqual([outcome.status, outcome.outdated, calls], ['skipped', false, 0], 'the upgrade keeps the result current');
});

test('a paid result is saved however many unrelated writes land while it settles, and a broken run’s marker is always cleared', async (t) => {
	const { database, keys } = await fixture(t);
	const tab = actor('one', 'bob'), raw = new WorkspaceStore(database);
	let settling = false, fail = false, writes = 0;
	const pending: Promise<unknown>[] = [];
	// Another tab keeps saving an unrelated cell: right after each read of the sheet, and while a write transaction runs.
	const unrelated = async () => {
		const { sheet, rows: [, other] } = await raw.get(tab, 'companies');
		await raw.patch(tab, 'companies', { revision: sheet.revision, sheet, rows: [{ ...other, cells: { ...other.cells, domain: { v: `tab${++writes}.example`, s: 'done', t: Date.now() } } }], deleted: [] });
	};
	const sheets = new WorkspaceStore({
		read: async (text, values) => {
			const result = await database.read(text, values);
			if (settling && text.includes('enrichable.sheet_rows')) await unrelated();
			return result;
		},
		transaction: ((run: (sql: Sql, workspace: string) => Promise<unknown>, options?: { workspace: Account }) => database.transaction(async (sql, workspace) => {
			if (settling && options?.workspace) pending.push(unrelated());
			return run(sql, workspace);
		}, options!)) as Database['transaction'],
	});
	const ops = new McpOperations(sheets, keys, actor(), credentials, async (_credentials, _op, row) => {
		settling = true;
		if (fail) throw new Error('Provider connection dropped');
		return { value: `paid answer for ${row.Domain}` };
	});
	await seed(ops);
	const result = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1'], idempotencyKey: 'busy-sheet' });
	settling = false;
	await Promise.all(pending);
	assert.deepEqual((result.outcomes as Array<{ status: string }>).map((outcome) => outcome.status), ['done']);
	let { rows } = await raw.snapshot(actor(), 'companies');
	assert.equal(rows[0].cells.answer.v, 'paid answer for example.com', 'the result is not lost to revision conflicts');
	assert.ok(writes >= 1 && rows[1].cells.domain.v === `tab${writes}.example`, 'every unrelated write landed too');
	fail = true;
	const broken = await ops.call('enrich_cells', { sheetId: 'companies', columnId: 'answer', rowIds: ['r1'], idempotencyKey: 'busy-broken', overwrite: true });
	settling = false;
	await Promise.all(pending);
	assert.equal(broken.status, 'uncertain');
	({ rows } = await raw.snapshot(actor(), 'companies'));
	assert.deepEqual([rows[0].cells.answer.s, rows[0].cells.answer.v], ['done', 'paid answer for example.com'], 'the running marker is cleared');
});
