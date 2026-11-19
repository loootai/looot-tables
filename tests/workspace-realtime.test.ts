import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRESENCE_TTL_MS } from '../src/lib/collaboration';
import { memoryRealtime, settle } from './support/memory-realtime';

/* WorkspaceRealtime on the in-memory Adapter: the clock, server, socket and tab are all driven by the test. Status
   matters beyond the dot, because the workspace stops polling only while it reads 'live'. */

const connected = async (options?: Parameters<typeof memoryRealtime>[0]) => {
	const t = memoryRealtime(options);
	t.realtime.start(); t.realtime.setSheet('s1');
	await settle();
	return t;
};

test('a deployment without realtime asks once, then polls with a steady dot and no presence traffic', async () => {
	const t = memoryRealtime();
	t.server = async () => ({ enabled: false });
	t.realtime.start();
	await settle();
	assert.equal(t.status(), 'polling');
	const steady = t.snapshots.length;
	t.realtime.setSheet('s1'); t.realtime.setSelection('r1', 'c1');
	t.setHidden(true); await t.advance(10 * 60_000); t.setHidden(false);
	await t.advance(60 * 60_000);
	t.setOnline(false);
	assert.equal(t.status(), 'offline');
	t.setOnline(true); await t.advance(5 * 60_000);
	t.realtime.setSheet('s2'); t.pagehide(); t.realtime.close();
	assert.deepEqual(t.bundles, [undefined]);
	assert.deepEqual(t.snapshots.slice(steady).map((snapshot) => snapshot.status).filter((status) => status !== 'polling'), ['offline']);
	assert.deepEqual(t.connections, []);
	assert.deepEqual(t.requests, []);
});

test('the tab reads live only when every subscription is, even if one reports live while the rest subscribe', async () => {
	const t = await connected({ instant: ['index'] });
	assert.deepEqual(t.bundles, [undefined, 's1']);
	assert.deepEqual(t.open().map((subscription) => subscription.name), ['index', 'sheet', 'presence']);
	assert.equal(t.status(), 'connecting');
	t.live('sheet');
	assert.equal(t.status(), 'connecting');
	assert.ok(t.snapshots.every((snapshot) => snapshot.status !== 'live'));
	t.live('presence');
	assert.equal(t.status(), 'live');
	assert.equal(t.snapshots.at(-1)?.userId, 'me');
	t.emit('sheet', { status: 'stale' });
	assert.equal(t.status(), 'reconnecting');
	t.emit('sheet', { status: 'connecting' });
	assert.equal(t.status(), 'reconnecting');
	t.live('sheet');
	assert.equal(t.status(), 'live');
});

test('live bursts coalesce into one cache write of the latest rows', async () => {
	const t = await connected();
	t.live('index', 'presence');
	for (const revision of [2, 3, 4]) t.emit('sheet', { status: 'live', data: [{ kind: 'sheet', id: 's1', revision }] });
	await t.advance(40);
	assert.deepEqual(t.applied.filter((entry) => entry.kind === 'sheet'), [{ kind: 'sheet', rows: [{ kind: 'sheet', id: 's1', revision: 4 }] }]);
});

test('a hidden tab keeps its connection for five minutes without applying sheet data, then pauses until shown', async () => {
	const t = await connected();
	t.live('index', 'sheet', 'presence');
	await t.advance(1_000);
	const applied = t.applied.length;
	t.setHidden(true);
	await settle();
	assert.equal(t.status(), 'live');
	assert.deepEqual(t.requests.slice(-2), ['write s1:: final start', 'write s1:: final ok']);
	const requests = t.requests.length;
	t.emit('sheet', { status: 'live', data: [{ kind: 'sheet', id: 's1', revision: 9 }] });
	await t.advance(4 * 60_000);
	assert.equal(t.applied.length, applied);
	assert.equal(t.requests.length, requests, 'no heartbeats while hidden');
	t.setHidden(false);
	await settle();
	assert.deepEqual(t.applied.at(-1), { kind: 'sheet', rows: [{ kind: 'sheet', id: 's1', revision: 9 }] });
	assert.equal(t.connections.length, 1);
	t.setHidden(true);
	await t.advance(5 * 60_000 - 1);
	assert.equal(t.status(), 'live');
	await t.advance(1);
	assert.equal(t.status(), 'paused');
	assert.deepEqual(t.open(), []);
	assert.equal(t.connections[0].open, false);
	const fetched = t.bundles.length;
	await t.advance(60 * 60_000);
	assert.equal(t.bundles.length, fetched);
	t.setHidden(false);
	await settle();
	assert.equal(t.bundles.length, fetched + 1);
	assert.equal(t.status(), 'connecting');
	t.live('index', 'sheet', 'presence');
	assert.equal(t.status(), 'live');
});

test('transient failures poll and retry after 30 s; an offline tab waits for the network instead', async () => {
	const t = memoryRealtime();
	let failures = 1;
	t.server = async (sheetId) => { if (failures-- > 0) throw new Error('Live subscription unavailable.'); return t.enabled(sheetId); };
	t.realtime.start();
	await settle();
	assert.equal(t.status(), 'polling');
	await t.advance(29_999);
	assert.equal(t.bundles.length, 1);
	await t.advance(1);
	assert.equal(t.bundles.length, 2);
	t.live('index');
	assert.equal(t.status(), 'live');
	t.emit('index', { status: 'error' });
	assert.equal(t.status(), 'polling');
	assert.equal(t.connections[0].open, false);
	await t.advance(30_000);
	t.live('index');
	assert.equal(t.status(), 'live');
	t.setOnline(false);
	assert.equal(t.status(), 'offline');
	assert.deepEqual(t.open(), []);
	await t.advance(10 * 60_000);
	assert.equal(t.bundles.length, 3);
	t.setOnline(true);
	await settle();
	assert.equal(t.bundles.length, 4);
	t.live('index');
	assert.equal(t.status(), 'live');
});

test('presence requests run one at a time in call order; a failed write never blocks the leave behind it', async () => {
	const t = await connected({ presenceMs: 1_000 });
	t.failPresence = 1;
	t.live('index', 'sheet', 'presence');
	t.realtime.setSelection('r1', 'c1');
	await t.advance(180);
	t.realtime.setSheet('s2');
	await t.advance(5_000);
	// The selection write was for a sheet this tab had already left, so it is dropped rather than sent late.
	assert.deepEqual(t.requests, ['write s1:: start', 'write s1:: failed', 'leave start', 'leave ok']);
	t.live('index', 'sheet', 'presence');
	await t.advance(5_000);
	t.realtime.setSelection('r2', 'c2');
	t.realtime.close();
	await t.advance(5_000);
	assert.deepEqual(t.requests.slice(4), ['write s2:: start', 'write s2:: ok', 'leave start', 'leave ok']);
	t.setHidden(true); t.setHidden(false); t.setOnline(false); t.setOnline(true);
	await t.advance(60 * 60_000);
	assert.equal(t.requests.length, 8);
	assert.equal(t.bundles.length, 3);
});

test('renewals share one capability request; exhausted renewal retries; a server that turns realtime off stops for good', async () => {
	const t = await connected();
	t.live('index', 'sheet', 'presence');
	await t.advance(50_000);
	const before = t.bundles.length;
	const renewed = await Promise.all(t.open().map((subscription) => subscription.on.renew()));
	assert.equal(t.bundles.length, before + 1);
	assert.deepEqual(renewed.map((query) => query.queryFingerprint), ['index', 'sheet', 'presence']);
	assert.equal(t.status(), 'live');
	t.subscription('sheet').on.exhausted();
	assert.equal(t.status(), 'polling');
	await t.advance(30_000);
	t.live('index', 'sheet', 'presence');
	assert.equal(t.status(), 'live');
	t.server = async () => ({ enabled: false });
	await t.advance(2_000);
	await assert.rejects(t.subscription('index').on.renew(), /unavailable/);
	assert.equal(t.status(), 'polling');
	assert.deepEqual(t.open(), []);
	const fetched = t.bundles.length;
	t.realtime.setSheet('s2'); t.setHidden(true); t.setHidden(false);
	await t.advance(60 * 60_000);
	assert.equal(t.bundles.length, fetched);
});

test('collaborators leave out this tab, name your other tabs, and expire on a local timer', async () => {
	const t = await connected();
	t.live('index', 'sheet');
	const peer = (client_id: string, user_id: string, name: string, updated_at: number) => ({ client_id, user_id, name, color: '#2563eb', row_id: 'r1', column_id: null, updated_at });
	t.emit('presence', { status: 'live', data: [peer(t.realtime.clientId, 'me', 'Me', t.now()), peer('tab-2', 'me', 'Me', t.now()), peer('bob', 'bob', 'Bob', t.now() - PRESENCE_TTL_MS + 5_000)] });
	await t.advance(40);
	assert.deepEqual(t.snapshots.at(-1)?.peers.map((entry) => entry.name), ['You (another tab)', 'Bob']);
	await t.advance(5_000);
	assert.deepEqual(t.snapshots.at(-1)?.peers.map((entry) => entry.name), ['You (another tab)']);
});
