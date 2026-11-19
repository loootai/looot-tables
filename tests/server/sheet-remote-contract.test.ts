import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Account } from '../../src/lib/auth-identity';
import { provideRouteContext } from '../../src/lib/server/api-route';
import { cloudSheets } from '../../src/lib/sheet-cloud';
import { refused, type SheetRemote } from '../../src/lib/sheet-remote';
import type { CellValue, Column, Row, Sheet } from '../../src/lib/types';
import * as collection from '../../src/app/api/sheets/route';
import * as item from '../../src/app/api/sheets/[id]/route';
import { testDatabase } from '../support/database';
import { MemoryRemote } from '../support/memory-remote';

/* The scenarios every SheetRemote adapter must pass. Running them against the in-memory adapter the browser-side tests
   use and against the browser's own adapter, served by the real /api/sheets handlers on PGlite, keeps the fake honest:
   same revisions, quotas, Admission and refusals, down to the statuses the routes send. */

const actor: Account = { issuer: 'https://remote-contract.invalid', organization: { id: 'org', name: 'Org' }, user: { id: 'alice', email: 'alice@example.com', email_verified: true }, partition: 'alice' };

type Handler = (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>;
const handlers: { sheets: Record<string, Handler>; sheet: Record<string, Handler> } = { sheets: { GET: (request) => collection.GET(request), POST: (request) => collection.POST(request) }, sheet: { GET: item.GET, PATCH: item.PATCH, DELETE: item.DELETE } };

/** cloudSheets as the browser runs it, its fetch answered by the route handlers with a signed-in account and a fresh database. */
async function routes(t: TestContext): Promise<SheetRemote> {
	const { database } = await testDatabase(t);
	t.after(provideRouteContext((run) => run({ account: actor, database })));
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(new URL(String(input), 'https://enrichable.test'), init);
		const id = /^\/api\/sheets\/([^/]+)$/.exec(new URL(request.url).pathname)?.[1];
		const handler = id === undefined ? handlers.sheets[request.method] : handlers.sheet[request.method];
		return handler ? handler(request, { params: Promise.resolve({ id: decodeURIComponent(id ?? '') }) }) : new Response(null, { status: 405 });
	});
	return cloudSheets;
}

const adapters: Array<[string, (t: TestContext) => Promise<SheetRemote>]> = [['in memory', async () => new MemoryRemote()], ['cloudSheets through /api/sheets on PGlite', routes]];
/** One scenario, run against each adapter. */
function contract(name: string, scenario: (remote: SheetRemote) => Promise<void>) {
	test(`SheetRemote: ${name}`, async (t) => {
		for (const [adapter, open] of adapters) await t.test(adapter, async (t) => scenario(await open(t)));
	});
}

const notes: Column = { id: 'notes', name: 'Notes', type: 'source', width: 180, createdAt: 0 };
const site: Column = { id: 'site', name: 'Website', type: 'source', width: 180, format: 'website', createdAt: 0 };
const sheet = (id: string, columns = [notes, site]): Sheet => ({ id, name: id, columns, filters: [], sort: null, createdAt: 0, updatedAt: 0 });
const row = (sheetId: string, id: string, order: number, cells: Record<string, CellValue> = {}): Row => ({ id, sheetId, order, createdAt: 0, cells: Object.fromEntries(Object.entries(cells).map(([column, v]) => [column, { v, s: 'done', t: 1 }])) });
const status = (code: number, message?: RegExp) => (error: unknown) => refused(error, code) && (!message || message.test(error.message));

contract('a created sheet is stored as parsed at revision 1, and reads return every row in order', async (remote) => {
	const created = await remote.create({ ...sheet('s'), cloudSummary: { revision: 9, rowCount: 0, rows: [] } }, [row('s', 'b', 1, { notes: 'second' }), row('s', 'a', 0, { notes: 'first' })]);
	assert.deepEqual(created, { ...sheet('s'), revision: 1 });
	assert.deepEqual(await remote.list(), [{ ...sheet('s'), revision: 1 }]);
	const snapshot = await remote.read('s');
	assert.deepEqual(snapshot?.sheet, { ...sheet('s'), revision: 1 });
	assert.deepEqual(snapshot?.rows.map((entry) => entry.cells.notes.v), ['first', 'second']);
	assert.equal(await remote.read('missing'), null);
	await assert.rejects(remote.create(sheet('s'), []), status(409, /already exists/));
	await assert.rejects(remote.create(sheet('t'), [row('t', 'a', 0)]), status(409, /already used by another sheet/));
});

contract('a patch applies only against the current revision', async (remote) => {
	await remote.create(sheet('s'), [row('s', 'a', 0, { notes: 'old' }), row('s', 'b', 1)]);
	const saved = await remote.patch({ revision: 1, sheet: { ...sheet('s'), name: 'Renamed' }, rows: [row('s', 'a', 0, { notes: 'new' }), row('s', 'c', 2)], deleted: ['b'] });
	assert.equal(saved?.revision, 2);
	const snapshot = (await remote.read('s'))!;
	assert.deepEqual([snapshot.sheet.name, snapshot.sheet.revision, snapshot.sheet.updatedAt], ['Renamed', 2, saved!.updatedAt]);
	assert.deepEqual(snapshot.rows.map((entry) => [entry.id, entry.cells.notes?.v]), [['a', 'new'], ['c', undefined]]);
	assert.equal(await remote.patch({ revision: 1, sheet: sheet('s'), rows: [], deleted: [] }), null, 'a stale revision is a conflict');
	assert.equal((await remote.read('s'))!.sheet.name, 'Renamed');
	await assert.rejects(remote.patch({ revision: 1, sheet: sheet('gone'), rows: [], deleted: [] }), status(404));
});

contract('written values pass Admission, while values stored earlier never block other cells', async (remote) => {
	// Creating a sheet stores rows as given, as an import from an older client did.
	await remote.create(sheet('s'), [row('s', 'a', 0, { site: 'n/a', notes: 'hello' })]);
	assert.equal((await remote.patch({ revision: 1, sheet: sheet('s'), rows: [row('s', 'a', 0, { site: 'n/a', notes: 'edited' })], deleted: [] }))?.revision, 2);
	await assert.rejects(remote.patch({ revision: 2, sheet: sheet('s'), rows: [row('s', 'a', 0, { site: 'still n/a', notes: 'edited' })], deleted: [] }), status(422, /does not fit/));
	await assert.rejects(remote.patch({ revision: 2, sheet: sheet('s', [{ ...notes, format: 'currency' }, site]), rows: [], deleted: [] }), status(422, /“hello”|“edited”/), 'a column whose format changed has every cell checked');
	assert.equal((await remote.read('s'))!.sheet.revision, 2);
});

contract('a workspace holds ten sheets and a sheet a thousand rows', async (remote) => {
	await remote.create(sheet('full'), Array.from({ length: 1000 }, (_, order) => row('full', `r${order}`, order)));
	await assert.rejects(remote.patch({ revision: 1, sheet: sheet('full'), rows: [row('full', 'extra', 1000)], deleted: [] }), status(422, /1,000 rows/));
	for (let index = 1; index < 10; index++) await remote.create(sheet(`s${index}`), []);
	await assert.rejects(remote.create(sheet('eleventh'), []), status(422, /up to 10 sheets/));
	assert.equal((await remote.list()).length, 10);
});

contract('a delete at a stale revision keeps the sheet and names its revision; a missing sheet is already deleted', async (remote) => {
	await remote.create(sheet('s'), []);
	await remote.patch({ revision: 1, sheet: { ...sheet('s'), name: 'Edited' }, rows: [], deleted: [] });
	assert.equal(await remote.remove('s', 1), 2);
	assert.equal((await remote.read('s'))?.sheet.revision, 2);
	assert.equal(await remote.remove('s', 2), null);
	assert.equal(await remote.read('s'), null);
	assert.equal(await remote.remove('s', 2), null);
	await assert.rejects(remote.remove('s', 0), status(400));
});

contract('malformed sheets and rows are refused before anything is stored', async (remote) => {
	await assert.rejects(remote.create(sheet('s', [notes, notes]), []), status(400, /Duplicate/));
	await assert.rejects(remote.create(sheet('s'), [row('other', 'a', 0)]), status(400, /belong to the sheet/));
	await assert.rejects(remote.create(sheet('s'), [{ ...row('s', 'a', 0), cells: { unknown: { v: 'x', s: 'done', t: 1 } } }]), status(400, /belong to the sheet/));
	await assert.rejects(remote.create({ ...sheet('s'), name: '' }, []), status(400));
	await remote.create(sheet('s'), []);
	await assert.rejects(remote.patch({ revision: 0, sheet: sheet('s'), rows: [], deleted: [] }), status(400));
	assert.deepEqual((await remote.list()).map((entry) => entry.revision), [1]);
});
