import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Sheet, Row } from '../../src/lib/types';

test('date picker selects, clears, cancels and persists dates', async ({ page, context, baseURL }) => {
	await context.addCookies([{ name: 'enrichable.session', value: memberCookie('format-test'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
	const columns: Sheet['columns'] = ['Date', 'Selected', 'Weight'].map((name, i) => ({ id: `c${i}`, name, type: 'source', format: i === 0 ? 'date' : undefined, width: 180, createdAt: 1 }));
	let sheet: Sheet = { id: 'format-test', name: 'Formats', columns, filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
	let rows: Row[] = [0, 1].map((i) => ({ id: `r${i}`, sheetId: sheet.id, order: i, createdAt: 1, cells: Object.fromEntries(columns.map((column, c) => [column.id, { v: c === 0 ? '2024-02-15' : c === 1 ? 'false' : 12.5 + i, s: 'done', t: 1 }])) }));
	await page.route('**/api/context/usage*', (route) => route.fulfill({ json: { credits: 25000, used: 0 } }));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: false, context: false, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/sheets**', async (route) => {
		const request = route.request();
		if (request.method() === 'PATCH') {
			const body = request.postDataJSON();
			sheet = { ...body.sheet, revision: sheet.revision! + 1 };
			const updates = new Map<string, Row>(body.rows.map((row: Row) => [row.id, row]));
			rows = rows.map((row) => updates.get(row.id) ?? row);
			await route.fulfill({ json: { revision: sheet.revision, updatedAt: Date.now() } });
		} else if (new URL(request.url()).pathname === '/api/sheets') await route.fulfill({ json: [{ sheet, rowCount: rows.length }] });
		else await route.fulfill({ json: { sheet, rows, next: null } });
	});
	await page.goto(`/app/sheets/${sheet.id}`);
	await page.getByRole('dialog').waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();

	const trigger = page.getByRole('button', { name: 'Date date', exact: true }).first();
	await trigger.click();
	const picker = page.getByRole('dialog', { name: 'Date date' });
	await expect(picker).toBeVisible();
	await picker.getByRole('button', { name: /February 20th, 2024/ }).click();
	await expect.poll(() => rows[0].cells.c0.v).toBe('2024-02-20');
	await expect(picker).toHaveCount(0);
	await trigger.click();
	await page.keyboard.press('Escape');
	await expect(picker).toHaveCount(0);
	expect(rows[0].cells.c0.v).toBe('2024-02-20');
	await page.getByRole('button', { name: 'Column menu for Date', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Field format', exact: true }).click();
	await page.getByRole('combobox', { name: 'Date format', exact: true }).click();
	await page.getByRole('option', { name: 'DD/MM/YYYY · 23/11/2024', exact: true }).click();
	await expect(page.getByText('Preview:')).toHaveText('Preview: 23/11/2024');
	await page.getByRole('button', { name: 'Save format', exact: true }).click();
	await expect(trigger).toHaveText('20/02/2024');
	await expect(page.getByRole('button', { name: 'Date date', exact: true }).nth(1)).toHaveText('15/02/2024');
	await expect.poll(() => sheet.columns[0].dateFormat).toBe('DD/MM/YYYY');
	expect(rows[0].cells.c0.v).toBe('2024-02-20');
	await page.reload();
	// Setup opens once per browser; it stays closed after a reload.
	await expect(page.getByRole('dialog', { name: 'Set up enrichment' })).toHaveCount(0);
	await expect(trigger).toHaveText('20/02/2024');
	await trigger.click();
	await picker.getByRole('button', { name: 'Clear date' }).click();
	await expect.poll(() => rows[0].cells.c0.v).toBeNull();
	await expect(trigger).toHaveText('Pick a date');
	expect(await page.pageErrors()).toEqual([]);
});
