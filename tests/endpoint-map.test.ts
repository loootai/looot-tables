import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyInputMap, coerceValue, estimateCost, formatUsd, getPath, placeholdersIn, suggestInputMap } from '../src/lib/endpoint-map';
import { opDependencies, renameOpReferences } from '../src/lib/references';
import { ColumnOpInputSchema } from '../src/lib/operations';

test('a template that is one reference passes the cell as it is, so lists and numbers keep their type', () => {
	const row = { Domain: 'acme.com', Tags: ['a', 'b'], Employees: 42, Empty: '  ' };
	const { input, empty } = applyInputMap({ domain: '{{Domain}}', tags: '{{Tags}}', size: '{{Employees}}', note: '{{Empty}}' }, row);
	assert.deepEqual(input, { domain: 'acme.com', tags: ['a', 'b'], size: 42 });
	assert.deepEqual(empty, ['note']);
});

test('a template with text around its references renders them, and is empty only when every reference is', () => {
	const row = { Domain: 'acme.com', First: 'Ada', Last: '' };
	assert.deepEqual(applyInputMap({ url: 'https://{{Domain}}/about', name: '{{First}} {{Last}}', fixed: 'US', gone: '{{Nope}} and {{Last}}' }, row), {
		input: { url: 'https://acme.com/about', name: 'Ada ', fixed: 'US' },
		empty: ['gone'],
	});
	assert.deepEqual(placeholdersIn('{{ A }} and {{B}} and {{A}}'), ['A', 'B']);
});

test('column names match without regard to case, as references do everywhere else', () => {
	assert.deepEqual(applyInputMap({ domain: '{{company website}}' }, { 'Company website': 'acme.com' }).input, { domain: 'acme.com' });
});

test('mapped values take the JSON type the endpoint declares', () => {
	assert.equal(coerceValue('12', 'integer'), 12);
	assert.equal(coerceValue('12x', 'number'), '12x');
	assert.equal(coerceValue('Yes', 'boolean'), true);
	assert.equal(coerceValue('0', 'boolean'), false);
	assert.deepEqual(coerceValue('acme.com', 'array'), ['acme.com']);
	assert.deepEqual(coerceValue(['a'], 'array'), ['a']);
	assert.equal(coerceValue('text', undefined), 'text');
	assert.deepEqual(applyInputMap({ limit: '{{N}}', ids: '{{Id}}' }, { N: '5', Id: 'x' }, { limit: 'integer', ids: 'array' }).input, { limit: 5, ids: ['x'] });
});

test('inputs whose names match a column are mapped on their own', () => {
	assert.deepEqual(suggestInputMap(['domain', 'First Name', 'extra'], ['Domain', 'first_name', 'Notes']), { domain: '{{Domain}}', 'First Name': '{{first_name}}', extra: '' });
});

test('an answer is read by a dot path, and an empty path keeps all of it', () => {
	const answer = { data: [{ email: 'ada@example.com' }] };
	assert.equal(getPath(answer, 'data.0.email'), 'ada@example.com');
	assert.equal(getPath(answer, 'data.1.email'), null);
	assert.deepEqual(getPath(answer, ''), answer);
});

test('cost for the selected rows is the per-row price times the rows, and sub-cent prices keep their digits', () => {
	assert.equal(estimateCost(0.0064, 250), 1.6);
	assert.equal(estimateCost(null, 10), null);
	assert.equal(formatUsd(0), '$0');
	assert.equal(formatUsd(0.0064), '$0.0064');
	assert.equal(formatUsd(0.03), '$0.03');
	assert.equal(formatUsd(0.064), '$0.064');
	assert.equal(formatUsd(1.6), '$1.60');
	assert.equal(formatUsd(null), 'price unknown');
});

test('the any-endpoint column reads its columns from every input template, follows renames, and needs a mapped input', () => {
	const op = ColumnOpInputSchema.parse({ kind: 'looot', endpointId: 'tomba-email-finder', inputs: { domain: '{{Domain}}', name: '{{First}} {{Last}}', country: 'US' } });
	assert.equal(op.kind === 'looot' && op.unitCostUsd, null, 'the price is unknown until an endpoint is picked');
	assert.deepEqual(opDependencies(op), ['Domain', 'First', 'Last']);
	const renamed = renameOpReferences(op, 'domain', 'Website');
	assert.deepEqual(renamed.kind === 'looot' && renamed.inputs, { domain: '{{Website}}', name: '{{First}} {{Last}}', country: 'US' });
	assert.equal(ColumnOpInputSchema.safeParse({ kind: 'looot', endpointId: 'x', inputs: { domain: ' ' } }).success, false);
});
