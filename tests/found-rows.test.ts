import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foundRecords, foundRowColumns, foundRowKey } from '../src/lib/found-rows';
import type { Column } from '../src/lib/types';

type SheetColumn = Pick<Column, 'name' | 'type' | 'format' | 'op'>;

test('the sheet and the server dedupe found rows on one identity', () => {
	for (const [stored, found] of [['acme.example', 'https://www.Acme.example/'], ['ACME.example', 'http://acme.example//'], ['linkedin.com/in/ada', ' https://www.linkedin.com/in/ada/ '], ['https://blog.example/post', 'blog.example/post/']]) {
		assert.equal(foundRowKey(stored), foundRowKey(found), `${stored} and ${found} are one row`);
	}
	assert.notEqual(foundRowKey('acme.example'), foundRowKey('acme.example/careers'));
	assert.notEqual(foundRowKey('www.acme.example'), foundRowKey('app.acme.example'));
	assert.deepEqual([null, undefined, '', '  '].map(foundRowKey), ['', '', '', '']);
});

const column = (name: string, rest: Partial<SheetColumn> = {}): SheetColumn => ({ name, type: 'source', ...rest });

test('found rows find their key column by role, then by legacy name, and never in an AI column', () => {
	const renamed = [column('Company'), column('Rival site', { type: 'enriched', format: 'website', op: { kind: 'ai', prompt: 'Rival?', output: 'text', research: 'web' } }), column('Company site', { format: 'website' })];
	const placed = foundRowColumns('companies', renamed);
	assert.equal(placed.key?.name, 'Company site');
	assert.ok(!placed.missing.some((entry) => entry.name === 'Website'));
	assert.deepEqual(foundRecords('companies', [{ Company: 'Acme', Domain: 'acme.example' }], renamed).records, [{ Company: 'Acme', 'Company site': 'acme.example' }]);
	assert.equal(foundRowColumns('companies', [column('Domain', { format: 'text' })]).key?.name, 'Domain', 'a legacy Domain column that lost its role');
	assert.equal(foundRowColumns('websites', [column('URL', { format: 'url' })]).key?.name, 'URL');
	assert.equal(foundRecords('websites', [{ URL: 'https://a.example' }], []).dedupeOn, 'Webpage', 'a missing key column is created under its layout name');
});

test('people photos become Name cell metadata rather than a column', () => {
	const { records, cellMeta, dedupeOn } = foundRecords('people', [{ Name: 'Ada', LinkedIn: 'https://linkedin.com/in/ada', 'Profile photo': 'https://cdn.example/ada.png', 'Company domain': 'acme.example' }], []);
	assert.deepEqual(records, [{ Name: 'Ada', LinkedIn: 'https://linkedin.com/in/ada', 'Company website': 'acme.example' }]);
	assert.deepEqual(cellMeta, [{ Name: { person: { name: 'Ada', avatarUrl: 'https://cdn.example/ada.png' } } }]);
	assert.equal(dedupeOn, 'LinkedIn');
});
