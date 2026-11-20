import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveResource, liveStore, type LiveSource } from '../src/lib/live-store';

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test('a live store starts on its first subscriber, is shared, and stops and resets after the last one leaves', async () => {
	const sources: LiveSource<number>[] = [];
	let stops = 0;
	const store = liveStore(0, (source) => { sources.push(source); return () => { stops += 1; }; });
	assert.equal(sources.length, 0, 'Nothing runs before anyone subscribes');
	let notified = 0;
	const leaveA = store.subscribe(() => { notified += 1; });
	const leaveB = store.subscribe(() => { notified += 1; });
	assert.equal(sources.length, 1, 'Subscribers share one source');
	sources[0].set((value) => value + 2);
	assert.equal(store.getSnapshot(), 2);
	assert.equal(notified, 2);
	leaveA(); leaveB();
	assert.equal(stops, 0, 'Teardown waits a microtask');
	await tick();
	assert.equal(stops, 1);
	assert.equal(sources[0].signal.aborted, true);
	assert.equal(store.getSnapshot(), 0, 'Stopped stores keep no data');
	sources[0].set(5);
	store.set(5);
	assert.equal(store.getSnapshot(), 0, 'Late updates from a stopped source are ignored');
	assert.equal(store.getServerSnapshot(), 0);
});

test('resubscribing within the same commit (StrictMode, key changes) keeps the source running', async () => {
	let starts = 0;
	const store = liveStore('idle', () => { starts += 1; });
	store.subscribe(() => {})();
	const leave = store.subscribe(() => {});
	await tick();
	assert.equal(starts, 1);
	leave();
	await tick();
	store.subscribe(() => {});
	assert.equal(starts, 2, 'A later subscriber starts it again');
});

test('refresh reaches the running source; resources key stores and return an inert store for null', async () => {
	let refreshed = 0;
	const started: string[] = [];
	const resource = liveResource((params: { id: string }) => params.id, null as string | null, (params, { set }) => {
		started.push(params.id);
		set(`loaded ${params.id}`);
		return { refresh: () => { refreshed += 1; } };
	});
	const store = resource({ id: 'a' });
	assert.equal(resource({ id: 'a' }), store, 'Same key, same store');
	assert.notEqual(resource({ id: 'b' }), store);
	store.refresh();
	assert.equal(refreshed, 0, 'Nothing to refresh before it runs');
	const leave = store.subscribe(() => {});
	assert.equal(store.getSnapshot(), 'loaded a');
	store.refresh();
	assert.equal(refreshed, 1);
	const idle = resource(null);
	idle.subscribe(() => {});
	assert.equal(idle.getSnapshot(), null);
	assert.deepEqual(started, ['a']);
	leave();
	await tick();
});
