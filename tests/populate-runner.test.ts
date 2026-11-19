import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { populateRunner } from '../src/lib/populate-runner';
import { RowArrivalPacer } from '../src/lib/row-arrival-pacer';
import { appendRows, connectWorkspace, createSheet, db, deleteSheet, newColumn, updateSheet } from '../src/lib/db';
import { ENTITY_COLUMNS } from '../src/lib/types';
import { MemoryRemote } from './support/memory-remote';

const ids = (count: number, prefix = 'row') => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('a typical search page reveals individual rows over several seconds, starting immediately', () => {
	const schedule = [...new RowArrivalPacer().add(ids(20), 1000).values()];
	assert.equal(schedule[0], 1000);
	assert.ok(schedule.at(-1)! >= 7500, 'a normal page needs a readable pace, even after the request finishes');
	assert.ok(schedule.slice(1).every((at, i) => at - schedule[i] >= 80));
	assert.ok(schedule.every((at, i) => !i || at > schedule[i - 1]));
	const gaps = schedule.slice(1).map((at, i) => at - schedule[i]);
	assert.ok(gaps.some((gap) => gap < 260), 'include quick rows within a burst');
	assert.ok(gaps.some((gap) => gap > 600), 'include noticeable pauses between bursts');
	assert.ok(schedule.at(-1)! <= 9000, 'bursts must preserve the total reveal budget');
});

test('overlapping pages accelerate a backlog without hiding an already displayed row', () => {
	const fast = new RowArrivalPacer();
	const initial = fast.add(ids(20), 1000);
	const shown = [...initial].filter(([, at]) => at <= 1500).map(([id]) => id);
	const combined = fast.add(ids(20, 'next'), 1500);
	assert.ok(shown.every((id) => !combined.has(id)));
	const times = [...combined.values()];
	assert.ok(times.every((at, i) => !i || at >= times[i - 1]));
	const slow = new RowArrivalPacer();
	slow.add(ids(20), 1000);
	const slower = [...slow.add(ids(20, 'next'), 10_000).values()];
	assert.ok(slower.slice(1).every((at, i) => at - slower[i] >= 80));
	assert.ok((times.at(-1)! - times[0]) / (times.length - 1) < (slower.at(-1)! - slower[0]) / (slower.length - 1), 'a backlog should accelerate the average beat');
});

test('a large backlog stays bounded and completion preserves the reveal cadence', () => {
	const pacer = new RowArrivalPacer();
	const first = pacer.add(ids(5000), 1000);
	assert.equal(first.size, 5000);
	assert.ok([...first.values()].every((at) => at <= 9000));
	const next = pacer.add(ids(1000, 'next'), 4500);
	assert.ok([...next].every(([id, at]) => at <= (id.startsWith('next') ? 12500 : 9000)));
	const beforeFinish = new Map([...next].filter(([, at]) => at > 4600));
	const finished = pacer.finish(4600);
	assert.deepEqual(finished, beforeFinish);
	assert.ok([...finished.values()].every((at) => at > 4600 && at <= 12500));
});

test('stopping a live stream keeps already saved rows and immediately clears presentation delays', async () => {
	const sheet = await createSheet('Stop discovery');
	const originalFetch = globalThis.fetch;
	let sent!: () => void;
	const received = new Promise<void>((resolve) => { sent = resolve; });
	globalThis.fetch = async (_url, options) => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'rows', rows: Array.from({ length: 20 }, (_, i) => ({ Company: `Company ${i}`, Domain: `${i}.example` })) }) + '\n'));
			options?.signal?.addEventListener('abort', () => controller.error(new DOMException('Stopped', 'AbortError')), { once: true });
		},
	}));
	const unsubscribe = populateRunner.subscribe(() => { if (populateRunner.getSnapshot(sheet.id).added === 20) sent(); });
	try {
		const running = populateRunner.start(sheet, { query: 'Developer tools', entity: 'companies', target: 20 });
		await received;
		assert.equal(await db.rows.where('sheetId').equals(sheet.id).count(), 20);
		assert.ok(populateRunner.getSnapshot(sheet.id).hidden.size > 0);
		populateRunner.stop(sheet.id);
		assert.equal(populateRunner.getSnapshot(sheet.id).hidden.size, 0);
		await running;
		assert.equal(populateRunner.getSnapshot(sheet.id).running, false);
		assert.equal(populateRunner.getSnapshot(sheet.id).error, null);
		assert.equal(await db.rows.where('sheetId').equals(sheet.id).count(), 20);
	} finally {
		unsubscribe();
		globalThis.fetch = originalFetch;
		await deleteSheet(sheet.id);
	}
});

test('discovery saves at most the requested new rows across oversized streamed batches', async (t) => {
	const sheet = await createSheet('Capped discovery');
	await appendRows(sheet.id, [{ URL: 'https://existing.example' }]);
	const events = [70, 75, 20].map((count, batch) => ({
		type: 'rows',
		rows: Array.from({ length: count }, (_, i) => ({ URL: `https://batch-${batch}-${i}.example`, Title: `Site ${i}` })),
	}));
	t.mock.method(globalThis, 'fetch', async () => new Response([...events, { type: 'done', total: 100 }].map((event) => JSON.stringify(event)).join('\n') + '\n'));
	try {
		const result = await populateRunner.start(sheet, { query: 'Homelab blogs', entity: 'websites', target: 100 });
		assert.equal(result.phase, 'finished');
		assert.equal(populateRunner.getSnapshot(sheet.id).added, 100);
		assert.equal(populateRunner.getSnapshot(sheet.id).status, '100 rows added');
		assert.equal(populateRunner.getSnapshot(sheet.id).error, null);
		const rows = await db.rows.where('sheetId').equals(sheet.id).toArray();
		assert.equal(rows.length, 101, 'the target counts new rows, in addition to existing rows');
		const urlColumn = (await db.sheets.get(sheet.id))!.columns.find((column) => column.name === 'URL')!;
		const urls = new Set(rows.map((row) => row.cells[urlColumn.id]?.v));
		assert.ok(urls.has('https://existing.example'));
		assert.ok(urls.has('https://batch-1-29.example'));
		assert.ok(!urls.has('https://batch-1-30.example'));
		assert.ok(!urls.has('https://batch-2-0.example'));
	} finally {
		populateRunner.stop(sheet.id);
		await deleteSheet(sheet.id);
	}
});


test('discovery maps wire domains into Website and reuses legacy columns without duplicating rows', async (t) => {
	let existingKeys: string[] = [];
		t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => {
		existingKeys = JSON.parse(String(options?.body)).existingKeys;
		return new Response(JSON.stringify({ type: 'rows', rows: [{ Company: 'Existing', Domain: 'existing.example' }, { Company: 'New', Domain: 'new.example' }] }) + '\n');
	});
	for (const legacy of [false, true]) {
		const sheet = await createSheet('Compatible discovery', legacy ? [newColumn({ name: 'Domain', type: 'source', format: 'url' })] : []);
		try {
			if (legacy) await appendRows(sheet.id, [{ Domain: 'existing.example' }]);
			await populateRunner.start(sheet, { query: 'Developer tools', entity: 'companies', target: 2 });
			const saved = (await db.sheets.get(sheet.id))!;
			const domainColumns = saved.columns.filter((column) => ['Domain', 'Website'].includes(column.name));
			assert.equal(domainColumns.length, 1);
			assert.equal(domainColumns[0].name, legacy ? 'Domain' : 'Website');
			if (!legacy) assert.equal(domainColumns[0].format, 'website');
			assert.equal(await db.rows.where('sheetId').equals(sheet.id).count(), 2);
			assert.deepEqual(existingKeys, legacy ? ['existing.example'] : []);
		} finally {
			populateRunner.stop(sheet.id);
			await deleteSheet(sheet.id);
		}
	}
});

test('people photos persist on the first Name cell without creating a photo column', async (t) => {
	const sheet = await createSheet('People photos');
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ type: 'rows', rows: [
		{ Name: 'Dominik Koch', LinkedIn: 'https://linkedin.com/in/dominikkoch', 'Profile photo': 'https://cdn.example/dominik.png' },
		{ Name: 'Unknown Person', LinkedIn: null, 'Profile photo': null },
	] }) + '\n'));
	try {
		await populateRunner.start(sheet, { query: 'Dominik Koch and Unknown Person', entity: 'people', target: 2 });
		const current = (await db.sheets.get(sheet.id))!;
		assert.equal(current.columns[0].name, 'Name');
		assert.ok(!current.columns.some(c => /profile|photo/i.test(c.name)));
		const rows = (await db.rows.where('sheetId').equals(sheet.id).toArray()).sort((a, b) => a.order - b.order);
		assert.deepEqual(rows[0].cells[current.columns[0].id].m?.person, { name: 'Dominik Koch', avatarUrl: 'https://cdn.example/dominik.png' });
		assert.deepEqual(rows[1].cells[current.columns[0].id].m?.person, { name: 'Unknown Person', avatarUrl: null });
	} finally { populateRunner.stop(sheet.id); await deleteSheet(sheet.id); }
});

const streamOf = (events: unknown[]) => new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n');

test('a renamed key column keeps receiving found rows, without a second Website column or rows the sheet already has', async (t) => {
	let existingKeys: string[] = [];
	t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => {
		existingKeys = JSON.parse(String(options?.body)).existingKeys;
		return streamOf([{ type: 'rows', rows: [{ Company: 'Existing', Domain: 'https://www.Existing.example/' }, { Company: 'New', Domain: 'new.example' }] }, { type: 'done', total: 2 }]);
	});
	const sheet = await createSheet('Renamed key', ENTITY_COLUMNS.companies.map((column) => newColumn({ name: column.name, type: 'source', width: column.width, format: column.format })));
	try {
		await appendRows(sheet.id, [{ Company: 'Existing', Website: 'existing.example' }]);
		await updateSheet(sheet.id, (current) => ({ columns: current.columns.map((column) => column.name === 'Website' ? { ...column, name: 'Company site' } : column) }));
		await populateRunner.start(sheet, { query: 'Developer tools', entity: 'companies', target: 2 });
		const saved = (await db.sheets.get(sheet.id))!;
		assert.deepEqual(saved.columns.filter((column) => column.format === 'website').map((column) => column.name), ['Company site']);
		assert.deepEqual(existingKeys, ['existing.example']);
		const site = saved.columns.find((column) => column.name === 'Company site')!;
		const rows = await db.rows.where('sheetId').equals(sheet.id).sortBy('order');
		assert.deepEqual(rows.map((row) => row.cells[site.id]?.v), ['existing.example', 'new.example']);
	} finally { populateRunner.stop(sheet.id); await deleteSheet(sheet.id); }
});

test('a stream that ends without the server done event is reported as interrupted, keeping its rows', async (t) => {
	const sheet = await createSheet('Cut-off discovery');
	t.mock.method(globalThis, 'fetch', async () => streamOf([{ type: 'rows', rows: [{ Company: 'Acme', Domain: 'acme.example' }] }]));
	try {
		const result = await populateRunner.start(sheet, { query: 'Developer tools', entity: 'companies', target: 20 });
		assert.equal(result.phase, 'interrupted');
		assert.equal(result.running, false);
		assert.match(result.error ?? '', /connection closed before Find rows finished, after 1 row/);
		assert.equal(await db.rows.where('sheetId').equals(sheet.id).count(), 1);
	} finally { await deleteSheet(sheet.id); }
});

test('a finished search with no matches is a distinct, successful outcome', async (t) => {
	const sheet = await createSheet('Empty discovery');
	t.mock.method(globalThis, 'fetch', async () => streamOf([{ type: 'status', message: 'Searching…' }, { type: 'done', total: 0 }]));
	try {
		const result = await populateRunner.start(sheet, { query: 'Nothing like this exists', entity: 'companies', target: 20, countries: ['JP'] });
		assert.deepEqual([result.phase, result.added, result.error], ['finished', 0, null]);
		assert.deepEqual(result.request?.countries, ['JP']);
	} finally { await deleteSheet(sheet.id); }
});

test('stopping an idle sheet does nothing, and deleting a sheet stops its search', async (t) => {
	const sheet = await createSheet('Deleted mid-search');
	populateRunner.stop(sheet.id);
	assert.equal(populateRunner.getSnapshot(sheet.id).status, '', 'no run, so no "Stopping…" left behind');
	let aborted = false;
	t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, options?: RequestInit) => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'status', message: 'Searching…' }) + '\n'));
			options?.signal?.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('Stopped', 'AbortError')); }, { once: true });
		},
	})));
	const running = populateRunner.start(sheet, { query: 'Developer tools', entity: 'companies', target: 20 });
	await new Promise<void>((resolve) => { const stop = populateRunner.subscribe(() => { if (populateRunner.getSnapshot(sheet.id).status === 'Searching…') { stop(); resolve(); } }); });
	await deleteSheet(sheet.id);
	const result = await running;
	assert.equal(aborted, true);
	assert.equal(result.phase, 'stopped');
});

test('a handed-off search stays flagged until its outcome is acknowledged, and repeat starts join the same run', async (t) => {
	const sheet = await createSheet('Handed off');
	t.mock.method(globalThis, 'fetch', async () => streamOf([{ type: 'rows', rows: [{ Company: 'Acme', Domain: 'acme.example' }] }, { type: 'done', total: 1 }]));
	try {
		const request = { query: 'Developer tools', entity: 'companies' as const, target: 20 };
		const first = populateRunner.start(sheet, request, { handoff: true });
		assert.equal(populateRunner.getSnapshot(sheet.id).running, true, 'running is set synchronously, before navigation');
		assert.equal(populateRunner.settled(sheet.id), first);
		assert.equal(populateRunner.start(sheet, request), first);
		const result = await first;
		assert.deepEqual([result.phase, result.added, result.handoff], ['finished', 1, true]);
		assert.equal(populateRunner.settled(sheet.id), undefined);
		populateRunner.acknowledge(sheet.id);
		assert.equal(populateRunner.getSnapshot(sheet.id).handoff, false);
	} finally { await deleteSheet(sheet.id); }
});
