import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { compactDecrypt } from 'jose';
import { sealWorkspaceQueries, WORKSPACE_LIVE_SQL, SHEET_LIVE_SQL, PRESENCE_LIVE_SQL } from '../../src/lib/server/realtime';
import { workspaceId } from '../../src/lib/server/database';
import { WorkspaceStore } from '../../src/lib/server/workspace-store';
import type { Account } from '../../src/lib/auth-identity';
import type { Sheet } from '../../src/lib/types';
import { testDatabase } from '../support/database';

const actor = (user = 'alice', org = 'shared'): Account => ({ issuer: 'https://collaboration-tests.invalid', organization: { id: org, name: org }, user: { id: user, email: `${user}@example.com`, email_verified: true, name: user }, partition: user });
const sheet: Sheet = { id: 'sheet', name: 'Live sheet', columns: [{ id: 'value', name: 'Value', type: 'source', width: 180, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 };

test('live query capabilities fix workspace and sheet scope, expire quickly, and never reveal branch credentials', async (t) => {
	const bytes = randomBytes(32);
	const env = { NEON_REALTIME_URL: 'wss://example.neon.tech/', NEON_REALTIME_SECRET: `nrt_live_1${bytes.toString('base64url')}`, DATABASE_URL: 'postgresql://user:password@example.neon.tech/neondb', ENRICHABLE_REALTIME_ENABLED: 'true' };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	const bundle = await sealWorkspaceQueries(actor(), 'sheet');
	assert.ok(bundle.enabled);
	assert.equal(bundle.userId.length, 64);
	assert.ok(!JSON.stringify(bundle).includes(env.NEON_REALTIME_SECRET));
	for (const [sealed, sql, parameters] of [[bundle.index, WORKSPACE_LIVE_SQL, [workspaceId(actor())]], [bundle.sheet!, SHEET_LIVE_SQL, [workspaceId(actor()), 'sheet']], [bundle.presence!, PRESENCE_LIVE_SQL, [workspaceId(actor()), 'sheet']]] as const) {
		const decrypted = await compactDecrypt(sealed.capability, bytes);
		const claims = JSON.parse(new TextDecoder().decode(decrypted.plaintext));
		assert.equal(claims.sql, sql);
		assert.deepEqual(claims.parameters.map((p: { value: string }) => Buffer.from(p.value, 'base64').toString()), parameters);
		assert.equal(claims.exp - claims.iat, 60);
		assert.ok(sql.includes('workspace_id = $1'));
	}
	const stranger = await sealWorkspaceQueries(actor('eve', 'other'), 'sheet');
	assert.ok(stranger.enabled);
	assert.notEqual(stranger.sheet!.queryFingerprint, bundle.sheet!.queryFingerprint);
	process.env.ENRICHABLE_REALTIME_ENABLED = 'false';
	assert.deepEqual(await sealWorkspaceQueries(actor(), 'sheet'), { enabled: false });
});

test('presence is organization-scoped, validates cell ownership, prevents impersonation, expires and cascades on deletion', async (t) => {
	const { db, database } = await testDatabase(t);
	const store = new WorkspaceStore(database);
	await store.create(actor(), { sheet, rows: [{ id: 'row', sheetId: 'sheet', order: 0, cells: { value: { v: 'initial', s: 'done', t: 1 } }, createdAt: 1 }] });
	const clientId = randomUUID();
	const input = { clientId, sheetId: 'sheet', rowId: 'row', columnId: 'value' };
	await store.presence(actor('bob'), input, 1);
	await assert.rejects(store.presence(actor('eve', 'other'), input), /not found/);
	await assert.rejects(store.presence(actor(), input, 2), /another user/);
	await assert.rejects(store.presence(actor(), { ...input, clientId: randomUUID(), columnId: 'unknown' }, 2), /Column not found/);
	await assert.rejects(store.presence(actor(), { ...input, clientId: randomUUID(), rowId: 'foreign' }, 2), /Row not found/);
	await store.leavePresence(actor(), clientId);
	assert.equal((await db.query('SELECT * FROM enrichable.sheet_presence')).rows.length, 1);
	const returning = { ...input, clientId: randomUUID() };
	await store.presence(actor(), returning, 300_000);
	assert.equal((await db.query('SELECT * FROM enrichable.sheet_presence')).rows.length, 2);
	await store.presence(actor(), returning, 600_002);
	assert.equal((await db.query('SELECT * FROM enrichable.sheet_presence')).rows.length, 1);
	await store.remove(actor(), 'sheet', 1);
	assert.equal((await db.query('SELECT * FROM enrichable.sheet_presence')).rows.length, 0);
});
