import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Account } from '../../src/lib/auth-identity';
import { McpStore } from '../../src/lib/server/mcp-store';
import { MCP_POLICY, resolveAccess } from '../../src/lib/server/provider-access';
import { AGENT_TOOL_NAMES, SheetTools } from '../../src/lib/server/sheet-tools';
import { SHEET_TOOLS, TOOL_NAMES } from '../../src/lib/server/tool-specs';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import { testDatabase } from '../support/database';
import { startStandIn } from '../support/stand-ins';

/* The tool layer both front doors share, against the looot and MoltSets stand-ins in scripts/: no real provider is called
   and nothing is paid. The money rules: a paid run needs a quote and a budget, the budget and the sheet cap hold, free
   tools run without either. */

const actor: Account = { issuer: 'https://tool-tests.invalid', organization: { id: 'org', name: 'org' }, user: { id: 'alice', email: 'alice@example.com', email_verified: true }, partition: 'alice' };
let looot: Awaited<ReturnType<typeof startStandIn>>, moltsets: Awaited<ReturnType<typeof startStandIn>>;
before(async () => {
	[looot, moltsets] = await Promise.all([startStandIn('mock-looot.mjs'), startStandIn('mock-moltsets.mjs')]);
	process.env.LOOOT_API_URL = looot.url;
	process.env.MOLTSETS_API_URL = moltsets.url;
});
after(() => { looot?.stop(); moltsets?.stop(); });

async function fixture(t: { after(fn: () => Promise<void>): void }, headers: Record<string, string> = { 'x-looot-key': 'lt_test_token' }) {
	const { database } = await testDatabase(t);
	const services = { database, sheets: new WorkspaceStore(database), keys: new McpStore(database, () => 'test-encryption-root-that-is-shared-across-environments') };
	return new SheetTools(services, actor, resolveAccess(MCP_POLICY, { account: actor, headers: new Headers(headers) }));
}

const runs = async () => ((await looot.log()).runs as Array<{ endpointId: string; quoteOnly: boolean }>).filter((run) => !run.quoteOnly && run.endpointId).length;
const PEOPLE = [['Maya Rios', 'Stripe', 'stripe.com'], ['Marcus Bell', 'Linear', 'linear.app'], ['Yuki Tanaka', 'Vercel', 'vercel.com'], ['Arjun Mehta', 'Notion', 'notion.so'], ['Ingrid Larsen', 'Figma', 'figma.com'], ['Owen Fletcher', 'Datadog', 'datadoghq.com']];

async function peopleSheet(tools: SheetTools) {
	const created = await tools.call('create_sheet', { sheetId: 'leads', name: 'Leads', template: 'people' });
	const columns = (created.sheet as { columns: Array<{ id: string; name: string }> }).columns;
	const id = (name: string) => columns.find((column) => column.name === name)!.id;
	await tools.call('upsert_rows', { sheetId: 'leads', revision: 1, rows: PEOPLE.map(([name, company, website], index) => ({ id: `p${index}`, cells: { [id('Name')]: name, [id('Company')]: company, [id('Company website')]: website } })) });
	const added = await tools.call('add_contact_columns', { sheetId: 'leads', revision: 2 });
	return { emailColumn: (added.added as Array<{ columnId: string }>)[0].columnId, revision: added.revision as number };
}

test('the in-app agent gets only free tools; every paid tool needs a quote and a budget', () => {
	assert.ok(TOOL_NAMES.length >= 30);
	for (const name of AGENT_TOOL_NAMES) assert.ok(['read', 'write'].includes(SHEET_TOOLS[name].kind), name);
	for (const name of ['run_column', 'find_rows', 'enrich_cells', 'delete_rows', 'delete_sheet', 'update_spend_guard'] as const) assert.ok(!AGENT_TOOL_NAMES.includes(name), name);
	for (const name of ['run_column', 'find_rows'] as const) {
		const shape = SHEET_TOOLS[name].schema.shape as Record<string, { safeParse(value: unknown): { success: boolean } }>;
		assert.equal(shape.quoteId.safeParse(undefined).success, false);
		assert.equal(shape.maxUsd.safeParse(undefined).success, false);
	}
});

test('a paid run is refused without a quote or budget, then runs 5 rows inside its budget and replays for free', async (t) => {
	const tools = await fixture(t);
	const { emailColumn } = await peopleSheet(tools);
	await assert.rejects(tools.call('run_column', { maxUsd: 1, idempotencyKey: 'no-quote-0001' }), /expected string|quoteId|Invalid/i);
	await assert.rejects(tools.call('run_column', { quoteId: 'q_missing', maxUsd: 1, idempotencyKey: 'unknown-quote' }), /Unknown quoteId/);
	await assert.rejects(tools.call('enrich_cells', { sheetId: 'leads', columnId: emailColumn, rowIds: ['p0'], idempotencyKey: 'no-budget' }), /Pass maxUsd/);
	const before = await runs();
	const quote = await tools.call('quote_run', { sheetId: 'leads', columnId: emailColumn });
	assert.equal(await runs(), before, 'quoting runs nothing');
	assert.deepEqual([quote.cells, quote.free, quote.priceSource, (quote.tryFirst as { rows: number }).rows], [6, false, 'looot', 5]);
	assert.match(String(quote.label), /^Run 6 rows · up to \$0\.\d+$/);
	await assert.rejects(tools.call('run_column', { quoteId: quote.quoteId, maxUsd: 0.001, idempotencyKey: 'too-small-01' }), /below one cell/);
	const trial = await tools.call('run_column', { quoteId: quote.quoteId, maxUsd: (quote.tryFirst as { maxUsd: number }).maxUsd, idempotencyKey: 'trial-run-0001', rows: 5 });
	assert.deepEqual([trial.status, trial.cells, trial.done], ['finished', 5, 5]);
	assert.ok((trial.spentUsd as number) > 0 && (trial.spentUsd as number) <= (quote.tryFirst as { maxUsd: number }).maxUsd);
	assert.equal((trial.filled as number) + (trial.empty as number) + (trial.errors as number), 5);
	assert.match(String(trial.next), /trial of 5\. 1 more cells/);
	const spent = await runs();
	const replay = await tools.call('run_column', { quoteId: quote.quoteId, maxUsd: 1, idempotencyKey: 'trial-run-0001', rows: 5 });
	assert.equal(replay.replayed, true);
	assert.equal(await runs(), spent, 'a replay spends nothing');
	const sheetSpend = await tools.call('get_spend', { sheetId: 'leads' });
	assert.ok((sheetSpend.sheet as { spentUsd: number }).spentUsd > 0, 'the sheet cap counts the run');
	const status = await tools.call('get_run_status', { runId: trial.runId });
	assert.equal((status.column as { filled: number; rows: number }).rows, 6);
	assert.ok((status.column as { fillRate: number }).fillRate > 0);
	const cell = await tools.call('get_cell_details', { sheetId: 'leads', rowId: 'p0', columnId: emailColumn });
	assert.ok((cell.cell as { m: { looot: unknown[] } }).m.looot.length >= 1, 'the receipt lists the looot runs');
});

test('the run budget and the sheet spend cap each stop cells before they start', async (t) => {
	const tools = await fixture(t);
	const { emailColumn } = await peopleSheet(tools);
	const quote = await tools.call('quote_run', { sheetId: 'leads', columnId: emailColumn });
	const perCell = quote.perCellMaxUsd as number;
	// A budget of one cell's cap: the first cell holds all of it, and after it settles one more cap no longer fits.
	const budgeted = await tools.call('run_column', { quoteId: quote.quoteId, maxUsd: perCell, idempotencyKey: 'one-cell-only' });
	assert.deepEqual([budgeted.done, budgeted.notStarted], [1, 5]);
	assert.ok((budgeted.spentUsd as number) <= perCell);
	await tools.call('update_spend_guard', { sheetId: 'leads', capUsd: 0.01 });
	const before = await runs();
	const again = await tools.call('quote_run', { sheetId: 'leads', columnId: emailColumn });
	assert.equal(again.fitsSheetCap, false);
	const capped = await tools.call('run_column', { quoteId: again.quoteId, maxUsd: 5, idempotencyKey: 'over-the-cap' });
	assert.equal(await runs(), before, 'nothing is sent to looot over the sheet cap');
	assert.ok((capped.outcomes as Array<{ error?: string }>).every((outcome) => /spend cap/.test(outcome.error ?? '')));
});

test('free tools run without a quote: template columns, CSV import, dedupe, query and export', async (t) => {
	const tools = await fixture(t, {});
	await tools.call('create_sheet', { sheetId: 'csv', name: 'CSV', columns: [{ id: 'company', name: 'Company', type: 'source' }] });
	const imported = await tools.call('import_rows', { sheetId: 'csv', revision: 1, csv: 'Company,Website,Notes\nStripe,stripe.com,a\nLinear,linear.app,b\nStripe,https://www.stripe.com/,c' });
	assert.deepEqual([imported.imported, imported.newColumns], [3, ['Website', 'Notes']]);
	const dry = await tools.call('dedupe_rows', { sheetId: 'csv', revision: imported.revision, columnIds: ['website'] });
	assert.deepEqual([dry.dryRun, dry.duplicates], [true, 1]);
	const deduped = await tools.call('dedupe_rows', { sheetId: 'csv', revision: imported.revision, columnIds: ['website'], dryRun: false });
	assert.equal(deduped.deleted, 1);
	const configured = await tools.call('configure_column', { sheetId: 'csv', revision: deduped.revision, column: { id: 'hello', name: 'Hello', type: 'enriched', op: { kind: 'template', template: 'Hi {{Company}}' } } });
	const quote = await tools.call('quote_run', { sheetId: 'csv', columnId: 'hello' });
	assert.deepEqual([quote.free, quote.maxUsd], [true, 0]);
	const ran = await tools.call('run_column', { quoteId: quote.quoteId, maxUsd: 0, idempotencyKey: 'free-template' });
	assert.deepEqual([ran.filled, ran.spentUsd], [2, 0]);
	const found = await tools.call('query_rows', { sheetId: 'csv', filters: [{ columnId: 'company', op: 'equals', value: 'linear' }] });
	assert.deepEqual((found.rows as Array<{ values: Record<string, unknown> }>).map((row) => row.values), [{ Company: 'Linear', Website: 'linear.app', Notes: 'b', Hello: 'Hi Linear' }]);
	const csv = await tools.call('export_sheet', { sheetId: 'csv', format: 'csv' });
	assert.equal(csv.content, 'Company,Website,Notes,Hello\r\nStripe,stripe.com,a,Hi Stripe\r\nLinear,linear.app,b,Hi Linear');
	assert.ok(configured.revision);
	const { sheet } = await tools.call('get_sheet', { sheetId: 'csv' }) as { sheet: { revision: number } };
	const renamed = await tools.call('rename_sheet', { sheetId: 'csv', revision: sheet.revision, name: 'Imported' });
	assert.ok(renamed.revision);
	const copy = await tools.call('duplicate_sheet', { sheetId: 'csv', keepResults: false });
	assert.equal(copy.rows, 2);
	await assert.rejects(tools.call('delete_sheet', { sheetId: 'csv', revision: renamed.revision, confirm: 'CSV' }), /confirm must be the sheet’s name, “Imported”/);
	await tools.call('delete_sheet', { sheetId: 'csv', revision: renamed.revision, confirm: 'Imported' });
});

test('finding rows is quoted for free, then runs inside its budget and skips rows the sheet already has', async (t) => {
	const tools = await fixture(t);
	await tools.call('create_sheet', { sheetId: 'found', name: 'Found', template: 'people' });
	await assert.rejects(tools.call('find_rows', { quoteId: 'q_none', maxUsd: 1, idempotencyKey: 'find-missing' }), /Unknown quoteId/);
	const before = await runs();
	const quote = await tools.call('quote_find_rows', { sheetId: 'found', entity: 'people', query: 'Developer tools companies', limit: 5 });
	assert.equal(await runs(), before, 'the quote reads only the free catalog');
	assert.match(String(quote.label), /^Find up to 5 people · up to \$/);
	const found = await tools.call('find_rows', { quoteId: quote.quoteId, maxUsd: quote.maxUsd, idempotencyKey: 'find-people-001' });
	assert.equal(found.added, 5);
	assert.ok((found.spentUsd as number) <= (quote.maxUsd as number));
	const again = await tools.call('quote_find_rows', { sheetId: 'found', entity: 'people', query: 'Developer tools companies', limit: 5 });
	const second = await tools.call('find_rows', { quoteId: again.quoteId, maxUsd: again.maxUsd, idempotencyKey: 'find-people-002' });
	assert.ok((second.added as number) < 5, 'people already in the sheet are skipped');
});

test('catalog, MoltSets meter, next steps and unpacking read stored answers without spending', async (t) => {
	const tools = await fixture(t, { 'x-looot-key': 'lt_test_token', 'x-moltsets-key': 'ms_test_key' });
	const catalog = await tools.call('search_catalog', { query: 'enrich a company' });
	assert.ok((catalog.endpoints as Array<{ endpointId: string }>).some((hit) => hit.endpointId === 'mock-company-enrich'));
	const inspected = await tools.call('inspect_endpoint', { endpointId: 'mock-company-enrich' });
	assert.deepEqual([inspected.priceUsd, (inspected.inputs as Array<{ name: string }>).map((input) => input.name)], [0.0019, ['domain', 'include_funding']]);
	const plan = await tools.call('moltsets_plan', {});
	assert.deepEqual([plan.connected, plan.ok], [true, true]);
	await tools.call('create_sheet', { sheetId: 'co', name: 'Companies', template: 'companies', enrichments: [{ id: 'info', name: 'Company info', op: { kind: 'company', domain: '{{Website}}', field: 'description' } }] });
	await tools.call('upsert_rows', { sheetId: 'co', revision: 1, rows: [{ id: 'c1', cells: { source_1: 'Stripe', source_2: 'stripe.com' } }] });
	const quote = await tools.call('quote_run', { sheetId: 'co', columnId: 'info' });
	await tools.call('run_column', { quoteId: quote.quoteId, maxUsd: quote.maxUsd, idempotencyKey: 'company-info-1' });
	const before = await runs();
	const steps = await tools.call('get_next_steps', { sheetId: 'co' });
	assert.ok((steps.suggestions as Array<{ job: string }>).some((step) => step.job === 'people.search'));
	const { sheet } = await tools.call('get_sheet', { sheetId: 'co' }) as { sheet: { revision: number } };
	const unpacked = await tools.call('unpack_column', { sheetId: 'co', revision: sheet.revision, columnId: 'info' });
	assert.ok((unpacked.added as unknown[]).length >= 2);
	assert.equal(await runs(), before, 'unpacking and suggestions run nothing');
});
