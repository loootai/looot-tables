import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { toXlsx } from '../src/lib/xlsx';
import type { Column, Row } from '../src/lib/types';

test('toXlsx produces a valid package with a frozen header row and typed cells', async () => {
	const columns: Column[] = [
		{ id: 'a', name: 'Name', type: 'source', width: 140, createdAt: 0 },
		{ id: 'b', name: 'Employees', type: 'source', width: 100, createdAt: 0 },
		{ id: 'c', name: 'Free?', type: 'enriched', width: 100, createdAt: 0 },
	];
	const rows: Row[] = [{ id: 'r', sheetId: 's', order: 0, createdAt: 0, cells: { a: { v: 'A & B <C>', s: 'done', t: 0 }, b: { v: 42, s: 'done', t: 0 }, c: { v: true, s: 'done', t: 0 } } }];
	const blob = toXlsx('My / Sheet', columns, rows);
	const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
	assert.ok(files['[Content_Types].xml']);
	assert.ok(files['xl/workbook.xml']);
	const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
	assert.match(sheet, /<pane ySplit="1"/);
	assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">A &amp; B &lt;C&gt;<\/t><\/is><\/c>/);
	assert.match(sheet, /<c r="B2"><v>42<\/v><\/c>/);
	assert.match(sheet, /<c r="C2" t="b"><v>1<\/v><\/c>/);
	assert.match(strFromU8(files['xl/workbook.xml']), /name="My   Sheet"/);
});
