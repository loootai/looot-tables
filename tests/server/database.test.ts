import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase, workspaceId, type Connection } from '../../src/lib/server/database';
import { WorkspaceError } from '../../src/lib/workspace';
import type { Account } from '../../src/lib/auth-identity';

const actor: Account = { issuer: 'https://database-tests.invalid', organization: { id: 'org', name: 'Org' }, user: { id: 'alice', email: 'alice@example.com', email_verified: true }, partition: 'alice' };

/** A Driver whose one connection records each statement and how it was released. */
function recording(failRollback = false) {
	const statements: string[] = [], releases: Array<Error | undefined> = [];
	const connection: Connection = {
		async query(text) {
			statements.push(text.split(' ').slice(0, 3).join(' '));
			if (text === 'ROLLBACK' && failRollback) throw new Error('socket closed');
			return { rows: [] };
		},
		release: (error) => { releases.push(error); },
	};
	return { statements, releases, database: createDatabase({ connect: async () => connection, read: async () => ({ rows: [] }) }) };
}

test('a write transaction for a workspace creates and locks it first; read-only transactions take one snapshot and lock nothing', async () => {
	const { statements, releases, database } = recording();
	assert.equal(await database.transaction(async (_sql, workspace) => workspace, { workspace: actor }), workspaceId(actor));
	assert.deepEqual(statements, ['BEGIN', 'INSERT INTO looot_tables.workspaces', 'SELECT id FROM', 'COMMIT']);
	statements.length = 0;
	await database.transaction(async () => {}, { workspace: actor, readOnly: true });
	assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL', 'COMMIT']);
	assert.deepEqual(releases, [undefined, undefined]);
});

test('a failed transaction rethrows its own error even when the rollback fails, and discards the broken connection', async () => {
	const healthy = recording();
	await assert.rejects(healthy.database.transaction(async () => { throw new WorkspaceError('Sheet changed.', 409); }), { status: 409 });
	assert.deepEqual(healthy.statements, ['BEGIN', 'ROLLBACK']);
	assert.deepEqual(healthy.releases, [undefined], 'a connection that rolled back is reused');
	const broken = recording(true);
	await assert.rejects(broken.database.transaction(async () => { throw new WorkspaceError('Sheet changed.', 409); }), { status: 409, message: 'Sheet changed.' });
	assert.match(String(broken.releases[0]), /socket closed/, 'a connection that cannot roll back is destroyed');
});
