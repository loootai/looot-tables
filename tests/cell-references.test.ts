import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { parsePromptReference, promptReferenceCells } from '../src/lib/references';
import { promptRowRecord, renderTemplate } from '../src/lib/template';
import { addColumns, appendRows, connectWorkspace, createSheet, db, deleteColumn, deleteSheet, moveColumn, newColumn } from '../src/lib/db';
import { runner } from '../src/lib/runner';
import type { Column, Row } from '../src/lib/types';
import { MemoryRemote } from './support/memory-remote';

const columns: Column[] = [newColumn({ name: 'Company', type: 'source' }), newColumn({ name: 'Domain', type: 'source' })];
const rows: Row[] = ['Acme', 'Example', 'Third'].map((name, i) => ({
	id: `row-${i}`, sheetId: 'sheet', order: i * 3, createdAt: 0,
	cells: { [columns[0].id]: { v: name, s: 'done', t: 0 }, [columns[1].id]: { v: `${name.toLowerCase()}.com`, s: 'done', t: 0 } },
}));

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('accepts relative, absolute, and mixed cell/range references with spreadsheet bounds', () => {
	for (const text of ['A1', '$A$1', 'A$1', '$A1', 'a1:b3', '$A1:B$3', 'XFD1048576']) assert.ok(parsePromptReference(text), text);
	for (const text of ['A0', 'XFE1', 'A1048577', 'A1:B', 'A1:B2:C3', 'Company', 'A1 text', 'https://a1']) assert.equal(parsePromptReference(text), null, text);
});

test('fills relative rows down and locks absolute rows, preserving range layout', () => {
	const tokens = ['A1', '$A$1', 'A$1', '$A1', 'A1:B2', '$A$1:$B$2', '$A$1:B2', 'A99'];
	const record = promptRowRecord(rows[1], rows, columns, tokens);
	assert.equal(record.A1, 'Example');
	assert.equal(record['$A$1'], 'Acme');
	assert.equal(record['A$1'], 'Acme');
	assert.equal(record['$A1'], 'Example');
	assert.equal(record['A1:B2'], 'Example\texample.com\nThird\tthird.com');
	assert.equal(record['$A$1:$B$2'], 'Acme\tacme.com\nExample\texample.com');
	assert.equal(record['$A$1:B2'], 'Acme\tacme.com\nExample\texample.com\nThird\tthird.com');
	assert.equal(record.A99, '');
	assert.equal(renderTemplate('{{Company}} / {{a1}} / {{$A$1}}', record), 'Example / Example / Acme');
	assert.deepEqual(promptReferenceCells('B2:A1', 0, rows, columns), promptReferenceCells('A1:B2', 0, rows, columns));
});

test('prefers named columns over addresses and blanks unsettled enriched cells', () => {
	const named = newColumn({ name: 'A1', type: 'source' });
	const pending = newColumn({ name: 'Pending', type: 'enriched' });
	const row: Row = { ...rows[0], cells: { ...rows[0].cells, [named.id]: { v: 'Named value', s: 'done', t: 0 }, [pending.id]: { v: 'Stale', s: 'running', t: 0 } } };
	const record = promptRowRecord(row, [row], [...columns, named, pending], ['a1', 'D1']);
	assert.equal(renderTemplate('{{a1}}', record), 'Named value');
	assert.equal(record.D1, '');
	assert.equal(promptReferenceCells('a1', 0, [row], [...columns, named])[0].column.id, named.id);
});

test('runner waits for a referenced cell in another row and resolves references before execution', async () => {
	const source = newColumn({ name: 'Company', type: 'source' });
	const dependency = newColumn({ name: 'Copied', type: 'enriched', op: { kind: 'template', template: '{{Company}}' } });
	const output = newColumn({ name: 'Result', type: 'enriched', op: { kind: 'template', template: '{{A1}} / {{$B$2}} / {{$A$1:$A$2}}' } });
	const sheet = await createSheet('Cell reference runner', [source, dependency, output]);
	try {
		await appendRows(sheet.id, [{ Company: 'Acme' }, { Company: 'Example' }]);
		const sheetRows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		await runner.enqueue(sheet, sheetRows, [output, dependency]);
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Runner did not finish')); }, 5000);
			const check = () => { if (!runner.getSnapshot().active) { clearTimeout(timeout); unsubscribe(); resolve(); } };
			const unsubscribe = runner.subscribe(check);
			check();
		});
		const results = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		assert.equal(results[0].cells[output.id].v, 'Acme / Example / Acme\nExample');
		assert.equal(results[1].cells[output.id].v, 'Example / Example / Acme\nExample');
		assert.ok(results.every((row) => row.cells[output.id].s === 'done'));
	} finally {
		await runner.cancel({ sheetId: sheet.id });
		await deleteSheet(sheet.id);
	}
});

test('inserting, moving and deleting columns rewrites cell references, checks cycles, and leaves deleted names dangling', async () => {
	const company = newColumn({ name: 'Company', type: 'source' });
	const domain = newColumn({ name: 'Domain', type: 'source' });
	const output = newColumn({ name: 'Result', type: 'enriched', op: { kind: 'template', template: '{{A1}} / {{B1}} / {{Domain}}' } });
	const sheet = await createSheet('Structural references', [company, domain, output]);
	const template = async () => ((await db.sheets.get(sheet.id))!.columns.find((column) => column.id === output.id)!.op as { template: string }).template;
	try {
		await addColumns(sheet.id, [newColumn({ name: 'Notes', type: 'source' })], 0);
		assert.equal(await template(), '{{B1}} / {{C1}} / {{Domain}}');
		await moveColumn(sheet.id, company.id, 3);
		assert.equal(await template(), '{{D1}} / {{B1}} / {{Domain}}', 'references follow the moved column');
		const reader = newColumn({ name: 'Reader', type: 'enriched', op: { kind: 'template', template: '{{A1:B1}}' } });
		await addColumns(sheet.id, [reader], 4);
		await assert.rejects(moveColumn(sheet.id, reader.id, 1), /Circular/, 'a range that would span its own column is refused');
		await deleteColumn(sheet.id, domain.id);
		assert.equal(await template(), '{{C1}} / {{#REF!}} / {{Domain}}');
		await appendRows(sheet.id, [{ Company: 'Acme' }]);
		const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		await runner.enqueue((await db.sheets.get(sheet.id))!, rows, [{ ...output }]);
		for (let i = 0; i < 200 && runner.getSnapshot().active; i++) await new Promise((resolve) => setTimeout(resolve, 5));
		const cell = (await db.rows.get(rows[0].id))!.cells[output.id];
		assert.equal(cell.s, 'error');
		assert.match(cell.e ?? '', /\{\{#REF!\}\}, \{\{Domain\}\} don’t match any column/);
	} finally {
		await runner.cancel({ sheetId: sheet.id });
		await deleteSheet(sheet.id);
	}
});
