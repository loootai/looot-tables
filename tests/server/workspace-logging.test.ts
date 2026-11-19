import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logWorkspaceError, storageErrorDetails } from '../../src/lib/server/workspace-logging';

test('storage logs preserve nested driver, aggregate and socket errors as parseable JSON', (t) => {
	const socket = Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT', syscall: 'connect', address: '192.0.2.1', port: 443 });
	const driver = Object.assign(new Error('Database connection failed'), { sourceError: { error: new AggregateError([socket], 'All connection attempts failed') } });
	const error = new Error('Storage unavailable', { cause: driver });
	const calls: unknown[][] = [];
	t.mock.method(console, 'error', (...args: unknown[]) => calls.push(args));
	logWorkspaceError(error, { requestId: 'request-123', operation: 'sheets.patch', phase: 'storage', durationMs: 10002 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].length, 1);
	const logged = JSON.parse(String(calls[0][0]));
	assert.equal(logged.event, 'workspace.storage.error');
	assert.equal(logged.operation, 'sheets.patch');
	assert.equal(logged.requestId, 'request-123');
	assert.equal(logged.durationMs, 10002);
	assert.ok(logged.timestamp);
	const nested = logged.error.cause.sourceError.error.errors[0];
	assert.equal(nested.code, 'ETIMEDOUT');
	assert.equal(nested.port, 443);
	assert.match(nested.stack, /connect timed out/);
});

test('storage diagnostics redact secrets and omit driver SQL, parameters and row details', (t) => {
	const previous = { DATABASE_URL: process.env.DATABASE_URL, CONTEXT_DEV_API_KEY: process.env.CONTEXT_DEV_API_KEY };
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	process.env.DATABASE_URL = 'postgresql://test:db-secret@db.example/test';
	process.env.CONTEXT_DEV_API_KEY = 'context-test-secret';
	const error = Object.assign(new Error(`Failed ${process.env.DATABASE_URL} context-test-secret https://user:pass@example.com/query?token=hidden Bearer auth-secret password=hidden-password`), {
		code: '08006', query: 'INSERT private customer data', parameters: ['customer@example.com'], detail: 'private row contents',
		cause: new Error('wss://user:pass@db.example/socket?secret=value'),
	});
	const details = storageErrorDetails(error);
	const serialized = JSON.stringify(details);
	assert.equal(details.code, '08006');
	assert.match(serialized, /redacted/);
	for (const secret of ['db-secret', 'context-test-secret', 'user:pass', 'token=hidden', 'auth-secret', 'hidden-password', 'private customer', 'customer@example.com', 'private row']) assert.ok(!serialized.includes(secret), secret);
});

test('storage diagnostics handle circular causes and bound error depth and aggregate size', () => {
	const circular = new Error('circular');
	circular.cause = circular;
	assert.deepEqual(storageErrorDetails(circular).cause, { circular: true });
	let deep = new Error('root');
	for (let i = 0; i < 10; i++) deep = new Error('wrapper', { cause: deep });
	assert.match(JSON.stringify(storageErrorDetails(deep)), /"truncated":true/);
	const aggregate = storageErrorDetails(new AggregateError(Array.from({ length: 20 }, () => new Error('socket')), 'connections'));
	assert.equal((aggregate.errors as unknown[]).length, 8);
	assert.deepEqual(storageErrorDetails('plain failure'), { message: 'plain failure' });
});
