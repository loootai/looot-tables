import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveColumnFormula, formulaColumnReferences } from '../src/lib/formula-columns';

const columns = ['Company', 'Annual revenue', 'UPPER', 'A1', 'Email'].map((name) => ({ name }));
test('column names act as row-relative references and support spaces through mentions', () => {
 assert.equal(resolveColumnFormula('=UPPER(Company)&{{Annual revenue}}', columns, 0), '=UPPER(A1)&B1');
 assert.equal(resolveColumnFormula('=UPPER({{Company}})&{{Annual revenue}}', columns, 4), '=UPPER(A5)&B5');
 assert.equal(resolveColumnFormula('=IF(Email="",Company,Email)', columns, 1), '=IF(E2="",A2,E2)');
 assert.equal(formulaColumnReferences('=UPPER({{Company}})', columns)[0].name, 'Company');
});
test('named reference resolution preserves strings, function names, sheet names and coordinates', () => {
 const formula = '=IF(A1="Company",UPPER("Annual revenue"),$A$1)&"He said ""Company"""&\'Company\'!A1';
 assert.equal(resolveColumnFormula(formula, columns, 5), formula);
 assert.equal(resolveColumnFormula('={{A1}}', columns, 5), '=D6');
 assert.throws(() => resolveColumnFormula('={{Missing}}', columns, 0), /Unknown column: Missing/);
});
