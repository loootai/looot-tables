import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DATE_FORMATS, formatDate, parseDate } from '../src/lib/date-format';
import { sheetSchema } from '../src/lib/workspace';

test('date formats retain calendar dates including leap days and timezone offsets', () => {
	const expected = ['2024-02-29', '02/29/2024', '29/02/2024', '29.02.2024', 'Feb 29, 2024', '29 Feb 2024'];
	DATE_FORMATS.forEach((format, i) => {
		assert.equal(formatDate('2024-02-29', format), expected[i]);
		assert.equal(formatDate('2024-02-29T23:00:00-08:00', format), expected[i]);
	});
	assert.equal(parseDate('2023-02-29'), undefined);
	assert.equal(formatDate('2023-02-29', 'DD/MM/YYYY'), '2023-02-29');
	assert.equal(formatDate('unknown'), 'unknown');
	assert.equal(formatDate(''), '');
});

test('workspace validation preserves date format settings and rejects unknown formats', () => {
	const sheet = { id: 'date-test', name: 'Dates', columns: [{ id: 'date', name: 'Date', type: 'source', width: 180, format: 'date', dateFormat: 'DD/MM/YYYY', createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
	assert.equal(sheetSchema.parse(sheet).columns[0].dateFormat, 'DD/MM/YYYY');
	sheet.columns[0].dateFormat = 'unsupported';
	assert.equal(sheetSchema.safeParse(sheet).success, false);
});
