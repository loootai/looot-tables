import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvToRecords, parseCsv, toCsv } from '../src/lib/csv';
import type { Column, Row } from '../src/lib/types';

test('parseCsv handles quotes, embedded newlines, CRLF and BOM', () => {
	const rows = parseCsv('﻿Name,Note\r\n"Acme, Inc","multi\nline"\r\n"Say ""hi""",x\r\n');
	assert.deepEqual(rows, [
		['Name', 'Note'],
		['Acme, Inc', 'multi\nline'],
		['Say "hi"', 'x'],
	]);
});

test('parseCsv detects tab and semicolon delimiters', () => {
	assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
	assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('CSV delimiter detection ignores quoted delimiters, escaped quotes and multiline headers', () => {
	assert.deepEqual(csvToRecords(parseCsv('Company,Notes\nAcme,"one;two;three;four"')), {
		headers: ['Company', 'Notes'], records: [{ Company: 'Acme', Notes: 'one;two;three;four' }],
	});
	assert.deepEqual(parseCsv('"Name;\n""quoted"";header",Notes\nAcme,"a;b;c"'), [['Name;\n"quoted";header', 'Notes'], ['Acme', 'a;b;c']]);
	assert.deepEqual(parseCsv('Company\tNotes\nAcme\tone,two,three,four'), [['Company', 'Notes'], ['Acme', 'one,two,three,four']]);
	assert.deepEqual(parseCsv('Company;Notes\nAcme;"one,two,three,four"'), [['Company', 'Notes'], ['Acme', 'one,two,three,four']]);
});

test('csvToRecords names blank headers and nulls empty cells', () => {
	const { headers, records } = csvToRecords([['Name', ''], ['Ada', ''], ['', 'x']]);
	assert.deepEqual(headers, ['Name', 'Column 2']);
	assert.deepEqual(records, [{ Name: 'Ada', 'Column 2': null }, { Name: null, 'Column 2': 'x' }]);
});

test('toCsv escapes and includes meta columns when asked', () => {
	const columns: Column[] = [
		{ id: 'a', name: 'Name', type: 'source', width: 100, createdAt: 0 },
		{ id: 'b', name: 'Free?', type: 'enriched', width: 100, createdAt: 0, op: { kind: 'check', question: 'q', decider: 'jev', threshold: 0.5 } },
	];
	const rows: Row[] = [{ id: 'r', sheetId: 's', order: 0, createdAt: 0, cells: { a: { v: 'Acme, "Inc"', s: 'done', t: 0 }, b: { v: true, s: 'done', t: 0, m: { probability: 0.91, sources: ['https://x.com/pricing'] } } } }];
	const csv = toCsv(columns, rows, { includeMeta: true });
	assert.equal(csv, '﻿Name,Free?,Free? (confidence),Free? (sources)\r\n"Acme, ""Inc""",true,0.91,https://x.com/pricing');
	const plain = toCsv(columns, rows);
	assert.equal(plain, '﻿Name,Free?\r\n"Acme, ""Inc""",true');
});

test('csvToRecords keeps duplicate headers as distinct columns', () => {
	const { headers, records } = csvToRecords([['Name', 'Email', 'Name'], ['Acme', 'a@x.com', 'Bob']]);
	assert.deepEqual(headers, ['Name', 'Email', 'Name 2']);
	assert.deepEqual(records, [{ Name: 'Acme', Email: 'a@x.com', 'Name 2': 'Bob' }]);
});


test('CSV numeric cells support formulas while identifiers and formula-looking text remain literal', () => {
	const { records } = csvToRecords([['Amount', 'Code', 'Text', 'Long ID'], ['12.5', '00123', '=1+2', '9999999999999999999']]);
	assert.deepEqual(records, [{ Amount: 12.5, Code: '00123', Text: '=1+2', 'Long ID': '9999999999999999999' }]);
});

test('CSV records preserve prototype-named headers as own properties', () => {
	const { headers, records } = csvToRecords(parseCsv('__proto__,constructor,Name\noriginal,company,Acme'));
	assert.deepEqual(headers, ['__proto__', 'constructor', 'Name']);
	assert.equal(Object.hasOwn(records[0], '__proto__'), true);
	assert.equal(records[0]['__proto__'], 'original');
	assert.equal(records[0].constructor, 'company');
	assert.equal(JSON.stringify(records[0]), '{"__proto__":"original","constructor":"company","Name":"Acme"}');
});

test('exports keep flagged imported text but blank failed enrichments', () => {
	const source = { id: 's', name: 'Website', type: 'source' as const, width: 100, format: 'website' as const, createdAt: 0 };
	const enriched = { id: 'e', name: 'CEO', type: 'enriched' as const, width: 100, createdAt: 0, op: { kind: 'template' as const, template: 'x' } };
	const rows = [{ id: 'r', sheetId: 'x', order: 0, createdAt: 0, cells: { s: { v: 'not a site', s: 'error' as const, e: 'Not a website', t: 0 }, e: { v: null, s: 'error' as const, e: 'Failed', t: 0 } } }];
	assert.equal(toCsv([source, enriched], rows), '\uFEFFWebsite,CEO\r\nnot a site,');
});
