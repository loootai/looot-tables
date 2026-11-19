import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPopulateSearchQueue } from '../src/lib/server/populate-search-queue';

test('concurrent search requests use the updated remaining budget and skip fetching after the target', async () => {
	const searchInOrder = createPopulateSearchQueue(new AbortController().signal);
	const requested: number[] = [];
	let added = 95;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let started!: () => void;
	const firstStarted = new Promise<void>((resolve) => { started = resolve; });
	const search = () => searchInOrder(async () => {
		const remaining = 100 - added;
		if (!remaining) return 0;
		requested.push(Math.min(50, remaining));
		if (requested.length === 1) {
			started();
			await gate;
		}
		// The first query has duplicates, so only three of its five results are new.
		const unique = requested.length === 1 ? 3 : remaining;
		added += unique;
		return unique;
	});
	const pending = [search(), search(), search()];
	await firstStarted;
	assert.deepEqual(requested, [5], 'only one fetch may start while the first is pending');
	release();
	assert.deepEqual(await Promise.all(pending), [3, 2, 0]);
	assert.deepEqual(requested, [5, 2], 'the next fetch sees committed unique rows, and excess calls never fetch');
	assert.equal(added, 100);
});

test('a failed search releases the queue without hiding its error', async () => {
	const searchInOrder = createPopulateSearchQueue(new AbortController().signal);
	const error = new Error('Upstream search failed');
	const first = searchInOrder(async () => { throw error; });
	const next = searchInOrder(async () => 'completed');
	await assert.rejects(first, (caught) => caught === error);
	assert.equal(await next, 'completed');
});

test('cancelling a discovery run prevents queued searches from starting', async () => {
	const controller = new AbortController();
	const searchInOrder = createPopulateSearchQueue(controller.signal);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let started!: () => void;
	const firstStarted = new Promise<void>((resolve) => { started = resolve; });
	const first = searchInOrder(async () => { started(); await gate; });
	let secondStarted = false;
	const second = searchInOrder(async () => { secondStarted = true; });
	const rejected = assert.rejects(second, { name: 'AbortError' });
	await firstStarted;
	controller.abort();
	release();
	await first;
	await rejected;
	assert.equal(secondStarted, false);
});
