import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrateDatabase } from '../scripts/database-migrations';

const transaction = (db: PGlite) => (statements: string[]) => db.transaction(async (tx) => {
	for (const statement of statements) await tx.exec(statement);
});

test('deployment migrations initialize an empty database and preserve data on redeploy', async (t) => {
	const db = new PGlite();
	t.after(() => db.close());
	await migrateDatabase(transaction(db), resolve('migrations'));
	await db.exec("INSERT INTO enrichable.workspaces (id,issuer,organization_id,name) VALUES ('preserved','https://example.com','one','Existing workspace'); INSERT INTO enrichable.openai_budgets (id,spent_nano) VALUES ('preserved',123);");
	assert.deepEqual((await db.query('SELECT kind, cap_nano::text FROM enrichable.credit_limits ORDER BY kind')).rows, [
		{ kind: 'enrichment', cap_nano: '1000000000000' }, { kind: 'openai', cap_nano: '1000000000000' }, { kind: 'typesafe', cap_nano: '100000000000' },
	]);
	await db.query("UPDATE enrichable.credit_limits SET cap_nano=2500000000000 WHERE kind='openai'");
	await migrateDatabase(transaction(db), resolve('migrations'));
	assert.equal((await db.query<{ cap: string }>("SELECT cap_nano::text AS cap FROM enrichable.credit_limits WHERE kind='openai'")).rows[0].cap, '2500000000000');
	assert.deepEqual((await db.query('SELECT name FROM enrichable.workspaces WHERE id=$1', ['preserved'])).rows, [{ name: 'Existing workspace' }]);
	assert.deepEqual((await db.query('SELECT spent_nano::int AS spent FROM enrichable.openai_budgets WHERE id=$1', ['preserved'])).rows, [{ spent: 123 }]);
	for (const name of ['sheets', 'sheet_rows', 'mcp_keys', 'organization_providers', 'company_research', 'enrichment_budgets']) {
		assert.equal((await db.query<{ name: string }>('SELECT to_regclass($1)::text AS name', [`enrichable.${name}`])).rows[0].name, `enrichable.${name}`);
	}
});

test('a failed migration rolls back earlier files in the same deployment', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'enrichable-migration-failure-'));
	const db = new PGlite();
	t.after(async () => { await db.close(); await rm(directory, { recursive: true }); });
	await writeFile(join(directory, '001_schema.sql'), 'CREATE SCHEMA enrichable; CREATE TABLE enrichable.example (id int);');
	await writeFile(join(directory, '002_failure.sql'), 'SELECT missing_migration_function();');
	await assert.rejects(migrateDatabase(transaction(db), directory), /missing_migration_function/);
	assert.equal((await db.query<{ name: string | null }>("SELECT to_regclass('enrichable.example')::text AS name")).rows[0].name, null);
});

test('migration setup rejects an empty migration directory before writing', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'enrichable-no-migrations-'));
	t.after(() => rm(directory, { recursive: true }));
	let writes = 0;
	await assert.rejects(migrateDatabase(async () => { writes++; }, directory), /No database migrations/);
	assert.equal(writes, 0);
});

test('the deployment migration command exits unsuccessfully when storage is unconfigured', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'enrichable-no-connection-'));
	t.after(() => rm(directory, { recursive: true }));
	const require = createRequire(import.meta.url);
	const result = spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href, resolve('scripts/migrate-db.ts')], {
		cwd: directory,
		env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' },
		encoding: 'utf8',
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Database migration failed/);
	assert.doesNotMatch(result.stdout, /schema is ready/);
});
