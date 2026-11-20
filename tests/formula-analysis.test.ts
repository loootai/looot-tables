import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { initSync, Model } from '@ironcalc/wasm';
import { analyzeFormula } from '../src/lib/formula-analysis';
import { activeArgument, argumentLabel, formulaFunction, formulaFunctionNames } from '../src/lib/formula-catalog';

const require = createRequire(`${process.cwd()}/package.json`);
initSync({ module: readFileSync(require.resolve('@ironcalc/wasm/wasm_bg.wasm')) });
function analyze(text: string, cursor = text.length) {
	const model = new Model('Editor tests', 'en', 'UTC', 'en');
	try { return analyzeFormula(model, { text, cursor }); } finally { model.free(); }
}

test('completion replaces function prefixes at the cursor, including nested formulas and Unicode', () => {
	assert.deepEqual(analyze('=su').completion, { from: 1, prefix: 'SU' });
	assert.deepEqual(analyze('=IF(A1,SU').completion, { from: 7, prefix: 'SU' });
	const text = '=IF("😀",SU';
	assert.deepEqual(analyze(text).completion, { from: 9, prefix: 'SU' });
	assert.equal(text.slice(analyze(text).completion!.from), 'SU');
	assert.equal(analyze('plain text').completion, null);
	assert.equal(analyze("'=SUM(").call, null);
	assert.equal(analyze('="SUM("').call, null);
});

test('argument hints follow nested calls, quoted commas, and cursor movement', () => {
	assert.deepEqual(analyze('=SUM(').call, { name: 'SUM', argument: 0 });
	assert.deepEqual(analyze('=IF(A1,SUM(B1,C1),"no"', 16).call, { name: 'SUM', argument: 1 });
	assert.deepEqual(analyze('=IF(A1,SUM(B1,C1),').call, { name: 'IF', argument: 2 });
	assert.deepEqual(analyze('=IF("a,b",').call, { name: 'IF', argument: 1 });
});

test('syntax spans preserve Unicode strings and consistently color repeated references', () => {
	const text = '=IF(A1>2,"😀",SUM(A1,B1:B3))';
	const tokens = analyze(text).tokens;
	assert.equal(text.slice(tokens.find((token) => token.kind === 'string')!.from, tokens.find((token) => token.kind === 'string')!.to), '"😀"');
	const references = tokens.filter((token) => token.kind === 'reference');
	assert.deepEqual(references.map((token) => text.slice(token.from, token.to)), ['A1', 'A1', 'B1:B3']);
	assert.deepEqual(references.map((token) => token.color), [0, 0, 1]);
	assert.ok(tokens.some((token) => token.kind === 'function' && text.slice(token.from, token.to) === 'SUM'));
	assert.deepEqual(analyze('not a formula').tokens, []);
});

test('function metadata includes signatures, help and examples with optional and repeated arguments', () => {
	assert.ok(formulaFunctionNames.includes('SUMIF'));
	const sum = formulaFunction('sum')!;
	assert.equal(argumentLabel(sum.args[1][0]), '[number2]');
	assert.equal(argumentLabel(sum.args[2][0]), '…');
	assert.equal(activeArgument(sum, 10), 2);
	for (const name of formulaFunctionNames) {
		const info = formulaFunction(name)!;
		assert.ok(info.description.length > 0, name);
		assert.ok(Array.isArray(info.examples), name);
		assert.ok(info.args.every((arg) => arg.length === 3), name);
	}
});
