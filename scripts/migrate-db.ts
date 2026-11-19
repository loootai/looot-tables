import { loadEnvConfig } from '@next/env';
import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { migrateDatabase } from './database-migrations';

async function migrate() {
	loadEnvConfig(process.cwd());
	const connection = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();
	if (!connection) throw new Error('Set DATABASE_URL to the dedicated Enrichable Neon database.');
	const sql = neon(connection);
	await migrateDatabase((statements) => sql.transaction(statements.map((statement) => sql.query(statement))), join(process.cwd(), 'migrations'));
	console.log('Enrichable workspace schema is ready.');
}
void migrate().catch(() => { console.error('Database migration failed. Check the dedicated Enrichable DATABASE_URL (or DATABASE_URL_UNPOOLED), database access, and migration files.'); process.exitCode = 1; });
