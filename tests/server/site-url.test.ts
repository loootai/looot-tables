import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { indexingEnabled, OFFICIAL_SITE_URL, siteUrl } from '../../src/lib/server/deployment';

function configure(t: TestContext, values: Record<string, string>) {
	const keys = ['NEXT_PUBLIC_SITE_URL', 'ENRICHABLE_APP_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_ENV', 'ENRICHABLE_ALLOW_INDEXING'];
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	Object.assign(process.env, values);
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

test('the official apex and www resolve to the canonical www origin and are indexable', (t) => {
	for (const host of ['enrichable.io', 'www.enrichable.io']) {
		configure(t, { ENRICHABLE_APP_URL: `https://${host}` });
		assert.equal(siteUrl().origin, OFFICIAL_SITE_URL);
		assert.equal(indexingEnabled(), true);
	}
});

test('forks and lookalike hosts keep their own origin and stay out of search by default', (t) => {
	for (const host of ['my-copy.vercel.app', 'enrichable.io.attacker.test']) {
		configure(t, { NEXT_PUBLIC_SITE_URL: `https://${host}/path` });
		assert.equal(siteUrl().origin, `https://${host}`);
		assert.equal(indexingEnabled(), false);
	}
	configure(t, { VERCEL_PROJECT_PRODUCTION_URL: 'my-copy.vercel.app' });
	assert.equal(siteUrl().origin, 'https://my-copy.vercel.app');
	configure(t, { NEXT_PUBLIC_SITE_URL: 'https://my-copy.example', ENRICHABLE_ALLOW_INDEXING: 'true' });
	assert.equal(indexingEnabled(), true);
});

test('previews never index and invalid URLs fall back to localhost', (t) => {
	configure(t, { ENRICHABLE_APP_URL: 'https://www.enrichable.io', VERCEL_ENV: 'preview' });
	assert.equal(indexingEnabled(), false);
	configure(t, { NEXT_PUBLIC_SITE_URL: 'not a url' });
	assert.equal(siteUrl().origin, 'http://localhost:3000');
});
