import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account } from '../../src/lib/auth-identity';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import { McpStore } from '../../src/lib/server/mcp-store';
import { McpOperations } from '../../src/lib/server/mcp-tools';
import { SpendGuard } from '../../src/lib/server/spend-guard';
import { MCP_POLICY, resolveAccess } from '../../src/lib/server/provider-access';
import type { runOp } from '../../src/lib/server/enrich';
import type { Cell, Column, Row, Sheet } from '../../src/lib/types';
import { testDatabase } from '../support/database';

const actor: Account = { issuer: 'https://admission-tests.invalid', organization: { id: 'org', name: 'org' }, user: { id: 'alice', email: 'alice@example.com', email_verified: true }, partition: 'alice' };

async function fixture(t: { after(fn: () => Promise<void>): void }, execute?: typeof runOp) {
	const { database } = await testDatabase(t);
	const sheets = new WorkspaceStore(database);
	const ops = new McpOperations(sheets, new McpStore(database, () => 'test-encryption-root-that-is-shared-across-environments'), actor, resolveAccess(MCP_POLICY, { account: actor, headers: new Headers() }), execute, undefined, new SpendGuard(database, actor));
	return { sheets, ops };
}

const columns = [
	{ id: 'site', name: 'Website', type: 'source', format: 'website' },
	{ id: 'cost', name: 'Cost', type: 'source', format: 'currency' },
	{ id: 'notes', name: 'Notes', type: 'source' },
];

test('agent writes are normalized, or refused per cell with nothing written', async (t) => {
	const { sheets, ops } = await fixture(t);
	await ops.call('create_sheet', { sheetId: 'typed', name: 'Typed', columns });
	await ops.call('upsert_rows', { sheetId: 'typed', revision: 1, rows: [{ id: 'r1', cells: { site: 'https://www.Example.com/about', cost: '$1,200' } }] });
	let current = await sheets.get(actor, 'typed');
	assert.deepEqual([current.rows[0].cells.site.v, current.rows[0].cells.cost.v], ['example.com', 1200]);
	await assert.rejects(ops.call('upsert_rows', { sheetId: 'typed', revision: 2, rows: [{ id: 'r2', cells: { site: 'n/a', cost: 'free', notes: 'ok' } }] }), (error: Error & { status?: number }) => {
		assert.equal(error.status, 422);
		assert.match(error.message, /Nothing was written: 2 values do not fit/);
		assert.match(error.message, /Row “r2”, column “Website”: “n\/a” is not a website\./);
		assert.match(error.message, /Row “r2”, column “Cost”: “free” is not an amount\./);
		return true;
	});
	await assert.rejects(ops.call('update_cells', { sheetId: 'typed', revision: 2, cells: [{ rowId: 'r1', columnId: 'site', value: 'n/a' }] }), /Row “r1”, column “Website”/);
	current = await sheets.get(actor, 'typed');
	assert.equal(current.sheet.revision, 2);
	assert.equal(current.rows.length, 1);
});

test('an MCP enrichment result the format cannot hold is saved as a failed cell', async (t) => {
	const execute: typeof runOp = async () => ({ value: 'N/A' });
	const { sheets, ops } = await fixture(t, execute);
	await ops.call('create_sheet', { sheetId: 'answers', name: 'Answers', columns: [{ id: 'company', name: 'Company', type: 'source' }], enrichments: [{ id: 'site', name: 'Website', format: 'website', op: { kind: 'ai', prompt: 'Website of {{Company}}', output: 'text', research: 'web' } }] });
	await ops.call('upsert_rows', { sheetId: 'answers', revision: 1, rows: [{ id: 'r1', cells: { company: 'Acme' } }] });
	const result = await ops.call('enrich_cells', { sheetId: 'answers', columnId: 'site', rowIds: ['r1'], idempotencyKey: 'unfit', maxUsd: 1 });
	assert.equal((result.outcomes as Array<{ status: string }>)[0].status, 'error');
	const cell = (await sheets.get(actor, 'answers')).rows[0].cells.site;
	assert.deepEqual([cell.v, cell.s], [null, 'error']);
	assert.match(cell.e ?? '', /The answer “N\/A” is not a website/);
});

test('the server refuses typed values that do not fit, checking only what changed', async (t) => {
	const { sheets } = await fixture(t);
	const sheet: Sheet = { id: 'legacy', name: 'Legacy', columns: columns.map((column) => ({ ...column, width: 180, createdAt: 1 })) as Column[], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
	const cell = (v: Cell['v']): Cell => ({ v, s: 'done', t: 1 });
	// Stored before the server checked values.
	const legacy: Row = { id: 'r1', sheetId: 'legacy', order: 0, createdAt: 1, cells: { site: cell('n/a'), cost: cell(5), notes: cell('abc') } };
	await sheets.create(actor, { sheet, rows: [legacy] });
	const edited = { ...legacy, cells: { ...legacy.cells, cost: cell(7) } };
	assert.equal((await sheets.patch(actor, 'legacy', { revision: 1, sheet, rows: [edited], deleted: [] })).revision, 2, 'an old value never blocks an unrelated edit');
	await assert.rejects(sheets.patch(actor, 'legacy', { revision: 2, sheet, rows: [{ ...edited, cells: { ...edited.cells, cost: cell('seven') } }], deleted: [] }), /Row “r1”, column “Cost”: “seven” does not fit/);
	const redefined = { ...sheet, columns: sheet.columns.map((column) => column.id === 'notes' ? { ...column, format: 'percent' as const } : column) };
	await assert.rejects(sheets.patch(actor, 'legacy', { revision: 2, sheet: redefined, rows: [], deleted: [] }), /column “Notes”: “abc” does not fit/);
	assert.equal((await sheets.get(actor, 'legacy')).sheet.revision, 2);
});
