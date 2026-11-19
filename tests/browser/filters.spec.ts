import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Sheet, Row } from '../../src/lib/types';

// Exercise the actual UI without depending on a live Neon database.
for (const company of [false, true]) {
test(`${company ? 'Company' : 'Category'} filters apply as they are chosen and stay applied when the panel is dismissed`, async ({ page, context, baseURL }) => {
	await context.addCookies([{ name: 'enrichable.session', value: memberCookie('format-test'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
	const columns: Sheet['columns'] = [company ? 'Company' : 'Category'].map((name, i) => ({ id: `c${i}`, name, type: 'source', ...(company ? {} : { format: 'category' as const, categoryOptions: ['Customer', 'Prospect'] }), width: 180, createdAt: 1 }));
	let sheet: Sheet = { id: 'format-test', name: 'Formats', columns, filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
	let rows: Row[] = [0, 1].map((i) => ({ id: `r${i}`, sheetId: sheet.id, order: i, createdAt: 1, cells: Object.fromEntries(columns.map((column) => [column.id, { v: i === 0 ? 'Customer' : 'Prospect', s: 'done', t: 1 }])) }));
	await page.route('**/api/looot/balance*', (route) => route.fulfill({ json: { available: 5, reserved: 0 } }));
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
	const dialog = page.getByRole('dialog', { name: 'Filters', exact: true });
	const open = () => page.getByRole('button', { name: /^Filter(?: \d+)?$/ }).click();
	await open();
	await dialog.getByRole('button', { name: 'Add filter' }).click();
	await dialog.getByRole('combobox', { name: 'Filter value' }).click();
	await dialog.getByRole('combobox', { name: 'Filter value' }).fill('Cust');
	await expect(page.getByRole('option', { name: 'Prospect', exact: true })).toHaveCount(0);
	await dialog.getByRole('combobox', { name: 'Filter value' }).press('ArrowDown');
	await dialog.getByRole('combobox', { name: 'Filter value' }).press('Enter');
	await expect(dialog.getByRole('combobox', { name: 'Filter value' })).toHaveValue('Customer');
	await expect(dialog.getByRole('status')).toHaveText('1 of 2 rows shown');
	await dialog.getByRole('button', { name: 'Close filters' }).click();
	await expect(dialog).not.toBeVisible();
	// Filters are this viewer's own: kept in the browser, never written to the shared sheet.
	await page.reload();
	await expect(page.getByRole('button', { name: 'Filter 1' })).toBeVisible();
	expect(sheet.filters).toEqual([]);
	await open();
	await expect(dialog.getByRole('combobox', { name: 'Filter value' })).toHaveValue('Customer');
	await expect(dialog.getByRole('status')).toHaveText('1 of 2 rows shown');
	await dialog.getByRole('combobox', { name: 'Filter value' }).click();
	await expect(page.getByRole('option', { name: 'Prospect', exact: true })).toBeVisible();
	await dialog.getByRole('combobox', { name: 'Filter value' }).press('Escape');
	await dialog.getByRole('button', { name: 'Clear filters' }).click();
	await expect(dialog.getByRole('status')).toHaveText('2 of 2 rows shown');
	await dialog.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await open();
	await expect(dialog.getByRole('button', { name: 'Add filter' })).toBeVisible();
	await expect(dialog.getByRole('combobox', { name: 'Filter value' })).toHaveCount(0);
});

}
