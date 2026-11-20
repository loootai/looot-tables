import { resolve } from 'node:path';
import { after } from 'node:test';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { migrateDatabase } from '../../scripts/database-migrations';
import { createDatabase, type Database } from '../../src/lib/server/database';

/* The PGlite Adapter: the production schema (every migration, applied once per test process) cloned per test, behind the
   same transaction Implementation the server runs on Neon. */

let migrated: Promise<PGlite> | undefined;
after(async () => { await (await migrated)?.close(); });
function template() {
	return migrated ??= (async () => {
		const db = new PGlite();
		await migrateDatabase((statements) => db.transaction(async (tx) => { for (const statement of statements) await tx.exec(statement); }), resolve('migrations'));
		return db;
	})();
}

/** PGlite is one session, so transactions and reads take turns on it like clients of a one-connection pool. */
export function pgliteDatabase(db: PGliteInterface): Database {
	let queue = Promise.resolve();
	const connect = async () => {
		const previous = queue;
		let release!: () => void;
		queue = new Promise<void>((done) => { release = done; });
		await previous;
		return { query: (text: string, values?: unknown[]) => db.query<Record<string, unknown>>(text, values), release: () => release() };
	};
	return createDatabase({
		connect,
		async read(text, values) {
			const session = await connect();
			try { return await session.query(text, values); } finally { session.release(); }
		},
	});
}

/** A fresh copy of the migrated database for one test, closed when the test ends. `db` is for arranging and inspecting rows. */
export async function testDatabase(t: { after(fn: () => Promise<void>): void }) {
	const db = await (await template()).clone();
	t.after(() => db.close());
	return { db, database: pgliteDatabase(db) };
}
