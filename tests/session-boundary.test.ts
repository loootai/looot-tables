import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundary, loginHref, sessionStatus, type Boundary } from '../src/components/app/session-boundary';

const account = { partition: 'a'.repeat(64), sessionId: 'session-one' };

test('only a 401 or a different session signs the tab out; other failures are transient', async () => {
	assert.equal(await sessionStatus(Response.json({ error: 'Sign in required' }, { status: 401 }), account), 'signed-out');
	assert.equal(await sessionStatus(Response.json(account), account), 'ok');
	assert.equal(await sessionStatus(Response.json({ ...account, sessionId: 'signed-in-elsewhere' }), account), 'signed-out');
	for (const status of [500, 502, 503, 504, 409]) await assert.rejects(sessionStatus(new Response('Bad gateway', { status }), account), /Retrying/);
});

test('transient errors after the first load become a banner instead of unmounting the app', () => {
	let state: Boundary = { phase: 'booting' };
	state = boundary(state, { type: 'transient', source: 'session', message: 'offline' });
	assert.deepEqual(state, { phase: 'failed', error: 'offline' }, 'Before the first load there is nothing to keep mounted');
	state = boundary(state, { type: 'retry' });
	assert.deepEqual(state, { phase: 'booting' });
	state = boundary(state, { type: 'loaded' });
	state = boundary(state, { type: 'transient', source: 'session', message: 'offline' });
	assert.deepEqual(state, { phase: 'ready', warning: { source: 'session', message: 'offline' } });
	state = boundary(state, { type: 'ok', source: 'sync' });
	assert.equal(state.phase === 'ready' && state.warning?.message, 'offline', 'A sync success does not hide a session problem');
	state = boundary(state, { type: 'ok', source: 'session' });
	assert.deepEqual(state, { phase: 'ready', warning: null });
	state = boundary(state, { type: 'signed-out' });
	assert.deepEqual(state, { phase: 'leaving', mounted: true });
	assert.deepEqual(boundary(state, { type: 'loaded' }), state, 'Leaving is final');
	assert.deepEqual(boundary({ phase: 'booting' }, { type: 'signed-out' }), { phase: 'leaving', mounted: false });
});

test('session expiry returns to the current page after signing in', () => {
	assert.equal(loginHref({ pathname: '/app/sheets/abc', search: '?view=1' }), '/login?returnTo=%2Fapp%2Fsheets%2Fabc%3Fview%3D1');
});
