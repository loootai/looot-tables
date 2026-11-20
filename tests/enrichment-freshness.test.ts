import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { before, test } from 'node:test';
import { initSync } from '@ironcalc/wasm';
import { calculateFormulas, type FormulaRequest } from '../src/lib/formulas';
import { appendRows, connectWorkspace, createSheet, db, deleteColumn, deleteSheet, newColumn, setCell, sourceCell } from '../src/lib/db';
import { runner } from '../src/lib/runner';
import { enrichmentIsOutdated, inputFingerprint } from '../src/lib/enrichment-freshness';
import { planCell } from '../src/lib/enrichment-plan';
import { rowSchema } from '../src/lib/workspace';
import { opDependencies } from '../src/lib/references';
import { promptRowRecord } from '../src/lib/template';
import type { Cell, Column, ColumnOp, Row, Sheet } from '../src/lib/types';
import { MemoryRemote } from './support/memory-remote';

initSync({ module: readFileSync(createRequire(`${process.cwd()}/package.json`).resolve('@ironcalc/wasm/wasm_bg.wasm')) });
class TestWorker {
	onmessage?: (event: { data: unknown }) => void;
	terminate() {}
	postMessage(request: FormulaRequest & { id: number }) { setTimeout(() => this.onmessage?.({ data: { id: request.id, results: calculateFormulas(request) } }), 0); }
}
Object.assign(globalThis, { Worker: TestWorker });
async function settled() {
	for (let i = 0; i < 200 && runner.getSnapshot().active; i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(runner.getSnapshot().active, false);
}

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('formula input changes mark saved results stale and a successful refresh clears the marker', async (t) => {
	const raw = newColumn({ name: 'Raw', type: 'source' });
	const computed = newColumn({ name: 'Computed', type: 'source' });
	const output = newColumn({ name: 'Result', type: 'enriched', op: { kind: 'search', query: '{{Computed}}', pick: 'snippet', numResults: 1 } });
	const sheet = await createSheet('Freshness', [raw, computed, output]);
	t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => Response.json({ value: JSON.parse(String(init?.body)).row.Computed }));
	const rows = () => db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	try {
		await appendRows(sheet.id, [{ Raw: 'old' }]);
		const id = (await rows())[0].id;
		await setCell(id, computed.id, { v: null, s: 'done', t: 1, f: '=A1&"-tail"' });
		await runner.enqueue(sheet, await rows(), [output]); await settled();
		let current = await rows();
		assert.equal(current[0].cells[output.id].v, 'old-tail');
		assert.equal(enrichmentIsOutdated(sheet, current, current[0], output.id), false);
		await setCell(id, raw.id, sourceCell('new'));
		current = await rows();
		assert.equal(current[0].cells[computed.id].v, 'new-tail');
		assert.equal(current[0].cells[output.id].v, 'old-tail');
		assert.equal(enrichmentIsOutdated(sheet, current, current[0], output.id), true);
		const restored = current.map(row => rowSchema.parse(JSON.parse(JSON.stringify(row))));
		assert.equal(enrichmentIsOutdated(sheet, restored, restored[0], output.id), true);
		await runner.enqueue(sheet, current, [output]); await settled();
		current = await rows();
		assert.equal(current[0].cells[output.id].v, 'new-tail');
		assert.equal(enrichmentIsOutdated(sheet, current, current[0], output.id), false);
	} finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('freshness handles fixed cross-row references, rule changes, legacy results and pending cells', async () => {
	const input = newColumn({ name: 'Value', type: 'source' });
	const output = newColumn({ name: 'Copy', type: 'enriched', op: { kind: 'template', template: '{{A$1}}' } });
	const sheet = await createSheet('References', [input, output]);
	try {
		await appendRows(sheet.id, [{ Value: 'first' }, { Value: 'second' }]);
		let rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		await runner.enqueue(sheet, [rows[1]], [output], { limitToRows: true }); await settled();
		rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		assert.equal(enrichmentIsOutdated(sheet, rows, rows[1], output.id), false);
		rows[0].cells[input.id].v = 'changed';
		assert.equal(enrichmentIsOutdated(sheet, rows, rows[1], output.id), true);
		rows[1].cells[output.id].s = 'running';
		assert.equal(enrichmentIsOutdated(sheet, rows, rows[1], output.id), false);
		rows[1].cells[output.id] = { v: 'legacy', s: 'done', t: 1 };
		rows[0].cells[input.id].t = 2;
		assert.equal(enrichmentIsOutdated(sheet, rows, rows[1], output.id), true);
		rows[1].cells[output.id].m = { inputFingerprint: inputFingerprint(planCell({ sheet, rows }, { rowId: rows[1].id, columnId: output.id })!.version) };
		assert.equal(enrichmentIsOutdated(sheet, rows, rows[1], output.id), false);
		const ruleChanged = { ...sheet, columns: sheet.columns.map((column) => column.id === output.id ? { ...column, op: { kind: 'template' as const, template: 'Different {{A$1}}' } } : column) };
		assert.equal(enrichmentIsOutdated(ruleChanged, rows, rows[1], output.id), true);
	} finally { await deleteSheet(sheet.id); }
});

test('results fingerprinted by the previous implementation stay current', () => {
	const name = newColumn({ name: 'Name', type: 'source' });
	const named = newColumn({ name: 'Named', type: 'enriched', op: { kind: 'ai', prompt: 'About {{Name}}', output: 'text', research: 'none' } });
	const coordinate = newColumn({ name: 'Coordinate', type: 'enriched', op: { kind: 'template', template: '{{A$1}} and {{Name}}' } });
	const sheet = { id: 'versions', name: 'Versions', columns: [name, named, coordinate], filters: [], sort: null, createdAt: 0, updatedAt: 0 };
	const rows = ['first', 'second'].map((value, order) => ({ id: `row-${order}`, sheetId: sheet.id, order, createdAt: 0, cells: { [name.id]: sourceCell(value) } }));
	// The previous implementation, kept here so saved fingerprints are proven to stay valid.
	const legacy = (rowId: string, columnId: string) => {
		const column = sheet.columns.find((entry) => entry.id === columnId)!;
		const row = rows.find((entry) => entry.id === rowId)!;
		const input = { ...row, cells: { ...row.cells, [columnId]: { v: null, s: 'idle' as const, t: 0 } } };
		const references = opDependencies(column.op!);
		const record = promptRowRecord(input, rows.map((entry) => entry.id === rowId ? input : entry), sheet.columns, references);
		const usesRowContext = ['email-draft', 'ai', 'check', 'classify', 'score', 'answer'].includes(column.op!.kind);
		const entries = Object.entries(record).filter(([key]) => usesRowContext || references.some((ref) => ref.toLowerCase() === key.toLowerCase()));
		const version = JSON.stringify({ op: column.op, record: Object.fromEntries(entries) }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
		return inputFingerprint(version).replace(/^v2:/, 'v1:');
	};
	for (const column of [named, coordinate]) for (const row of rows) {
		const saved = rows.map((entry) => entry.id === row.id ? { ...entry, cells: { ...entry.cells, [column.id]: { v: 'x', s: 'done' as const, t: 1, m: { inputFingerprint: legacy(row.id, column.id) } } } } : entry);
		assert.equal(enrichmentIsOutdated(sheet, saved, saved[row.order], column.id), false, `${column.name} ${row.id}`);
		const edited = saved.map((entry) => ({ ...entry, cells: { ...entry.cells, [name.id]: sourceCell(`${entry.cells[name.id].v} edited`) } }));
		assert.equal(enrichmentIsOutdated(sheet, edited, edited[row.order], column.id), true, `${column.name} ${row.id}: an input changed`);
	}
	const { record } = planCell({ sheet, rows }, { rowId: rows[1].id, columnId: coordinate.id })!;
	assert.deepEqual([record.A$1, record.Name], ['first', 'second'], 'what a run is sent is unchanged');
});

test('operations that read only their references are outdated only when a reference changes, whole-row ones when any source value of the row does', () => {
	const name = newColumn({ name: 'Name', type: 'source' }), notes = newColumn({ name: 'Notes', type: 'source' });
	const draft = { kind: 'email-draft', mode: 'template', prompt: 'Draft a personalized email using this row.', to: '', cc: '', bcc: '', subject: 'Hi {{Name}}', body: '' } as const;
	const cases: Array<{ name: string; op: ColumnOp; readsRow: boolean }> = [
		{ name: 'template email draft', op: draft, readsRow: false },
		{ name: 'AI email draft', op: { ...draft, mode: 'ai' }, readsRow: true },
		{ name: 'research about a referenced subject', op: { kind: 'answer', task: 'Funding of {{Name}}', output: 'text', mode: 'fast' }, readsRow: false },
		{ name: 'research about the row', op: { kind: 'answer', task: 'Latest funding', output: 'text', mode: 'fast' }, readsRow: true },
		{ name: 'web search', op: { kind: 'search', query: '{{Name}}', pick: 'url', numResults: 3 }, readsRow: false },
	];
	for (const { name: label, op, readsRow } of cases) {
		const output = newColumn({ name: 'Out', type: 'enriched', op });
		const sheet: Sheet = { id: 's', name: 'S', columns: [name, notes, output], filters: [], sort: null, createdAt: 0, updatedAt: 0 };
		const row = (person: string, note: string, fingerprint?: string): Row => ({ id: 'r', sheetId: 's', order: 0, createdAt: 0, cells: { [name.id]: { v: person, s: 'done', t: 1 }, [notes.id]: { v: note, s: 'done', t: 1 }, [output.id]: { v: 'x', s: 'done', t: 2, m: { inputFingerprint: fingerprint } } } });
		const stale = (entry: Row) => enrichmentIsOutdated(sheet, [entry], entry, output.id);
		const current = inputFingerprint(planCell({ sheet, rows: [row('Ada', 'a')] }, { rowId: 'r', columnId: output.id })!.version);
		assert.equal(stale(row('Ada', 'a', current)), false, label);
		assert.equal(stale(row('Ada', 'b', current)), readsRow, `${label}: unrelated edit`);
		assert.equal(stale(row('Grace', 'a', current)), true, `${label}: referenced edit`);
		// Results saved while every operation of these kinds was fingerprinted with its whole row.
		const input = { ...row('Ada', 'a'), cells: { ...row('Ada', 'a').cells, [output.id]: { v: null, s: 'idle' as const, t: 0 } } };
		const sorted = (_key: string, value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value;
		const legacy = inputFingerprint(JSON.stringify({ op, record: promptRowRecord(input, [input], sheet.columns, opDependencies(op)) }, sorted)).replace(/^v2:/, 'v1:');
		assert.equal(stale(row('Ada', 'a', legacy)), false, `${label}: unchanged legacy result`);
		assert.equal(stale(row('Ada', 'b', legacy)), true, `${label}: changed legacy result`);
	}
});

test('a formula result is an input only when referenced: a whole-row check stays complete when a formula reading it recalculates', async (t) => {
	const company = newColumn({ name: 'Company', type: 'source' });
	const check = newColumn({ name: 'B2B?', type: 'enriched', op: { kind: 'check', question: 'Is it B2B?', decider: 'openai', threshold: 0.5 } });
	const label = newColumn({ name: 'Label', type: 'source' });
	const sheet = await createSheet('Formula inputs', [company, check, label]);
	t.mock.method(globalThis, 'fetch', async () => Response.json({ value: true, meta: { probability: 0.9 } }));
	const rows = () => db.rows.where('sheetId').equals(sheet.id).sortBy('order');
	try {
		await appendRows(sheet.id, [{ Company: 'Acme' }]);
		const id = (await rows())[0].id;
		await setCell(id, label.id, { v: null, s: 'done', t: 1, f: '=IF(B1,"B2B","B2C")' });
		assert.equal((await rows())[0].cells[label.id].v, 'B2C');
		await runner.enqueue(sheet, await rows(), [check]); await settled();
		const current = await rows();
		assert.deepEqual([current[0].cells[check.id].v, current[0].cells[label.id].v], [true, 'B2B'], 'saving the answer recalculated the formula');
		assert.equal(planCell({ sheet, rows: current }, { rowId: id, columnId: check.id })!.complete, true);
		assert.equal(enrichmentIsOutdated(sheet, current, current[0], check.id), false);
	} finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('deleting an empty column keeps a result fingerprinted by column name current', async () => {
	const column = (id: string, name: string, extra: Partial<Column> = {}): Column => ({ id, name, type: 'source', width: 180, createdAt: 0, ...extra });
	const columns = [column('company', 'Company'), column('empty', 'Empty'), column('ask', 'Ask', { type: 'enriched', op: { kind: 'ai', prompt: 'Who runs it?', output: 'text', research: 'none' } })];
	// Saved by the previous implementation over { Company: 'Acme', Empty: null, Ask: null }.
	const saved: Cell = { v: 'Ada', s: 'done', m: { inputFingerprint: 'v1:e931f0d9310b12c1' }, t: 2 };
	const sheet = await createSheet('Legacy delete', columns, { id: 'legacy-delete', rows: [{ id: 'r', sheetId: 'legacy-delete', order: 0, createdAt: 0, cells: { company: { v: 'Acme', s: 'done', t: 1 }, ask: saved } }] });
	try {
		let rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		assert.equal(enrichmentIsOutdated(sheet, rows, rows[0], 'ask'), false, 'current as saved');
		const deleted = { ...sheet, columns: [columns[0], columns[2]] };
		assert.equal(enrichmentIsOutdated(deleted, rows, rows[0], 'ask'), true, 'the v1 fingerprint alone cannot follow the deletion');
		await deleteColumn(sheet.id, 'empty');
		rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		assert.equal(enrichmentIsOutdated((await db.sheets.get(sheet.id))!, rows, rows[0], 'ask'), false, 'restamped before the deletion, it stays current');
		assert.match(rows[0].cells.ask.m!.inputFingerprint!, /^v2:/);
		assert.equal(rows[0].cells.ask.v, 'Ada');
	} finally { await deleteSheet(sheet.id); }
});
