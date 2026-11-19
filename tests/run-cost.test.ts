import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksFirst, CONFIRM_CELLS, creditsPerCell, estimateCells } from '../src/lib/run-cost';
import { previewErrors } from '../src/lib/formula-builder';
import { runScopeChoice } from '../src/lib/run-scope';
import type { ColumnOp } from '../src/lib/types';

const ultra: ColumnOp = { kind: 'answer', task: 'Latest funding', output: 'text', mode: 'ultra' };
const ask: ColumnOp = { kind: 'ai', prompt: 'CEO?', output: 'text', research: 'web' };
const draft: ColumnOp = { kind: 'email-draft', mode: 'ai', prompt: 'Hi', to: '', cc: '', bcc: '', subject: '', body: '' };
const estimateRun = (rows: number, ops: ColumnOp[]) => estimateCells(ops.map((op) => ({ cells: rows, op })));

test('big or expensive runs ask first and say what they cost', () => {
	assert.equal(creditsPerCell(ultra), 100);
	assert.equal(creditsPerCell({ ...ask, page: { type: 'find', column: 'Domain', page: 'pricing' } }), 6);
	assert.deepEqual(estimateRun(1, [ultra]), { cells: 1, creditsPerCell: 100, credits: 100, confirm: false, message: '~1 cell × ~100 credits ≈ 100 credits' });
	assert.equal(estimateRun(2, [ultra]).confirm, true, 'two Ultra cells exceed the credit threshold');
	assert.equal(estimateRun(312, [ultra]).message, '~312 cells × ~100 credits ≈ 31,200 credits');
	assert.equal(estimateRun(CONFIRM_CELLS, [draft]).confirm, false);
	assert.deepEqual(estimateRun(CONFIRM_CELLS + 1, [draft]), { cells: 51, creditsPerCell: 0, credits: 0, confirm: true, message: '~51 cells' });
	assert.equal(estimateRun(10, [ask, draft]).message, '~20 cells × ~2 credits ≈ 40 credits', 'several columns average their cost per cell');
	assert.equal(estimateRun(0, [ultra]).confirm, false);
});

test('a run asks again only when it outgrows the estimate already shown', () => {
	const shown = estimateRun(30, [ask]);
	assert.equal(asksFirst(estimateRun(60, [ask])), true);
	assert.equal(asksFirst(estimateRun(60, [ask]), estimateRun(60, [ask])), false, 'the same run, already accepted');
	assert.equal(asksFirst(estimateRun(60, [ask]), shown), true, 'more cells than shown');
	assert.equal(asksFirst(estimateRun(2, [ultra]), estimateRun(51, [draft])), true, 'fewer cells but more credits than shown');
	assert.equal(asksFirst(estimateRun(29, [ask]), shown), false, 'a big run, but smaller than shown');
});

test('run scope labels name real rows and never repeat the whole column', () => {
	const fromTop = runScopeChoice(10, 312, 312, 1);
	assert.equal(fromTop.label, 'Run on 10 rows');
	assert.deepEqual(fromTop.options.map((option) => option.label), ['Run on row 1', 'Run on 10 rows', 'Run on 100 rows', 'Run on all 312 rows']);
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
