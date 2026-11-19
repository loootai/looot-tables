import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Sheet, Row } from '../../src/lib/types';

for (const rowCount of [3, 12]) test(`field selections run together from the current row (${rowCount} rows)`, async ({ page, context, baseURL }) => {
	await page.route('**/api/keys/verify', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	const requests: Array<{ op: { kind: string; field?: string }; row: Record<string, string> }> = [];
	await page.route('**/api/enrich', async (route) => {
		requests.push(route.request().postDataJSON());
		await route.fulfill({ json: { value: 'Enriched answer' } });
	});
	await context.addCookies([{ name: 'enrichable.session', value: memberCookie('field-selection-test'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
	let sheet: Sheet = { id: 'field-selection-test', name: 'Selected fields', columns: [
		{ id: 'company', name: 'Company', type: 'source', width: 240, createdAt: 1 },
		{ id: 'domain', name: 'Website', type: 'source', format: 'url', width: 240, createdAt: 1 },
	], filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
	const names = Array.from({ length: rowCount }, (_, index) => `Company ${index + 1}`);
	const runCount = Math.min(10, rowCount);
	// From row 1 of a 3-row sheet, "the rest" is every row, so the menu offers it once as "all".
	const runLabel = runCount === rowCount ? `Run on all ${rowCount} rows` : `Run on ${runCount} rows`;
	let rows: Row[] = names.map((name, order) => ({ id: `r${order}`, sheetId: sheet.id, order, createdAt: 1, cells: { company: { v: name, s: 'done', t: 1 }, domain: { v: `${name.toLowerCase().replaceAll(' ', '')}.com`, s: 'done', t: 1 } } }));
	await page.route('**/api/context/usage*', (route) => route.fulfill({ json: { credits: 25000, used: 0 } }));
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
	const trigger = page.getByRole('button', { name: 'Add company field column', exact: true }).first();
	await trigger.click();
	await expect(page.getByRole('button', { name: 'Run on this row, 0 fields selected', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Address', exact: true }).click();
	const city = page.getByRole('checkbox', { name: 'City', exact: true });
	await city.click();
	await expect(city).toBeChecked();
	await expect(city.locator('svg')).toHaveClass(/lucide-check/);
	await page.getByRole('checkbox', { name: 'Country', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Run on this row, 2 fields selected', exact: true })).toBeVisible();
	await city.click();
	await expect(city).not.toBeChecked();
	await expect(city.locator('svg')).toHaveClass(/lucide-plus/);
	await city.click();
	await page.getByRole('button', { name: 'Company / Address', exact: true }).click();
	await page.getByRole('button', { name: 'Overview', exact: true }).click();
	await page.getByRole('checkbox', { name: 'Industry', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Run on this row, 3 fields selected', exact: true })).toBeVisible();
	await page.getByRole('checkbox', { name: 'Industry', exact: true }).click();
	await page.getByRole('button', { name: 'Company / Overview', exact: true }).click();
	await page.getByRole('button', { name: 'Address', exact: true }).click();
	await expect(city).toBeChecked();
	await expect(page.getByRole('checkbox', { name: 'Country', exact: true })).toBeChecked();
	await page.getByRole('textbox', { name: 'Custom query', exact: true }).fill('What does {{Company}} in {{City}}, {{Country}} sell?');
	await expect(page.getByRole('button', { name: 'Run on this row, 3 fields selected', exact: true })).toBeVisible();
	expect(requests).toHaveLength(0);
	await expect(page.getByRole('columnheader')).toHaveCount(3);
	await page.screenshot({ path: '/tmp/enrichable-selected-fields.png' });
	await page.getByRole('button', { name: 'Choose which rows to run', exact: true }).click();
	await page.getByRole('menuitemradio', { name: runLabel, exact: true }).click();
	await page.getByRole('button', { name: `${runLabel}, 3 fields selected`, exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(runCount * 3);
	expect(requests.filter((request) => request.op.field === 'city')).toHaveLength(runCount);
	expect(requests.filter((request) => request.op.field === 'country')).toHaveLength(runCount);
	expect(requests.filter((request) => request.op.kind === 'ai')).toHaveLength(runCount);
	expect(requests.filter((request) => request.op.field === 'city').map((request) => request.row.Company)).toEqual(names.slice(0, runCount));
	await expect(page.getByRole('columnheader').nth(2)).toContainText('Country');
	await expect(page.getByRole('columnheader').nth(3)).toContainText('City');
	await expect(page.getByRole('columnheader').nth(4)).toContainText('What does {{Company}} in {{City}}, {{Country}} sell?');
	await trigger.click();
	await expect(page.getByRole('button', { name: `${runLabel}, 0 fields selected`, exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Add company field column', exact: true }).nth(rowCount - 2).click();
	await expect(page.getByRole('button', { name: `${rowCount === 3 ? runLabel : 'Run on 2 rows'}, 0 fields selected`, exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Add company field column', exact: true }).last().click();
	await expect(page.getByRole('button', { name: `${rowCount === 3 ? runLabel : 'Run on this row'}, 0 fields selected`, exact: true })).toBeVisible();
});
