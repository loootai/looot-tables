import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { companyPreview, populatedDetails } from '../src/lib/company-preview';
import { CompanyPreview } from '../src/components/sheet/company-preview';
import type { Cell, Column, Row } from '../src/lib/types';

const column = (id: string, name: string, op?: Column['op']): Column => ({ id, name, op, type: op ? 'enriched' : 'source', width: 220, createdAt: 1 });
const company = column('company', 'Company');
const domain = column('domain', 'Company domain');
const description = column('description', 'Description', { kind: 'company', domain: '{{Company domain}}', field: 'description' });
const funding = column('funding', 'Funding', { kind: 'company', domain: '{{Company domain}}', field: 'funding_total' });
const cell = (v: Cell['v'], extra: Partial<Cell> = {}): Cell => ({ v, s: 'done', t: 1000, ...extra });
const row = (cells: Row['cells']): Row => ({ id: 'row', sheetId: 'sheet', order: 0, createdAt: 1, cells: { company: cell('Example'), domain: cell('example.com'), ...cells } });

test('preview renders saved row fields and paid profile extras without any fetch', (t) => {
	t.mock.method(globalThis, 'fetch', () => { throw new Error('Preview must not fetch'); });
	const data = row({
		description: cell('A saved description', { m: { companyIntel: { domain: 'example.com', input: 'example.com', source: 'brand', data: { description: 'A saved description', employees: { exact: 25 }, address: { city: 'San Francisco', country: null } } } } }),
		funding: cell(0, { m: { raw: { total_usd: 0, stage: 'seed' } } }),
	});
	const columns = [company, domain, description, funding];
	const preview = companyPreview(data, company, columns);
	assert.equal(preview.domain, 'example.com');
	assert.equal(preview.profiles.length, 2);
	assert.ok(preview.fields.some((field) => field.cell.v === 0));
	const html = renderToStaticMarkup(createElement(CompanyPreview, { row: data, column: company, columns }));
	for (const text of ['Saved company intel', 'uses no credits', 'San Francisco', 'Employees', 'seed', 'From this row']) assert.ok(html.includes(text), text);
	assert.ok(!html.includes('<img'));
});

test('skips pending/failed/empty cells and never attaches a different company profile', () => {
	const other = column('other', 'Other profile', { kind: 'company', domain: 'other.com', field: 'description' });
	const pending = column('pending', 'Pending');
	const failed = column('failed', 'Failed');
	const empty = column('empty', 'Empty');
	const data = row({
		other: cell('Other', { m: { companyIntel: { domain: 'other.com', source: 'brand', data: { description: 'Wrong company' } } } }),
		pending: cell('Old data', { s: 'running' }), failed: cell('Old data', { s: 'error' }), empty: cell(null),
	});
	const preview = companyPreview(data, company, [company, domain, other, pending, failed, empty]);
	assert.deepEqual(preview.profiles, []);
	assert.deepEqual(preview.fields.map((field) => field.column.id), ['domain', 'other']);
});

test('changing an input excludes the previous paid snapshot, including name-based inputs', () => {
	const named = column('named', 'Company name', { kind: 'company', domain: '{{Company}}', field: 'title' });
	const data = row({ named: cell('Example', { m: { companyIntel: { domain: 'example.com', input: 'Example', source: 'brand', data: { description: 'Saved profile' } } } }) });
	assert.equal(companyPreview(data, named, [company, named]).profiles.length, 1);
	data.cells.company = cell('New company');
	assert.deepEqual(companyPreview(data, named, [company, named]).profiles, []);
});

test('ambiguous company identities do not share a domain and newer snapshots win', () => {
	const employer = column('employer', 'Employer');
	assert.equal(companyPreview(row({ employer: cell('Other') }), company, [company, employer, domain]).domain, null);
	const newest = column('latest', 'Latest company profile', description.op);
	const data = row({
		description: cell('Old', { m: { companyIntel: { domain: 'example.com', source: 'brand', data: { description: 'Old' } } } }),
		latest: cell('New', { t: 2000, m: { companyIntel: { domain: 'example.com', source: 'brand', data: { description: 'New' } } } }),
	});
	assert.deepEqual(companyPreview(data, company, [company, domain, description, newest]).profiles[0].data, { description: 'New' });
	assert.deepEqual(populatedDetails({ empty: null, nested: { blank: [] }, zero: 0, no: false }), { zero: 0, no: false });
});
