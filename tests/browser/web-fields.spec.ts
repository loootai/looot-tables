import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Sheet, Row } from '../../src/lib/types';

test('Website and Webpage dropdowns create bound operations without favicons', async ({ page, context, baseURL }) => {
	await context.addCookies([{ name: 'looot-tables-session', value: memberCookie('web-field-test'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
	const columns: Sheet['columns'] = [
		{ id: 'domain', name: 'Domain', type: 'source', format: 'url', width: 240, createdAt: 1 },
		{ id: 'article', name: 'Article', type: 'source', format: 'url', width: 330, createdAt: 1 },
	];
	let sheet: Sheet = { id: 'web-field-test', name: 'Web operations', columns, filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
	let rows: Row[] = [{ id: 'r1', sheetId: sheet.id, order: 0, createdAt: 1, cells: { domain: { v: 'example.com', s: 'done', t: 1 }, article: { v: 'https://example.com/docs?lang=en', s: 'done', t: 1 } } }];
	const requests: Array<{ op: { kind: string; mode: string; page: { type: string; column: string } } }> = [];
	await page.route('**/api/looot/balance*', (route) => route.fulfill({ json: { available: 5, reserved: 0 } }));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/enrich', async (route) => {
		const request = route.request().postDataJSON(); requests.push(request);
		await route.fulfill({ json: { value: request.op.mode === 'markdown' ? '# Homepage' : ['https://example.com/guide'] } });
	});
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
	// An older sheet's Domain column is renamed once when it loads.
	await expect(page.getByRole('columnheader').nth(1)).toContainText('Website');
	await expect.poll(() => sheet.columns[0].name).toBe('Website');
	await expect(page.getByRole('gridcell').first().locator('img')).toHaveCount(0);
	const website = page.getByRole('button', { name: 'Website actions', exact: true });
	await website.click();
	await expect(page.getByRole('checkbox', { name: 'Discover site URLs', exact: true })).toBeVisible();
	await page.getByRole('checkbox', { name: 'Get Markdown', exact: true }).click();
	await page.getByRole('button', { name: 'Run on this row, 1 field selected', exact: true }).click();
	await expect.poll(() => requests.length).toBe(1);
	expect(requests[0].op).toMatchObject({ kind: 'scrape', mode: 'markdown', page: { type: 'homepage', column: 'Website' } });
	await expect(page.getByRole('columnheader').nth(2)).toContainText('Get Markdown');
	await page.getByRole('button', { name: 'Column menu for Article', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Field format', exact: true }).click();
	await page.getByRole('combobox', { name: 'Format', exact: true }).click();
	await page.getByRole('option', { name: 'Webpage', exact: true }).click();
	await page.getByRole('button', { name: 'Save format', exact: true }).click();
	const webpage = page.getByRole('button', { name: 'Webpage actions', exact: true });
	await webpage.click();
	await expect(page.getByRole('checkbox', { name: 'Discover site URLs', exact: true })).toHaveCount(0);
	await page.getByRole('checkbox', { name: 'Get links', exact: true }).click();
	await page.getByRole('button', { name: 'Run on this row, 1 field selected', exact: true }).click();
	await expect.poll(() => requests.length).toBe(2);
	expect(requests[1].op).toMatchObject({ kind: 'scrape', mode: 'links', page: { type: 'column', column: 'Article' } });
	expect(rows[0].cells.article.v).toBe('https://example.com/docs?lang=en');
	await webpage.click();
	await page.getByRole('checkbox', { name: 'Extract data…', exact: true }).click();
	await page.getByRole('button', { name: 'Run on this row, 1 field selected', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Add AI column', exact: true });
	await expect(editor).toBeVisible();
	await expect(editor.getByRole('button', { name: 'Run on row 1', exact: true })).toBeDisabled();
	await expect(editor).toContainText('Add a field or instructions to extract');
	await editor.getByLabel('Field 1', { exact: true }).pressSequentially('product:');
	await expect(editor.getByLabel('Field 1', { exact: true })).toHaveValue('product:');
	await editor.getByLabel('Field 1', { exact: true }).press('Backspace');
	await editor.getByLabel('Field 1 description', { exact: true }).fill('Product name');
	await page.getByRole('button', { name: 'Add without running', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(requests).toHaveLength(2);
	expect(sheet.columns.find((column) => column.name === 'Extracted data')?.op).toMatchObject({ kind: 'scrape', mode: 'extract', fields: [{ name: 'product', description: 'Product name' }], page: { type: 'column', column: 'Article' } });
	await page.reload();
	await expect(page.getByRole('button', { name: 'Webpage actions', exact: true })).toBeVisible();
	await expect(page.getByRole('columnheader').nth(1)).toContainText('Website');
});
