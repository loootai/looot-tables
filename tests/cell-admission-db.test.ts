import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { before, test } from 'node:test';
import { initSync } from '@ironcalc/wasm';
import { calculateFormulas, type FormulaRequest } from '../src/lib/formulas';
import { appendRows, connectWorkspace, createSheet, db, deleteSheet, loadSheet, newColumn, setCell, sourceCell } from '../src/lib/db';
import { cellFromInput } from '../src/lib/formula-input';
import { runner } from '../src/lib/runner';
import type { ColumnOp, Sheet } from '../src/lib/types';
import { MemoryRemote } from './support/memory-remote';

initSync({ module: readFileSync(createRequire(`${process.cwd()}/package.json`).resolve('@ironcalc/wasm/wasm_bg.wasm')) });
class TestWorker {
	onmessage?: (event: { data: unknown }) => void;
	terminate() {}
	postMessage(request: FormulaRequest & { id: number }) {
		setTimeout(() => this.onmessage?.({ data: { id: request.id, results: calculateFormulas(request) } }), 0);
	}
}
Object.assign(globalThis, { Worker: TestWorker });

const rows = (sheet: Sheet) => db.rows.where('sheetId').equals(sheet.id).sortBy('order');
async function settled() {
	for (let i = 0; i < 200; i++) {
		if (!runner.getSnapshot().active) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail('Enrichment queue did not settle');
}

const remote = new MemoryRemote();
before(() => connectWorkspace(remote));

test('an answer the column format cannot hold fails its cell: the sheet never pauses and resuming never spends again', async (t) => {
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ value: 'N/A' }); });
	const op: ColumnOp = { kind: 'ai', prompt: 'Website of {{Company}}', output: 'text', research: 'web' };
	assert.equal(newColumn({ name: 'Website', type: 'enriched', op }).format, undefined, 'an AI column is not typed by its header');
	const company = newColumn({ name: 'Company', type: 'source' });
	// Columns saved before the fix were typed by their header.
	const site = { ...newColumn({ name: 'Website', type: 'enriched', op }), format: 'website' as const };
	const sheet = await createSheet('Unfit answers', [company, site]);
	try {
		await appendRows(sheet.id, [{ Company: 'Acme' }, { Company: 'Orbit' }]);
		await runner.enqueue(sheet, await rows(sheet), [site]);
		await settled();
		assert.equal(requests, 2);
		for (const row of await rows(sheet)) {
			assert.equal(row.cells[site.id].s, 'error');
			assert.match(row.cells[site.id].e ?? '', /The answer “N\/A” is not a website/);
		}
		assert.equal(runner.getSnapshot().halted[sheet.id], undefined, 'saving the failure must not pause the sheet');
		runner.resume(sheet.id);
		await settled();
		assert.equal(requests, 2, 'nothing is left queued to spend again');
	} finally { await runner.cancel({ sheetId: sheet.id }); await deleteSheet(sheet.id); }
});

test('importing into an existing sheet keeps every row: chosen formats flag what does not fit, guessed formats give way', async () => {
	const cost = newColumn({ name: 'Cost', type: 'source', format: 'currency' });
	const sheet = await createSheet('Import into typed', [cost]);
	try {
		assert.equal(await appendRows(sheet.id, [{ Cost: '$5', Domain: 'acme.com' }, { Cost: 'TBD', Domain: 'n/a' }]), 2);
		const fresh = (await db.sheets.get(sheet.id))!;
		const domain = fresh.columns.find((column) => column.name === 'Domain')!;
		assert.equal(domain.format, 'text', 'the header guessed a website, but the values decide');
		const [first, second] = await rows(sheet);
		assert.equal(first.cells[cost.id].v, 5);
		assert.deepEqual([second.cells[cost.id].v, second.cells[cost.id].s], ['TBD', 'error']);
		assert.match(second.cells[cost.id].e ?? '', /“TBD” is not an amount/);
		assert.equal(second.cells[domain.id].v, 'n/a');

		assert.equal(await appendRows(sheet.id, [{ Cost: 'Undisclosed' }], { source: 'find-rows' }), 1);
		assert.deepEqual([(await rows(sheet))[2].cells[cost.id].v, (await rows(sheet))[2].cells[cost.id].s], [null, 'idle']);
	} finally { await deleteSheet(sheet.id); }
});

test('only written cells are checked: an old value never blocks other edits, and formula results are admitted', async () => {
	const site = newColumn({ name: 'Website', type: 'source', format: 'website' });
	const cost = newColumn({ name: 'Cost', type: 'source', format: 'currency' });
	const sheet = await createSheet('Written cells', [site, cost]);
	try {
		await appendRows(sheet.id, [{ Website: 'acme.com', Cost: 1 }]);
		const [row] = await rows(sheet);
		// A value written by an older client, before admission existed.
		remote.edit(sheet.id, (grid) => { grid.rows[0].cells[site.id] = sourceCell('n/a'); });
		await loadSheet(sheet.id);
		await setCell(row.id, cost.id, cellFromInput('$2,500', cost));
		assert.equal((await db.rows.get(row.id))!.cells[cost.id].v, 2500);
		await assert.rejects(setCell(row.id, site.id, sourceCell('still n/a')), /“Website”: Enter a valid website/);
		await setCell(row.id, cost.id, cellFromInput('="free"', cost));
		const formula = (await db.rows.get(row.id))!.cells[cost.id];
		assert.deepEqual([formula.f, formula.s], ['="free"', 'error']);
		assert.match(formula.e ?? '', /The result “free” is not an amount/);
		await setCell(row.id, cost.id, cellFromInput('=2*3', cost));
		assert.equal((await db.rows.get(row.id))!.cells[cost.id].v, 6);
	} finally { await deleteSheet(sheet.id); }
});
