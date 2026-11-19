import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typedColumnValue, webColumnKind } from '../src/lib/column-format';
import { ENTITY_FIELDS, entityFieldOp } from '../src/lib/entity-fields';
import { ColumnOpSchema, type Column } from '../src/lib/types';
import { sheetSchema } from '../src/lib/workspace';

const column: Column = { id: 'w', name: 'Domain', type: 'source', width: 200, createdAt: 1 };
test('a legacy Domain header plays the website role and saved operation references keep its name', () => {
	assert.equal(webColumnKind(column), 'website');
	assert.equal(webColumnKind({ ...column, name: 'URL', format: 'url' }), 'webpage');
	assert.equal(webColumnKind({ ...column, format: 'text' }), null);
	for (const kind of ['website', 'webpage'] as const) {
		const source = { ...column, name: kind === 'website' ? 'Domain' : 'Article', format: kind };
		for (const field of ENTITY_FIELDS[kind].flatMap((group) => group.fields)) {
			const op = ColumnOpSchema.parse(entityFieldOp(source, [source], field));
			assert.equal(op.kind, 'scrape');
			if (op.kind === 'scrape') {
				assert.equal('column' in op.page && op.page.column, source.name);
				assert.equal(op.page.type, op.mode === 'url' ? 'find' : kind === 'website' ? 'homepage' : 'column');
			}
		}
		sheetSchema.parse({ id: 's', name: 'Web types', columns: [source], filters: [], sort: null, createdAt: 1, updatedAt: 1 });
	}
});
test('website inputs keep domains while webpage inputs preserve paths and queries', () => {
	assert.equal(typedColumnValue('https://www.example.com/pricing?plan=pro', { format: 'website' }), 'example.com');
	assert.equal(typedColumnValue('example.com/pricing?plan=pro', { format: 'webpage' }), 'https://example.com/pricing?plan=pro');
	for (const value of ['not a url', 'javascript:alert(1)', 'https://user:password@example.com']) assert.throws(() => typedColumnValue(value, { format: 'webpage' }));
});
