import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { parseCsv, csvToRecords } from '../src/lib/csv';
import { appendRows, connectWorkspace, createSheet, db, newColumn, upgradeSheet } from '../src/lib/db';
import { canonicalJson } from '../src/lib/cell-content';
import { inputFingerprint, inputRecord } from '../src/lib/enrichment-freshness';
import { planCell, resultCell } from '../src/lib/enrichment-plan';
import { danglingReferences } from '../src/lib/references';
import { sheetHistory } from '../src/lib/sheet-history';
import { renderTemplate, rowToRecord } from '../src/lib/template';
import type { Column, Row, Sheet } from '../src/lib/types';
import { SHEET_DATA_VERSION } from '../src/lib/workspace';
import { MemoryRemote } from './support/memory-remote';

let remote = new MemoryRemote();
beforeEach(() => connectWorkspace(remote = new MemoryRemote()));

const column = (id: string, name: string, extra: Partial<Column> = {}): Column => ({ id, name, type: 'source', width: 180, createdAt: 1, ...extra });

/** A sheet as saved before the Website label: no data version, a source "Domain" column, and AI columns reading it
    with a current result. */
async function legacySheet(id: string, columns: Column[]) {
	const sheet: Sheet = { id, name: id, columns, filters: [], sort: null, createdAt: 1, updatedAt: 1 };
	const row: Row = { id: `${id}-r1`, sheetId: id, order: 0, createdAt: 1, cells: { domain: { v: 'acme.com', s: 'done', t: 1 } } };
	const ceo = columns.find((entry) => entry.id === 'ceo');
	if (ceo) row.cells.ceo = resultCell(planCell({ sheet, rows: [row] }, { rowId: row.id, columnId: 'ceo' })!, 'Ada');
	await remote.create(sheet, [row]);
	await connectWorkspace(remote);
	return sheet;
}
const saved = async (id: string) => ({ sheet: (await db.sheets.get(id))!, rows: await db.rows.where('sheetId').equals(id).sortBy('order') });

test('an older sheet’s Domain column becomes Website once, through the rename: references follow and results stay current', async () => {
	await legacySheet('legacy', [
		column('domain', 'Domain', { format: 'url' }),
		column('ceo', 'CEO', { type: 'enriched', op: { kind: 'ai', prompt: 'CEO of {{Domain}}?', output: 'text', research: 'web' } }),
		column('page', 'Pricing', { type: 'enriched', op: { kind: 'template', template: 'https://{{Domain}}/pricing' } }),
	]);
	assert.equal(planCell(await saved('legacy'), { rowId: 'legacy-r1', columnId: 'ceo' })?.complete, true);
	await upgradeSheet('legacy');
	const { sheet, rows } = await saved('legacy');
	assert.deepEqual(sheet.columns.map((entry) => entry.name), ['Website', 'CEO', 'Pricing']);
	assert.equal(sheet.dataVersion, SHEET_DATA_VERSION);
	assert.deepEqual(sheet.columns.map((entry) => entry.op && danglingReferences(entry.op, sheet.columns)).filter(Boolean), [[], []]);
	assert.deepEqual(sheet.columns[1].op, { kind: 'ai', prompt: 'CEO of {{Website}}?', output: 'text', research: 'web' });
	assert.equal(renderTemplate((sheet.columns[2].op as { template: string }).template, rowToRecord(rows[0], sheet.columns)), 'https://acme.com/pricing');
	assert.equal(planCell({ sheet, rows }, { rowId: 'legacy-r1', columnId: 'ceo' })?.complete, true, 'a rename changes no input, so the answer is not outdated');
	assert.equal(sheetHistory.peek('legacy', 'undo'), undefined, 'the upgrade is not an undo step');
	assert.equal(remote.snapshot('legacy')?.sheet.columns[0].name, 'Website');
	const calls = remote.calls.length;
	await upgradeSheet('legacy');
	assert.equal(remote.calls.length, calls, 'an upgraded sheet is left alone');
});

test('the upgrade skips other Domain columns and sheets created since', async () => {
	await legacySheet('typed', [column('domain', 'Domain', { format: 'text' })]);
	await legacySheet('taken', [column('domain', 'Domain'), column('site', 'Website', { format: 'text' })]);
	const created = await createSheet('New', [newColumn({ name: 'Domain', type: 'source' })]);
	for (const id of ['typed', 'taken', created.id]) await upgradeSheet(id);
	assert.equal((await db.sheets.get('typed'))!.columns[0].name, 'Domain', 'a Domain column that is not a website');
	assert.deepEqual((await db.sheets.get('taken'))!.columns.map((entry) => entry.name), ['Domain', 'Website'], 'the name is taken');
	assert.equal((await db.sheets.get(created.id))!.columns[0].name, 'Domain', 'someone named it Domain after the upgrade shipped');
	assert.equal(created.dataVersion, SHEET_DATA_VERSION);
});

test('a sheet saved with results fingerprinted by column name is restamped once, and keeps a Domain column someone named', async () => {
	const op = { kind: 'ai', prompt: 'CEO of {{Domain}}?', output: 'text', research: 'web' } as const;
	const columns = [column('domain', 'Domain', { format: 'url' }), column('ceo', 'CEO', { type: 'enriched', op })];
	const sheet: Sheet = { id: 'stamped', name: 'Stamped', columns, filters: [], sort: null, dataVersion: 1, createdAt: 1, updatedAt: 1 };
	const row: Row = { id: 'stamped-r1', sheetId: 'stamped', order: 0, createdAt: 1, cells: { domain: { v: 'acme.com', s: 'done', t: 1 } } };
	const legacy = inputFingerprint(canonicalJson({ op, record: inputRecord(columns, [row], 0, op, 'ceo') })!).replace(/^v2:/, 'v1:');
	row.cells.ceo = { v: 'Ada', s: 'done', m: { inputFingerprint: legacy }, t: 2 };
	await remote.create(sheet, [row]);
	await connectWorkspace(remote);
	await upgradeSheet('stamped');
	const upgraded = await saved('stamped');
	assert.deepEqual([upgraded.sheet.columns[0].name, upgraded.sheet.dataVersion], ['Domain', SHEET_DATA_VERSION], 'created after the Domain upgrade shipped');
	assert.match(upgraded.rows[0].cells.ceo.m!.inputFingerprint!, /^v2:/);
	assert.equal(planCell(upgraded, { rowId: 'stamped-r1', columnId: 'ceo' })?.complete, true);
	const calls = remote.calls.length;
	await upgradeSheet('stamped');
	assert.equal(remote.calls.length, calls, 'once');
});

test('a CSV’s Website or Domain header fills the sheet’s website column instead of adding one', async () => {
	const csv = (text: string) => csvToRecords(parseCsv(text)).records;
	const sheet = await createSheet('Leads', [newColumn({ name: 'Company', type: 'source' }), newColumn({ name: 'Website', type: 'source' })]);
	await appendRows(sheet.id, csv('Company,Website\nAcme,acme.com'));
	await appendRows(sheet.id, csv('Company,Domain\nGlobex,globex.com'));
	const renamed = await createSheet('Renamed', [newColumn({ name: 'Company site', type: 'source', format: 'website' })]);
	await appendRows(renamed.id, csv('Website\nhttps://www.initech.com/'));
	const leads = await saved(sheet.id);
	assert.deepEqual(leads.sheet.columns.map((entry) => entry.name), ['Company', 'Website']);
	assert.deepEqual(leads.rows.map((row) => row.cells[leads.sheet.columns[1].id].v), ['acme.com', 'globex.com']);
	const site = await saved(renamed.id);
	assert.deepEqual(site.sheet.columns.map((entry) => entry.name), ['Company site']);
	assert.equal(site.rows[0].cells[site.sheet.columns[0].id].v, 'initech.com');
	await appendRows(sheet.id, csv('Website,Domain\nhooli.com,hooli.example'));
	assert.deepEqual((await db.sheets.get(sheet.id))!.columns.map((entry) => entry.name), ['Company', 'Website', 'Domain'], 'a header naming the column wins; the other stays its own');
});

test('an older sheet with nothing to upgrade is still stamped, so a Domain column added later keeps its name', async () => {
	await legacySheet('plain', [column('domain', 'Company')]);
	await upgradeSheet('plain');
	assert.equal(remote.snapshot('plain')?.sheet.dataVersion, SHEET_DATA_VERSION, 'stamped although nothing changed');
	await appendRows('plain', [{ Domain: 'globex.com' }]);
	await upgradeSheet('plain');
	assert.deepEqual((await db.sheets.get('plain'))!.columns.map((entry) => entry.name), ['Company', 'Domain']);
	const calls = remote.calls.length;
	await upgradeSheet('plain');
	assert.equal(remote.calls.length, calls, 'once');
});
