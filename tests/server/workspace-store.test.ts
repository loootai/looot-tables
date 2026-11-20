import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { loadEnvConfig } from '@next/env';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import { withDatabase, workspaceId, type Database } from '../../src/lib/server/database';
import type { Account } from '../../src/lib/auth-identity';
import type { Row, Sheet } from '../../src/lib/types';
import { testDatabase } from '../support/database';

test('Postgres workspaces share by verified organization, isolate tenants, enforce quotas and reject stale edits', { timeout: 90_000 }, async (t) => {
	const live = process.env.LOOOT_TABLES_LIVE_DB_TEST === 'true';
	loadEnvConfig(process.cwd());
	const prefix = `test-${randomUUID()}`;
	const actor = (user: string, org = 'one', issuer = 'https://workspace-tests.invalid'): Account => ({ issuer, user: { id: user, email: `${user}@example.com`, email_verified: true }, organization: { id: `${prefix}-${org}`, name: 'Test workspace' }, partition: user });
	const alice = actor('alice'), bob = actor('bob'), stranger = actor('eve', 'two'), otherIssuer = actor('alice', 'one', 'https://other-issuer.invalid');
	if (!live) return scenario((await testDatabase(t)).database);
	await withDatabase(async (database) => {
		try { await scenario(database); }
		finally {
			await database.transaction(async (sql) => {
				for (const account of [alice, stranger, otherIssuer]) {
					await sql.query('DELETE FROM looot_tables.sheets WHERE workspace_id=$1', [workspaceId(account)]);
					await sql.query('DELETE FROM looot_tables.workspaces WHERE id=$1', [workspaceId(account)]);
				}
			});
		}
	});

	async function scenario(database: Database) {
		const store = new WorkspaceStore(database);
		const sheet = (id: string): Sheet => ({ id, name: id, columns: [{ id: 'name', name: 'Name', type: 'source', width: 200, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 });
		const row = (id: string, sheetId = 'shared'): Row => ({ id, sheetId, order: Number(id.replace(/\D/g, '')) || 0, cells: { name: { v: id, s: 'done', t: 1 } }, createdAt: 1 });
		await store.create(alice, { sheet: sheet('shared'), rows: [row('r0')] });
		assert.equal((await store.list(bob))[0].sheet.id, 'shared');
		assert.deepEqual(await store.list(stranger), []);
		assert.deepEqual(await store.list(otherIssuer), []);
		await assert.rejects(store.get(stranger, 'shared'), /not found/);
		await assert.rejects(store.patch(stranger, 'shared', { revision: 1, sheet: sheet('shared'), rows: [], deleted: [] }), /not found/);
		await assert.rejects(store.remove(stranger, 'shared', 1), /changed or was deleted/);
		assert.equal((await store.patch(bob, 'shared', { revision: 1, sheet: { ...sheet('shared'), name: 'Bob edited' }, rows: [], deleted: [] })).revision, 2);
		await assert.rejects(store.patch(alice, 'shared', { revision: 1, sheet: sheet('shared'), rows: [row('r1')], deleted: [] }), /Another member/);
		if (live) console.log('Live database: tenant isolation and stale-edit checks passed.');
		const creations = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => store.create(alice, { sheet: sheet(`s${i}`), rows: [] })));
		assert.equal(creations.filter((entry) => entry.status === 'fulfilled').length, 9);
		assert.equal((await store.list(bob)).length, 10);
		if (live) console.log('Live database: concurrent sheet-quota checks passed.');
		await store.patch(alice, 'shared', { revision: 2, sheet: sheet('shared'), rows: Array.from({ length: 999 }, (_, i) => row(`r${i + 1}`)), deleted: [] });
		assert.equal((await store.list(bob)).find((entry) => entry.sheet.id === 'shared')!.rowCount, 1000);
		await assert.rejects(store.patch(bob, 'shared', { revision: 3, sheet: sheet('shared'), rows: [row('overflow')], deleted: [] }), /1,000/);
		assert.equal((await store.get(bob, 'shared')).sheet.revision, 3);
		const whole = await store.snapshot(bob, 'shared');
		assert.deepEqual([whole.sheet.revision, whole.rows.length, whole.rows[0].id, whole.rows[999].id], [3, 1000, 'r0', 'r999'], 'one read returns every row in order');
		await assert.rejects(store.snapshot(stranger, 'shared'), /not found/);
		if (live) console.log('Live database: row-quota rollback checks passed.');
		await assert.rejects(store.get(bob, 'shared', 100, 2), /Sheet changed/);
		const page = await store.get(bob, 'shared', 900, 3);
		assert.equal(page.rows.length, 100);
		await assert.rejects(store.patch(alice, 's0', { revision: 1, sheet: sheet('s0'), rows: [row('r0', 's0')], deleted: [] }), /another sheet/);
		await assert.rejects(store.patch(alice, 'shared', { revision: 3, sheet: sheet('shared'), rows: [row('foreign', 's0')], deleted: [] }), /Rows must belong/);
		await store.remove(bob, 'shared', 3);
		assert.equal((await store.list(alice)).length, 9);
		await store.create(bob, { sheet: sheet('replacement'), rows: [] });
		assert.equal((await store.list(alice)).length, 10);
	}
});
