import assert from 'node:assert/strict';
import { test } from 'node:test';
import type ContextDev from 'context.dev';
import { ENTITY_FIELDS, entityFieldOp } from '../../src/lib/entity-fields';
import { ColumnOpSchema, type Column } from '../../src/lib/types';
import { runOp } from '../../src/lib/server/enrich';
import { testAccess } from './access-fixture';

type Params = Record<string, unknown> & { url?: string; parseParams?: { parser?: string } };
/** An in-memory Context.dev client behind the access adapter: no SDK wire payloads or network. */
const contextWith = (web: { scrape?: (params: Params) => unknown; mapUrls?: (params: Params) => unknown }) => testAccess({ keys: { context: 'test-web-actions' }, model: 'test-model' }, {
	context: (apiKey) => { assert.equal(apiKey, 'test-web-actions'); return { web: { scrape: async (params: Params) => web.scrape!(params), mapUrls: async (params: Params) => web.mapUrls!(params) } } as unknown as ContextDev; },
});
const source: Column = { id: 'web', name: 'Webpage', type: 'source', format: 'webpage', width: 240, createdAt: 1 };

test('web actions use the row URL and the correct Context output without OpenAI', async () => {
	const requests: Params[] = [];
	const access = contextWith({
		mapUrls: (params) => {
			assert.equal(params.domain, 'example.com');
			assert.equal(params.maxLinks, 100);
			return { urls: [{ url: 'https://example.com/pricing' }], key_metadata: { credits_consumed: 2 } };
		},
		scrape: (params) => {
			requests.push(params);
			assert.equal(params.url, 'https://example.com/docs?lang=en');
			const parser = params.parseParams?.parser;
			const key = parser === 'phone-numbers' ? 'phone_numbers' : String(parser);
			return {
				markdown: { success: true, data: '# Docs\n\n[Guide](https://example.com/guide)\n![Diagram](https://example.com/diagram.png)' },
				metadata: { title: 'Documentation' },
				html: { success: true, data: '<h1>Docs</h1>' },
				images: { success: true, data: [{ url: 'https://example.com/image.png' }, { url: 'data:image/png;base64,AAAA' }] },
				parsed: { success: true, data: { [key]: parser === 'links' ? [{ url: 'https://example.com/guide' }, { url: 'https://example.com/guide' }] : parser === 'emails' ? [{ email: 'hello@example.com' }] : [{ phone: '+14155550100' }] } },
				json: { success: true, data: { product: 'Example' } },
				key_metadata: { credits_consumed: 2 },
			};
		},
	});
	const expected: Record<string, unknown> = {
		markdown: '# Docs\n\n[Guide](https://example.com/guide)\n![Diagram](https://example.com/diagram.png)',
		links: ['https://example.com/guide'], title: 'Documentation', html: '<h1>Docs</h1>',
		images: ['https://example.com/image.png'], emails: ['hello@example.com'], 'phone-numbers': ['+14155550100'],
	};
	for (const field of ENTITY_FIELDS.webpage[0].fields.filter((field) => field.field !== 'extract')) {
		const result = await runOp(access, ColumnOpSchema.parse(entityFieldOp(source, [source], field)), { Webpage: 'https://example.com/docs?lang=en' });
		assert.equal(result.error, undefined);
		assert.deepEqual(result.value, expected[field.field]);
		assert.equal(result.meta?.pageUrl, 'https://example.com/docs?lang=en');
		assert.ok(result.meta?.sources?.includes('https://example.com/docs?lang=en'));
	}
	assert.ok(requests.some((request) => (request.markdownParams as { includeLinks?: boolean })?.includeLinks));
	const map = ENTITY_FIELDS.website[0].fields.find((field) => field.field === 'map')!;
	const result = await runOp(access, entityFieldOp({ ...source, name: 'Website', format: 'website' }, [], map), { Website: 'example.com' });
	assert.deepEqual(result.value, ['https://example.com/pricing']);
	const extraction = await runOp(access, { kind: 'scrape', page: { type: 'column', column: 'Webpage' }, mode: 'extract', fields: [{ name: 'product', description: 'Product name' }], maxChars: 2000 }, { Webpage: 'https://example.com/docs?lang=en' });
	assert.equal(extraction.value, 'Example');
});

test('failed and empty page outputs are handled and large lists are bounded', async () => {
	const access = contextWith({
		scrape: ({ url = '' }) => url.includes('failed')
			? { parsed: { success: false, message: 'Page blocked' } }
			: { parsed: { success: true, data: { links: url.includes('empty') ? [] : Array.from({ length: 120 }, (_, i) => ({ url: `https://example.com/${i}` })) } } },
	});
	const op = { kind: 'scrape', mode: 'links', page: { type: 'column', column: 'Webpage' }, maxChars: 20000 } as const;
	assert.match((await runOp(access, op, { Webpage: 'https://example.com/failed' })).error ?? '', /Page blocked/);
	assert.deepEqual((await runOp(access, op, { Webpage: 'https://example.com/empty' })).value, []);
	assert.equal(((await runOp(access, op, { Webpage: 'https://example.com/large' })).value as string[]).length, 100);
});
