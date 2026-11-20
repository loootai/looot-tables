import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksFirst, CONFIRM_CELLS, costPerCell, estimateCells, lookupsTotal } from '../src/lib/run-cost';
import { previewErrors } from '../src/lib/formula-builder';
import { runScopeChoice } from '../src/lib/run-scope';
import type { ColumnOp } from '../src/lib/types';

const ultra: ColumnOp = { kind: 'answer', task: 'Latest funding', output: 'text', mode: 'ultra' };
const ask: ColumnOp = { kind: 'ai', prompt: 'CEO?', output: 'text', research: 'web' };
const draft: ColumnOp = { kind: 'email-draft', mode: 'ai', prompt: 'Hi', to: '', cc: '', bcc: '', subject: '', body: '' };
const anyEndpoint: ColumnOp = { kind: 'looot', endpointId: 'tomba-email-finder', inputs: { domain: '{{Domain}}' }, inputTypes: {}, unitCostUsd: 0.0064, path: '', prefer: 'balanced' };
const estimateRun = (rows: number, ops: ColumnOp[]) => estimateCells(ops.map((op) => ({ cells: rows, op })));

test('big or expensive runs ask first and say what they cost in dollars', () => {
	assert.equal(costPerCell(ultra), 0.03);
	assert.equal(costPerCell({ ...ask, page: { type: 'find', column: 'Domain', page: 'pricing' } }), 0.008);
	assert.deepEqual(estimateRun(1, [ultra]), { cells: 1, usdPerCell: 0.03, usd: 0.03, confirm: false, message: '~1 cell × ~$0.03 ≈ $0.03' });
	assert.equal(estimateRun(20, [ultra]).confirm, true, 'twenty Ultra cells exceed the dollar threshold');
	assert.equal(estimateRun(312, [ultra]).message, '~312 cells × ~$0.03 ≈ $9.36');
	assert.equal(estimateRun(CONFIRM_CELLS, [draft]).confirm, false);
	assert.deepEqual(estimateRun(CONFIRM_CELLS + 1, [draft]), { cells: 51, usdPerCell: 0, usd: 0, confirm: true, message: '~51 cells' });
	assert.equal(estimateRun(10, [ask, draft]).message, '~20 cells × ~$0.0020 ≈ $0.04', 'several columns average their cost per cell');
	assert.equal(estimateRun(0, [ultra]).confirm, false);
});

test('a column on any looot endpoint always shows its estimated cost for the rows it will run', () => {
	assert.equal(costPerCell(anyEndpoint), 0.0064);
	const ten = estimateRun(10, [anyEndpoint]);
	assert.equal(ten.usd, 0.064);
	assert.equal(ten.message, '~10 cells × ~$0.0064 ≈ $0.064');
	assert.equal(ten.confirm, true, 'ten cheap cells still ask: the price is the point');
	assert.equal(estimateRun(0, [anyEndpoint]).confirm, false);
	assert.equal(estimateCells([{ cells: 5, op: { ...anyEndpoint, unitCostUsd: null } as ColumnOp }]).message, '~5 cells', 'an unknown price shows no total');
});

test('a run asks again only when it outgrows the estimate already shown', () => {
	const shown = estimateRun(30, [ask]);
	assert.equal(asksFirst(estimateRun(60, [ask])), true);
	assert.equal(asksFirst(estimateRun(60, [ask]), estimateRun(60, [ask])), false, 'the same run, already accepted');
	assert.equal(asksFirst(estimateRun(60, [ask]), shown), true, 'more cells than shown');
	assert.equal(asksFirst(estimateRun(20, [ultra]), estimateRun(51, [draft])), true, 'fewer cells but more dollars than shown');
	assert.equal(asksFirst(estimateRun(29, [ask]), shown), false, 'a big run, but smaller than shown');
});

test('run scope labels name real rows and never repeat the whole column', () => {
	const fromTop = runScopeChoice(10, 312, 312, 1);
	assert.equal(fromTop.label, 'Run on 10 rows');
	assert.deepEqual(fromTop.options.map((option) => option.label), ['Run on row 1', 'Try 5 rows', 'Run on 10 rows', 'Run on 100 rows', 'Run on all 312 rows']);
	assert.deepEqual(runScopeChoice('all', 312, 312, 1).scope, { count: 312, scope: 'column' });
	const lower = runScopeChoice(100, 99, 312, 214);
	assert.equal(lower.label, 'Run on 99 rows from row 214');
	assert.deepEqual(lower.scope, { count: 99, scope: 'below' });
	assert.equal(runScopeChoice(1, 5, 5).label, 'Run on this row');
	assert.deepEqual(runScopeChoice('column', 1, 1, 1).scope, { count: 1, scope: 'cell' });
});

test('formula previews may save with some failing rows, not all', () => {
	assert.deepEqual(previewErrors([{ error: false }, { error: true }, { error: true }, { error: false }]), { errors: 2, blocking: false, message: '2 of 4 preview rows return errors' });
	assert.equal(previewErrors([{ error: true }, { error: true }]).blocking, true);
	assert.equal(previewErrors([{ error: false }]).message, null);
});

test('a receipt total adds the listed looot runs without float drift', () => {
	assert.equal(lookupsTotal([{ costUsd: 0.0061 }, { costUsd: 0.0019 }]), 0.008);
	assert.equal(lookupsTotal([{ costUsd: 0.001 }, { costUsd: 0.002 }]), 0.003);
	assert.equal(lookupsTotal([]), 0);
});
