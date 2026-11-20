import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichmentValue } from '../src/lib/enrichment-value';
import { cellFromInput } from '../src/lib/formula-input';

test('missing enrichment responses become actual nulls without changing valid falsy values or content', () => {
 for (const value of [null, undefined, '', '  ', '-', ' — ', '–', 'null', ' NULL ']) assert.equal(enrichmentValue(value), null);
 for (const value of [0, false, 'No', 'N/A', '-5', 'some - text', '# Brief\n\nResearch']) assert.equal(enrichmentValue(value), value);
 assert.deepEqual(enrichmentValue([]), []);
});
test('explicit null input stores null, while quoted null remains literal text', () => {
 assert.equal(cellFromInput('null', { format: 'text' }).v, null);
 assert.equal(cellFromInput('null', { format: 'number' }).v, null);
 assert.equal(cellFromInput("'null", { format: 'text' }).v, 'null');
});
