import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { cloudSheets } from '../src/lib/sheet-cloud';
import type { Row, Sheet } from '../src/lib/types';

/** /api/sheets answered by `respond`; returns each request as `METHOD path?query`. */
function api(t: TestContext, respond: (method: string, url: URL, body: unknown) => Response) {
	const requests: string[] = [];
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), 'https://test.example');
		const method = init?.method ?? 'GET';
		requests.push(`${method} ${url.pathname}${url.search}`);
		return respond(method, url, init?.body ? JSON.parse(String(init.body)) : undefined);
	});
	return requests;
}
const error = (status: number, message = `Status ${status}`) => Response.json({ error: message }, { status });
const sheet = (revision: number, name = 'Shared'): Sheet => ({ id: 'shared/1', name, revision, columns: [{ id: 'value', name: 'Value', type: 'source', width: 180, createdAt: 0 }], filters: [], sort: null, createdAt: 0, updatedAt: 0 });
const rows: Row[] = Array.from({ length: 101 }, (_, order) => ({ id: `r${order}`, sheetId: 'shared/1', order, createdAt: 0, cells: { value: { v: `Value ${order}`, s: 'done', t: 1 } } }));

test('a read pages through every row pinned to one revision, starting over when a write lands between pages', async (t) => {
	let revision = 1, conflict = true, unavailable = true;
	const requests = api(t, (_method, url) => {
		if (unavailable) { unavailable = false; return error(503); }
		const offset = Number(url.searchParams.get('offset'));
		if (offset && conflict) { conflict = false; revision = 2; return error(409); }
		if (offset) assert.equal(url.searchParams.get('revision'), String(revision));
		return Response.json({ sheet: sheet(revision), rows: rows.slice(offset, offset + 100), next: offset === 0 ? 100 : null });
	});
	const snapshot = await cloudSheets.read('shared/1');
	assert.equal(snapshot?.sheet.revision, 2);
	assert.equal(snapshot?.rows.length, 101);
	assert.deepEqual(requests, ['GET /api/sheets/shared%2F1?offset=0', 'GET /api/sheets/shared%2F1?offset=0', 'GET /api/sheets/shared%2F1?offset=100&revision=1', 'GET /api/sheets/shared%2F1?offset=0', 'GET /api/sheets/shared%2F1?offset=100&revision=2'], 'a cold database (503) is read again once');
});

test('a read of a missing sheet is null; a sheet that keeps changing fails after three reads', async (t) => {
	api(t, () => error(404, 'Sheet not found in this workspace.'));
	assert.equal(await cloudSheets.read('gone'), null);
	const requests = api(t, (_method, url) => url.searchParams.get('revision') ? error(409, 'Sheet changed. Refresh and try again.') : Response.json({ sheet: sheet(1), rows: [], next: 100 }));
	await assert.rejects(cloudSheets.read('busy'), { status: 409, message: 'Sheet changed. Refresh and try again.' });
	assert.equal(requests.length, 6);
});

test('a patch sends the change against its revision; a conflict is null and other refusals keep their status', async (t) => {
	let status = 200;
	const bodies: unknown[] = [];
	const requests = api(t, (_method, _url, body) => {
		bodies.push(body);
		return status === 200 ? Response.json({ revision: 4, updatedAt: 9 }) : error(status, status === 409 ? 'Another member changed this sheet.' : 'Workspace temporarily unavailable.');
	});
	const patch = { revision: 3, sheet: sheet(3), rows: [rows[0]], deleted: ['r1'] };
	assert.deepEqual(await cloudSheets.patch(patch), { revision: 4, updatedAt: 9 });
	assert.deepEqual(bodies[0], patch);
	status = 409;
	assert.equal(await cloudSheets.patch(patch), null);
	status = 503;
	await assert.rejects(cloudSheets.patch(patch), { status: 503 });
	assert.deepEqual(requests, Array(3).fill('PATCH /api/sheets/shared%2F1'), 'writes are never retried: they may have committed');
});

test('a refused delete reads the first page to tell a newer revision from a deleted sheet', async (t) => {
	let current: number | null = 5;
	const requests = api(t, (method, url) => {
		if (method === 'DELETE') return current !== null && Number(url.searchParams.get('revision')) === current ? Response.json({ ok: true }) : error(409);
		return current === null ? error(404) : Response.json({ sheet: sheet(current), rows: [], next: null });
	});
	assert.equal(await cloudSheets.remove('shared/1', 4), 5);
	assert.equal(await cloudSheets.remove('shared/1', 5), null);
	current = null;
	assert.equal(await cloudSheets.remove('shared/1', 5), null);
	assert.deepEqual(requests, ['DELETE /api/sheets/shared%2F1?revision=4', 'GET /api/sheets/shared%2F1?offset=0', 'DELETE /api/sheets/shared%2F1?revision=5', 'DELETE /api/sheets/shared%2F1?revision=5', 'GET /api/sheets/shared%2F1?offset=0']);
});

test('list and create speak the collection endpoint; a failed create is not retried', async (t) => {
	let unavailable = false;
	const requests = api(t, (method, _url, body) => {
		if (unavailable) return error(503, 'Workspace temporarily unavailable.');
		return method === 'POST' ? Response.json({ ...(body as { sheet: Sheet }).sheet, revision: 1 }) : Response.json([{ sheet: sheet(2), rowCount: 101 }]);
	});
	assert.deepEqual(await cloudSheets.list(), [sheet(2)]);
	assert.equal((await cloudSheets.create({ ...sheet(1), revision: undefined }, rows.slice(0, 1))).revision, 1);
	unavailable = true;
	await assert.rejects(cloudSheets.create(sheet(1), []), { status: 503, message: 'Workspace temporarily unavailable.' });
	assert.deepEqual(requests, ['GET /api/sheets', 'POST /api/sheets', 'POST /api/sheets']);
});

test('responses tell the browser the server’s clock, which running markers are stamped and expired on', async (t) => {
	const { serverNow } = await import('../src/lib/server-clock');
	const server = Date.now() - 15 * 60_000;
	api(t, () => Response.json([], { headers: { date: new Date(server).toUTCString() } }));
	await cloudSheets.list();
	assert.ok(Math.abs(serverNow() - server) < 2_000, 'the local clock is 15 minutes ahead');
});

test('the server answered midway through the round trip; a slow one, such as a response read after the tab was suspended, is ignored', async (t) => {
	const { observeServerDate, serverNow } = await import('../src/lib/server-clock');
	t.after(() => observeServerDate(new Date().toUTCString(), Date.now()));
	const now = Date.now(), server = Math.floor((now - 15 * 60_000) / 1000) * 1000;
	observeServerDate(new Date(server).toUTCString(), now - 2_000, now);
	assert.ok(Math.abs(serverNow() - (server + 500 + 1_000)) < 50, 'the Date header’s second, read at the midpoint of sending and receiving');
	const before = serverNow();
	// The response was read a minute after it was sent: the tab was frozen with it waiting, so its Date is a minute old.
	observeServerDate(new Date(server - 60_000).toUTCString(), now - 60_000, now);
	assert.ok(Math.abs(serverNow() - before) < 50, 'the estimate is unchanged');
	observeServerDate(new Date(server).toUTCString(), now, now - 1_000);
	assert.ok(Math.abs(serverNow() - before) < 50, 'a clock that ran backwards is no round trip either');
});
