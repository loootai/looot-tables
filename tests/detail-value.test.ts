import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DetailValue } from '../src/components/sheet/detail-value';
import { detailValue } from '../src/lib/detail-value';

const render = (value: unknown) => renderToStaticMarkup(createElement(DetailValue, { value: detailValue(value) }));

test('JSON object details show readable fields, nested objects, lists, and links', () => {
	const html = render(JSON.stringify({ company_name: 'Example', employeeCount: 0, active: false, office: { city: 'San Francisco' }, founders: [{ name: 'Ada' }, { name: 'Grace' }], website: 'https://example.com' }));
	for (const text of ['<dl', '<dt', '<dd', 'Company name', 'Employee Count', 'San Francisco', '<ol', 'Ada', 'Grace', '>0<', '>false<', 'href="https://example.com"', 'rel="noopener noreferrer"']) assert.ok(html.includes(text), text);
	assert.ok(!html.includes('&quot;company_name&quot;'));
});

test('plain text and malformed JSON remain intact, with HTML escaped', () => {
	for (const value of ['{invalid', 'A plain description', '[unfinished']) assert.equal(detailValue(value), value);
	const html = render('<script>alert(1)</script>');
	assert.ok(html.includes('&lt;script&gt;'));
	assert.ok(!html.includes('<script>'));
	assert.ok(!render('javascript:alert(1)').includes('href='));
});

test('arrays and empty values have clear representations', () => {
	assert.ok(render('[{"name":"Example"}]').includes('<ol'));
	assert.ok(render({}).includes('No fields'));
	assert.ok(render([]).includes('No items'));
	assert.ok(render(null).includes('Empty'));
	assert.ok(render(false).includes('false'));
	assert.ok(render(0).includes('>0<'));
});
