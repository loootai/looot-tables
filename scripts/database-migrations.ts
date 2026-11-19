import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

type MigrationTransaction = (statements: string[]) => Promise<unknown>;

/** Apply the repeatable schema in one transaction, serialized across deployments. */
export async function migrateDatabase(transaction: MigrationTransaction, directory: string) {
	const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
	if (!files.length) throw new Error('No database migrations found.');
	const statements = ["SELECT pg_advisory_xact_lock(hashtext('enrichable:migrations'))"];
	for (const file of files) {
		const migration = await readFile(join(directory, file), 'utf8');
		statements.push(...migration.split(';').map((statement) => statement.trim()).filter(Boolean));
	}
	await transaction(statements);
}
