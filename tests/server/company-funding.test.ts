import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENTITY_FIELDS, entityFieldOp } from '../../src/lib/entity-fields';
import { ColumnOpSchema, type Column } from '../../src/lib/types';
import { runOp } from '../../src/lib/server/enrich';
import { rowSchema } from '../../src/lib/workspace';
import { testAccess } from './access-fixture';

const access = (context = 'test-context') => testAccess({ keys: { context }, model: 'test-model' });
const funding = {
	total_usd: 40_000_000, stage: 'series_c', round_count: 3,
	latest_round: { type: 'series_b', date: '2026-03-02', amount_usd: 25_000_000 },
	rounds: [{ type: 'seed', date: '2023-06-01', amount_usd: 5_000_000 }],
};
const fields = ENTITY_FIELDS.company.find((group) => group.label === 'Funding')!.fields;
const column: Column = { id: 'company', name: 'Company', type: 'source', width: 200, createdAt: 1 };
const domain: Column = { ...column, id: 'domain', name: 'Domain' };

test('every Funding menu option binds to its row and returns a persistable value with full funding metadata', async (t) => {
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
		const request = new Request(input, options);
		assert.equal(request.url, 'https://api.context.dev/v1/company/search');
		assert.equal((await request.json()).query, 'example.com');
		requests++;
		return Response.json({ results: [
			{ name: 'Wrong company', domain: 'other.example', funding: { total_usd: 999 } },
			{ name: 'Example', domain: 'www.example.com', funding },
		], key_metadata: { credits_consumed: 2 } });
	});
	const values = [];
	for (const field of fields) {
		const op = ColumnOpSchema.parse(entityFieldOp(column, [column, domain], field));
		const result = await runOp(access(), op, { Company: 'Example', Domain: 'example.com' });
		assert.equal(result.error, undefined);
		assert.deepEqual(result.meta?.raw, funding);
		assert.equal(result.meta?.credits ?? 0, values.length === 0 ? 2 : 0);
		rowSchema.parse({ id: 'r1', sheetId: 's1', order: 0, createdAt: 1, cells: { funding: { v: result.value, s: 'done', t: 1, m: result.meta } } });
		values.push(result.value);
	}
	assert.deepEqual(values, [40_000_000, 'Series C', 'Series B', '2026-03-02', 25_000_000, 3]);
	assert.equal(requests, 1);
});

test('funding fields preserve zeroes and return empty cells for missing data or unrelated matches', async (t) => {
	let results: unknown[] = [{ name: 'Example', domain: 'example.com', funding: { total_usd: 0, stage: null, latest_round: null, round_count: 0 } }];
	t.mock.method(globalThis, 'fetch', async () => Response.json({ results }));
	const get = async (index: number) => runOp(access(`missing-funding-${JSON.stringify(results)}`), entityFieldOp(column, [column, domain], fields[index]), { Domain: 'example.com' });
	assert.equal((await get(0)).value, 0);
	assert.equal((await get(1)).value, null);
	assert.equal((await get(2)).value, null);
	assert.equal((await get(5)).value, 0);
	results = [{ name: 'Other', domain: 'other.example', funding }];
	assert.equal((await get(0)).value, null);
	results = [{ name: 'Example', domain: 'example.com' }];
	assert.equal((await get(0)).value, null);
});
