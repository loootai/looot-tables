import { loadEnvConfig } from '@next/env';
import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { Client } from 'pg';
import { usesNeonDriver } from '../src/lib/database-driver';
import { migrateDatabase } from './database-migrations';

async function migrate() {
	loadEnvConfig(process.cwd());
	const connection = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
	if (!connection) throw new Error('Set DATABASE_URL to the dedicated looot tables database.');
	const directory = join(process.cwd(), 'migrations');
	if (usesNeonDriver(connection)) {
		const sql = neon(connection);
		await migrateDatabase((statements) => sql.transaction(statements.map((statement) => sql.query(statement))), directory);
	} else {
		// Plain Postgres: one connection, one transaction for all migrations.
		const client = new Client({ connectionString: connection });
		await client.connect();
		try {
			await migrateDatabase(async (statements) => {
				await client.query('BEGIN');
				try { for (const statement of statements) await client.query(statement); await client.query('COMMIT'); }
				catch (error) { await client.query('ROLLBACK'); throw error; }
			}, directory);
		} finally { await client.end(); }
	}
	console.log('looot tables workspace schema is ready.');
}
void migrate().catch(() => { console.error('Database migration failed. Check the dedicated looot tables DATABASE_URL (or DATABASE_URL_UNPOOLED), database access, and migration files.'); process.exitCode = 1; });
