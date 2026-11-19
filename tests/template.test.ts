import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coerceOutput, describeRow, formatValue, renderTemplate, toDomain, toUrl } from '../src/lib/template';
import { opDependencies, textReferences } from '../src/lib/references';

test('renderTemplate substitutes columns case-insensitively and blanks unknowns', () => {
	assert.equal(renderTemplate('https://{{Domain}}/pricing', { Domain: 'Sunrun.com' }), 'https://Sunrun.com/pricing');
	assert.equal(renderTemplate('{{ company }} <{{Email}}>', { Company: 'Acme', Email: null }), 'Acme <>');
	assert.equal(renderTemplate('{{Missing}}', {}), '');
});

test('textReferences and opDependencies find column names', () => {
	assert.deepEqual(textReferences('{{A}} and {{ B }} and {{A}}'), ['A', 'B']);
	assert.deepEqual(opDependencies({ kind: 'check', question: 'Is {{Company}} public?', page: { type: 'find', column: 'Domain', page: 'pricing' }, decider: 'jev', threshold: 0.5 }), ['Company', 'Domain']);
	assert.deepEqual(opDependencies({ kind: 'template', template: '{{X}}-{{Y}}' }), ['X', 'Y']);
});

test('describeRow lists non-empty values', () => {
	assert.equal(describeRow({ Name: 'Ada', Empty: null, Tags: ['a', 'b'], Ok: true }), 'Name: Ada\nTags: a, b\nOk: true');
});

test('toDomain and toUrl normalise inputs', () => {
	assert.equal(toDomain('https://www.Example.com/path?q=1'), 'example.com');
	assert.equal(toDomain('example.com:8080'), 'example.com');
	assert.equal(toUrl('example.com/pricing'), 'https://example.com/pricing');
	assert.equal(toUrl('not a url'), null);
	assert.equal(toUrl('http://a.b'), 'http://a.b');
});

test('coerceOutput converts to the requested type', () => {
	assert.equal(coerceOutput('1,200 employees', 'number'), 1200);
	assert.equal(coerceOutput('', 'number'), null);
	assert.equal(coerceOutput('true', 'boolean'), true);
	assert.equal(coerceOutput('false', 'boolean'), false);
	for (const value of ['yes', 'no', 'y', 'n', 'nope']) assert.equal(coerceOutput(value, 'boolean'), null);
	assert.deepEqual(coerceOutput('a, b; c', 'list'), ['a', 'b', 'c']);
	assert.equal(coerceOutput({ a: 1 }, 'text'), '{"a":1}');
});

test('coerceOutput number returns null for non-numeric text', () => {
	assert.equal(coerceOutput('unknown', 'number'), null);
	assert.equal(coerceOutput('N/A', 'number'), null);
	assert.equal(coerceOutput('-', 'number'), null);
	assert.equal(coerceOutput('$1.5M', 'number'), 1.5);
});


test('booleans stay true/false in display, templates and row context', () => {
	assert.equal(formatValue(true), 'true');
	assert.equal(formatValue(false), 'false');
	assert.equal(renderTemplate('{{Enabled}} / {{Disabled}}', { Enabled: true, Disabled: false }), 'true / false');
});
