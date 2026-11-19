import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usesNeonDriver } from '../../src/lib/database-driver';
import { LOOOT_API, loootApiUrl } from '../../src/lib/server/looot';

test('Neon hosts use Neon\'s driver and every other Postgres uses the normal one', () => {
	assert.equal(usesNeonDriver('postgres://ep-cool-123.us-east-2.aws.neon.tech/db', undefined), true);
	assert.equal(usesNeonDriver('postgres://db.neon.build/db', undefined), true);
	assert.equal(usesNeonDriver('postgres://tables@localhost:54329/looot_tables', undefined), false);
	assert.equal(usesNeonDriver('postgres://db.example.com:5432/app', undefined), false);
	assert.equal(usesNeonDriver('postgres://notneon.tech.example.com/app', undefined), false, 'only the neon.tech domain counts');
	assert.equal(usesNeonDriver('not a url', undefined), false);
});

test('DATABASE_DRIVER overrides the guess from the host', () => {
	assert.equal(usesNeonDriver('postgres://tables@localhost/db', 'neon'), true);
	assert.equal(usesNeonDriver('postgres://ep-1.neon.tech/db', 'postgres'), false);
});

test('looot is reached at api.looot.ai unless the server names another address', (t) => {
	const previous = process.env.LOOOT_API_URL;
	t.after(() => { if (previous === undefined) delete process.env.LOOOT_API_URL; else process.env.LOOOT_API_URL = previous; });
	delete process.env.LOOOT_API_URL;
	assert.equal(loootApiUrl(), LOOOT_API);
	process.env.LOOOT_API_URL = ' http://127.0.0.1:4546/ ';
	assert.equal(loootApiUrl(), 'http://127.0.0.1:4546');
});
