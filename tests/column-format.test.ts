import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIELD_FORMATS, formatColumnNumber, isCheckboxColumn, typedColumnValue } from '../src/lib/column-format';
import { cellFromInput } from '../src/lib/formula-input';
import { sheetSchema } from '../src/lib/workspace';

test('currency, percentages and units keep numeric values separate from display', () => {
	assert.equal(cellFromInput('$1,234.50', { format: 'currency' }).v, 1234.5);
	assert.equal(cellFromInput('EUR 1234.50', { format: 'currency', currency: 'EUR' }).v, 1234.5);
	assert.equal(formatColumnNumber(1234.5, { format: 'currency' }), '$1,234.50');
	assert.equal(formatColumnNumber(1234.5, { format: 'currency', currency: 'EUR' }), '€1,234.50');
	assert.equal(formatColumnNumber(1234, { format: 'currency', currency: 'JPY' }), '¥1,234');
	assert.equal(cellFromInput('25%', { format: 'percent' }).v, 0.25);
	assert.equal(cellFromInput('0.25', { format: 'percent' }).v, 0.25);
	assert.equal(formatColumnNumber(0.25, { format: 'percent' }), '25%');
	assert.equal(cellFromInput('12.5 kg', { format: 'unit', unit: 'kg' }).v, 12.5);
	assert.equal(formatColumnNumber(12.5, { format: 'unit', unit: 'kg' }), '12.5 kg');
	assert.equal(cellFromInput('=SUM(A1:A3)', { format: 'currency' }).f, '=SUM(A1:A3)');
	assert.equal(typedColumnValue(null, { format: 'currency' }), null);
	for (const value of ['abc', '1,2', 'Infinity', '$', '12kg']) assert.throws(() => cellFromInput(value, { format: 'currency' }));
});

test('checkbox input stores booleans without JavaScript truthiness conversion', () => {
	assert.equal(FIELD_FORMATS.some(([format]) => String(format) === 'boolean'), false);
	assert.equal(isCheckboxColumn({ format: 'boolean' }), true);
	for (const value of ['true', 'TRUE', '1']) assert.equal(cellFromInput(value, { format: 'checkbox' }).v, true);
	for (const value of ['false', 'FALSE', '0']) assert.equal(cellFromInput(value, { format: 'checkbox' }).v, false);
	assert.equal(typedColumnValue(false, { format: 'checkbox' }), false);
	assert.equal(typedColumnValue(0, { format: 'checkbox' }), false);
	assert.equal(typedColumnValue(null, { format: 'checkbox' }), null);
	for (const value of ['yes', 'no', 'y', 'n', 'maybe']) assert.throws(() => cellFromInput(value, { format: 'checkbox' }), /true or false/);
	assert.equal(cellFromInput('true', { format: 'boolean' }).v, true);
	assert.equal(cellFromInput('false', { format: 'boolean' }).v, false);
});

test('shared workspace schema preserves column-wide format settings', () => {
	const input = { id: 's', name: 'Formats', columns: [{ id: 'c', name: 'Cost', type: 'source', width: 180, format: 'currency', currency: 'USD', unit: 'kg', createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
	assert.deepEqual(sheetSchema.parse(input), input);
	assert.equal(sheetSchema.safeParse({ ...input, columns: [{ ...input.columns[0], currency: 'invalid' }] }).success, false);
});

test('year fields omit grouping in existing sheets and the company layout', async () => {
	const { ENTITY_COLUMNS } = await import('../src/lib/types');
	for (const name of ['Founded', 'Year founded', 'Founded year', 'founded_year', 'Year', 'Established']) {
		assert.equal(formatColumnNumber(2024, { name, format: 'number' }), '2024');
		assert.equal(formatColumnNumber(2007, { name }), '2007');
	}
	assert.equal(ENTITY_COLUMNS.companies.find((column) => column.name === 'Founded')?.format, 'year');
	assert.equal(formatColumnNumber(2024, { format: 'year', useGrouping: true, decimalPlaces: 2 }), '2024');
	assert.equal(cellFromInput('2024', { format: 'year' }).v, 2024);
	assert.equal(formatColumnNumber(2024, { name: 'Employees', format: 'number' }), '2,024');
	assert.equal(formatColumnNumber(2024, { name: 'Founded', format: 'number', useGrouping: true, decimalPlaces: 1 }), '2,024.0');
});

test('column number settings control grouping and fixed precision across numeric formats', () => {
	assert.equal(formatColumnNumber(1234.567, { format: 'number', useGrouping: false, decimalPlaces: 2 }), '1234.57');
	assert.equal(formatColumnNumber(1234, { format: 'number', decimalPlaces: 3 }), '1,234.000');
	assert.equal(formatColumnNumber(1234.5, { format: 'currency', useGrouping: false, decimalPlaces: 0 }), '$1235');
	assert.equal(formatColumnNumber(0.125, { format: 'percent', decimalPlaces: 2 }), '12.50%');
	assert.equal(formatColumnNumber(1234.5, { format: 'unit', unit: 'kg', useGrouping: false, decimalPlaces: 1 }), '1234.5 kg');
	const column = { id: 'c', name: 'Number', type: 'source', width: 180, format: 'number', useGrouping: false, decimalPlaces: 0, createdAt: 1 };
	const sheet = { id: 's', name: 'Formats', columns: [column], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
	assert.deepEqual(sheetSchema.parse(sheet), sheet);
	for (const decimalPlaces of [-1, 1.5, 11]) assert.equal(sheetSchema.safeParse({ ...sheet, columns: [{ ...column, decimalPlaces }] }).success, false);
});

test('categories accept only configured labels, preserve literal labels, and default empty cells to the first option', () => {
	const column = { format: 'category' as const, categoryOptions: ['New', 'In progress', 'Done', 'null', '=Ready', "'Quoted", '123'] };
	for (const label of column.categoryOptions) assert.equal(cellFromInput(`'${label}`, column).v, label);
	assert.equal(cellFromInput('  In progress  ', column).v, 'In progress');
	assert.equal(cellFromInput('null', column).v, 'null');
	assert.equal(cellFromInput('', column).v, 'New');
	assert.equal(typedColumnValue(null, column), 'New');
	for (const value of ['Other', 'new', 123, ['New'], true]) assert.throws(() => typedColumnValue(value, column), /configured categories/);
	assert.equal(cellFromInput('="New"', column).f, '="New"');
});

test('workspace schema preserves categories and rejects missing, duplicate, and empty options', () => {
	const column = { id: 'c', name: 'Status', type: 'source', width: 180, format: 'category', categoryOptions: ['New', 'Done'], createdAt: 1 };
	const sheet = { id: 's', name: 'Categories', columns: [column], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
	assert.deepEqual(sheetSchema.parse(sheet), sheet);
	for (const categoryOptions of [undefined, [], ['New', 'New'], [' '], ['a'.repeat(201)]]) {
		assert.equal(sheetSchema.safeParse({ ...sheet, columns: [{ ...column, categoryOptions }] }).success, false);
	}
});

test('category colors survive schema validation and reject invalid CSS', async () => {
	const { categoryColor, categoryColorStyle } = await import('../src/lib/category-colors');
	const column = { id: 'c', name: 'Status', type: 'source', width: 180, format: 'category', categoryOptions: ['New', 'Done'], categoryColors: { New: '#123456', Done: '#ffffff' }, createdAt: 1 };
	const sheet = { id: 's', name: 'Colors', columns: [column], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
	const saved = sheetSchema.parse(sheet).columns[0];
	assert.deepEqual(saved.categoryColors, column.categoryColors);
	assert.equal(categoryColor(saved, 'New'), '#123456');
	assert.equal(categoryColorStyle('#123456').color, '#ffffff');
	assert.equal(categoryColorStyle('#ffffff').color, '#000000');
	assert.match(categoryColor({ categoryOptions: ['New'] }, 'New'), /^#[a-f0-9]{6}$/);
	for (const color of ['red', '#123', 'url(https://example.com)', '#12345678']) {
		assert.equal(sheetSchema.safeParse({ ...sheet, columns: [{ ...column, categoryColors: { New: color } }] }).success, false);
	}
});
