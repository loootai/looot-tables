import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Sheet, Row } from '../../src/lib/types';

// Exercise the actual UI and persistence requests without depending on a live Neon database.
test('header clicks cycle sorting before and immediately after dragging', async ({ page, context, baseURL }) => {
	await context.addCookies([{ name: 'looot-tables-session', value: memberCookie('format-test'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
	const columns: Sheet['columns'] = ['Cost', 'Selected', 'Weight'].map((name, i) => ({ id: `c${i}`, name, type: 'source', width: 180, createdAt: 1 }));
	let sheet: Sheet = { id: 'format-test', name: 'Formats', columns, filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
	let rows: Row[] = [0, 1].map((i) => ({ id: `r${i}`, sheetId: sheet.id, order: i, createdAt: 1, cells: Object.fromEntries(columns.map((column, c) => [column.id, { v: c === 0 ? 1234.5 + i : c === 1 ? 'false' : 12.5 + i, s: 'done', t: 1 }])) }));
	await page.route('**/api/looot/balance*', (route) => route.fulfill({ json: { available: 5, reserved: 0 } }));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: false, looot: false, typesafe: false, passwordRequired: false } }));
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
	await expect(page.getByRole('gridcell').first()).toHaveText('1,234.5');
	const header = (name: string) => page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: new RegExp(`^[A-Z]+ ${name}$`) }) });
	const clickWeight = () => header('Weight').getByRole('button', { name: /^[A-Z]+ Weight$/ }).click();
	await clickWeight();
	await expect(header('Weight')).toHaveAttribute('aria-sort', 'ascending');
	await clickWeight();
	await expect(header('Weight')).toHaveAttribute('aria-sort', 'descending');
	await expect(page.getByRole('gridcell').nth(2)).toHaveText('13.5');
	await clickWeight();
	await expect(header('Weight')).toHaveAttribute('aria-sort', 'none');
	await expect(page.getByRole('gridcell').nth(2)).toHaveText('12.5');
	const from = await header('Weight').boundingBox(), to = await header('Cost').boundingBox();
	if (!from || !to) throw new Error('Missing header');
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 8 });
	await page.mouse.up();
	await expect(page.getByRole('columnheader').nth(1)).toContainText('Weight');
	await expect(header('Weight')).toHaveAttribute('aria-sort', 'none');
	await clickWeight();
	await expect(header('Weight')).toHaveAttribute('aria-sort', 'ascending');
	await clickWeight();
	await expect(header('Weight')).toHaveAttribute('aria-sort', 'descending');
	await expect(page.getByRole('gridcell').first()).toHaveText('13.5');
	await clickWeight();
	await expect(header('Weight')).toHaveAttribute('aria-sort', 'none');
	await expect(page.getByRole('gridcell').first()).toHaveText('12.5');
	expect(sheet.sort, 'sorting is this viewer’s own and never written to the shared sheet').toBeNull();
	expect(await page.pageErrors()).toEqual([]);
});
