import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Account } from '../../src/lib/auth-identity';
import { enrichmentEnabled } from '../../src/lib/server/enrichment-config';
import { includedRun, sharedRequest } from '../../src/lib/server/contextdevenrichmentwaterfall';
import { selfHostedAccount } from '../../src/lib/server/self-hosted';
import { serverKeyAvailability } from '../../src/lib/server/provider-access';
import { testAccess } from './access-fixture';
import { SESSION_COOKIE } from '../../src/lib/server/auth';

const account: Account = { issuer: 'https://www.context.dev', user: { id: 'user', email: 'user@example.com', email_verified: true }, organization: { id: 'org', name: 'Organization' }, partition: 'test' };

test('included credits require server secrets and an authenticated hosted organization', async (t) => {
	const values = { NODE_ENV: 'production', ENRICHABLE_APP_URL: 'https://www.enrichable.io', CONTEXT_IDENTITY_ISSUER: 'https://www.context.dev', ENRICHMENT_API_KEY: 'server-only-test-secret', ENRICHMENT_API_URL: 'https://gateway.example', DATABASE_URL: 'test', ENRICHABLE_PASSWORD: 'password' };
	const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	assert.equal(enrichmentEnabled(account), true);
	assert.equal(enrichmentEnabled(), false);
	assert.equal(enrichmentEnabled({ ...account, issuer: 'https://other-issuer.example' }), false);
	assert.equal(enrichmentEnabled({ ...account, issuer: 'https://dev.enrichable.localhost' }), false);
	for (const key of ['ENRICHMENT_API_KEY', 'ENRICHMENT_API_URL', 'DATABASE_URL'] as const) {
		process.env[key] = '   ';
		assert.equal(enrichmentEnabled(account), false);
		process.env[key] = values[key];
	}
	let reservations = 0, calls = 0;
	t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No gateway calls allowed'); });
	const access = async <T>(): Promise<T> => { reservations++; throw new Error('No budget access allowed'); };
	const request = sharedRequest('hunter', { name: 'Ada Lovelace', domain: 'example.com', company: '', profileUrl: '' });
	process.env.ENRICHABLE_APP_URL = 'https://private.example';
	assert.equal(enrichmentEnabled(account), false);
	for (const suffix of ['a', 'b']) {
		const token = `local.${suffix.repeat(43)}`;
		const local = selfHostedAccount(token)!;
		assert.equal(enrichmentEnabled(local), false);
		await assert.rejects(includedRun(testAccess({ account: local }), request, access), /Sign in/);
		for (const password of ['', 'wrong', 'password']) {
			const availability = await serverKeyAvailability(new Request('https://private.example/api/keys/verify', { headers: { cookie: `${SESSION_COOKIE}=${token}`, 'x-enrichable-password': password, 'x-enrichment-api-key': 'caller-supplied' } }));
			assert.equal(availability.enrichmentTrial, false);
		}
	}
	process.env.ENRICHABLE_APP_URL = values.ENRICHABLE_APP_URL;
	assert.equal(enrichmentEnabled(selfHostedAccount(`local.${'c'.repeat(43)}`)), false);
	delete process.env.ENRICHMENT_API_KEY;
	await assert.rejects(includedRun(testAccess({ account }), request, access), /Sign in/);
	assert.equal(reservations, 0);
	assert.equal(calls, 0);
});

test('signed localhost developer accounts can use the configured key only with developer auth enabled', async t => {
 const values = { NODE_ENV: 'development', ENRICHABLE_DEV_AUTH: 'true', ENRICHABLE_APP_URL: 'http://localhost:3000', ENRICHMENT_API_KEY: 'server-only-test-secret', ENRICHMENT_API_URL: 'https://gateway.example', DATABASE_URL: 'test', CONTEXT_OAUTH_CLIENT_ID: '', CONTEXT_OAUTH_CLIENT_SECRET: '' };
 const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
 Object.assign(process.env, values);
 t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
 const developer = { ...account, issuer: 'https://dev.enrichable.localhost', organization: { id: 'local-development', name: 'Local development' } };
 assert.equal(enrichmentEnabled(developer), true);
 assert.equal(enrichmentEnabled(), false);
 assert.equal(enrichmentEnabled({ ...developer, user: { ...developer.user, email_verified: false } } as unknown as Account), false);
 assert.equal(enrichmentEnabled(selfHostedAccount(`local.${'a'.repeat(43)}`)), false);
 process.env.ENRICHABLE_DEV_AUTH = 'false';
 assert.equal(enrichmentEnabled(developer), false);
 process.env.ENRICHABLE_DEV_AUTH = 'true';
 process.env.ENRICHABLE_APP_URL = 'https://private.example';
 assert.equal(enrichmentEnabled(developer), false);
 process.env.ENRICHABLE_APP_URL = 'http://localhost:3000';
 Object.assign(process.env, { NODE_ENV: 'production' });
 assert.equal(enrichmentEnabled(developer), false);
 Object.assign(process.env, { NODE_ENV: 'development' });
 delete process.env.ENRICHMENT_API_KEY;
 assert.equal(enrichmentEnabled(developer), false);
});
