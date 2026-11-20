import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentBrand, documentClientDomain } from '../src/lib/document-branding';
import type { Row, Sheet } from '../src/lib/types';

test('brand selection prefers light-compatible wordmarks and validates accent colors', () => {
 const brand = documentBrand({ title: 'Example', colors: [{ hex: 'invalid' }, { hex: '#f05' }], logos: [{ mode: 'dark', type: 'logo', url: 'https://example.com/white.png' }, { type: 'icon', url: 'https://example.com/icon.png' }, { mode: 'light', type: 'logo', url: 'https://example.com/logo.png' }] }, 'example.com');
 assert.equal(brand.logoUrl, 'https://example.com/logo.png');
 assert.equal(brand.accentColor, '#f05');
 assert.equal(documentBrand({ logos: [{ url: 'javascript:alert(1)' }] }, 'example.com').logoUrl, undefined);
});

test('client defaults require an unambiguous row company and do not use arbitrary links', () => {
 const sheet = { columns: [{ id: 'a', name: 'Company' }, { id: 'b', name: 'Source' }, { id: 'c', name: 'Company domain' }] } as Pick<Sheet, 'columns'>;
 const row: Row = { id: 'row', sheetId: 'sheet', order: 0, createdAt: 0, cells: { a: { v: 'Acme', s: 'done', t: 0, m: { organization: { name: 'Acme', domain: 'acme.com' } } }, b: { v: 'https://news.com', s: 'done', t: 0 } } };
 assert.equal(documentClientDomain(sheet, row), 'acme.com');
 row.cells.c = { v: 'other.com', s: 'done', t: 0 };
 assert.equal(documentClientDomain(sheet, row), '');
 delete row.cells.c;
 row.cells.a.v = 'Changed company';
 assert.equal(documentClientDomain(sheet, row), '');
});
