import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredProviders } from '../../src/lib/operations';
import { PROVIDERS, type Provider } from '../../src/lib/organization-settings';
import { runOp } from '../../src/lib/server/enrich';
import type { ColumnOp } from '../../src/lib/types';
import { testAccess } from './access-fixture';

const row = { Name: 'Ada Lovelace', Domain: 'example.com', Email: 'ada@example.com', Website: 'https://example.com' };
const page = { type: 'column', column: 'Website' } as const;
const SAMPLES: Array<[string, ColumnOp]> = [
	['template', { kind: 'template', template: 'Hi {{Name}}' }],
	['template email draft', { kind: 'email-draft', mode: 'template', prompt: '', to: '{{Email}}', cc: '', bcc: '', subject: 'Hi', body: 'Hello {{Name}}' }],
	['AI email draft', { kind: 'email-draft', mode: 'ai', prompt: 'Intro', to: '{{Email}}', cc: '', bcc: '', subject: '', body: '' }],
	['Ask AI', { kind: 'ai', prompt: 'CEO of {{Domain}}?', output: 'text', research: 'web' }],
	['Ask AI reading a page', { kind: 'ai', prompt: 'CEO?', output: 'text', research: 'none', page }],
	['check', { kind: 'check', question: 'B2B?', decider: 'jev', threshold: 0.5 }],
	['check reading a page', { kind: 'check', question: 'Free plan?', decider: 'openai', threshold: 0.5, page }],
	['exact-text check on the row', { kind: 'check', question: 'Ada?', literal: 'Ada', decider: 'jev', threshold: 0.5 }],
	['exact-text check on a page', { kind: 'check', question: 'Free?', literal: 'free', decider: 'jev', threshold: 0.5, page }],
	['classify', { kind: 'classify', question: 'Segment?', options: [{ label: 'SMB' }, { label: 'Enterprise' }], decider: 'jev', page }],
	['score', { kind: 'score', question: 'Fit?', levels: ['Low', 'High'], decider: 'openai' }],
	['scrape', { kind: 'scrape', page, mode: 'highlights', query: 'Pricing', maxChars: 2000 }],
	['search', { kind: 'search', query: '{{Name}}', pick: 'url', numResults: 3 }],
	['company', { kind: 'company', domain: '{{Domain}}', field: 'industry' }],
	['person', { kind: 'person', name: '{{Name}}', company: '{{Domain}}', field: 'title' }],
	['email verify', { kind: 'email-verify', email: '{{Email}}', prefer: 'balanced' }],
	['phone find', { kind: 'phone-find', name: '{{Name}}', company: '', domain: '{{Domain}}', profileUrl: '', prefer: 'balanced' }],
	['any looot endpoint', { kind: 'looot', endpointId: 'job:people.email.find', inputs: { name: '{{Name}}', domain: '{{Domain}}' }, inputTypes: {}, unitCostUsd: 0.02, path: '', prefer: 'cheapest' }],
	['answer', { kind: 'answer', task: 'Funding of {{Domain}}', output: 'text', mode: 'fast' }],
	['email find', { kind: 'email-enrichment', name: '{{Name}}', company: '', domain: '{{Domain}}', profileUrl: '', prefer: 'balanced' }],
];

/** Every request succeeds with a page of text, so runs reach each credential check and fail only on content. */
const respond = async () => Response.json({ runId: 'run_operations', status: 'completed', outcome: 'hit', result: { results: [{ url: 'https://example.com/free', title: 'Free plan', snippet: 'Ada' }] }, normalized: { fields: { markdown: 'Page text: free plan, Ada', title: 'Page', email: 'ada@example.com', status: 'valid', phone: '+14155550100' } }, actualCost: 0 }, { status: 201 });
const keysExcept = (excluded: readonly Provider[]) => Object.fromEntries(PROVIDERS.filter((provider) => !excluded.includes(provider)).map((provider) => [provider, `test-${provider}-key`]));
const reason = async (op: ColumnOp, excluded: readonly Provider[]) => (await runOp(testAccess({ keys: keysExcept(excluded), model: 'test' }), op, row)).failure?.reason;

test('the catalog’s required providers are exactly the keys the executor demands', async (t) => {
	t.mock.method(globalThis, 'fetch', respond);
	for (const [name, op] of SAMPLES) {
		const needs = requiredProviders(op);
		assert.notEqual(await reason(op, []), 'credential_missing', `${name}: runs with every key`);
		assert.equal(await reason(op, PROVIDERS) === 'credential_missing', needs.length > 0, `${name}: runs without keys only when it needs none`);
		for (const need of needs) {
			assert.equal(await reason(op, need), 'credential_missing', `${name}: needs one of ${need.join(', ')}`);
			for (const provider of need) assert.notEqual(await reason(op, need.filter((entry) => entry !== provider)), 'credential_missing', `${name}: ${provider} alone is enough`);
		}
	}
});
