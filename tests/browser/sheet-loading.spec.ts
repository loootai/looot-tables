import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Row, Sheet } from '../../src/lib/types';

async function workspace(page: Page, context: BrowserContext, baseURL: string) {
	await context.addCookies([{ name: 'enrichable.session', value: memberCookie('sheet-loading'), url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
	const sheet: Sheet = { id: 'sheet-loading', name: 'Existing sheet', columns: [{ id: 'value', name: 'Value', type: 'source', width: 180, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
	const rows: Row[] = [{ id: 'row', sheetId: sheet.id, order: 0, createdAt: 1, cells: { value: { v: 'Saved data', s: 'done', t: 1 } } }];
	const state = { listed: false, status: 200, reads: 0 };
	await page.route('**/api/looot/balance*', (route) => route.fulfill({ json: { available: 5, reserved: 0 } }));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: false, looot: false, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/sheets**', async (route) => {
		if (new URL(route.request().url()).pathname === '/api/sheets') {
			await route.fulfill({ json: state.listed ? [{ sheet, rowCount: rows.length }] : [] });
		} else {
			state.reads += 1;
			await route.fulfill({ status: state.status, json: state.status === 200 ? { sheet, rows, next: null } : { error: state.status === 404 ? 'Sheet not found in this workspace.' : 'Workspace temporarily unavailable.' } });
		}
	});
	return { state, sheet, async open() {
		await page.goto(`/app/sheets/${sheet.id}`);
		await page.getByRole('dialog').waitFor();
		await page.getByRole('button', { name: 'Close', exact: true }).click();
	} };
}

test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });

test('a missing local cache entry loads the sheet directly instead of claiming it is missing', async ({ page, context, baseURL }) => {
	const { state, open } = await workspace(page, context, baseURL!);
	await open();
	await expect(page.getByRole('gridcell').first()).toHaveText('Saved data');
	expect(state.reads).toBeGreaterThan(0);
	await expect(page.getByText("This sheet doesn't exist in this workspace.", { exact: true })).toHaveCount(0);
});

test('an outdated workspace list cannot evict an existing sheet on focus refresh', async ({ page, context, baseURL }) => {
	const { state, open } = await workspace(page, context, baseURL!);
	state.listed = true;
	await open();
	await expect(page.getByRole('gridcell').first()).toHaveText('Saved data');
	const previousReads = state.reads;
	state.listed = false;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect.poll(() => state.reads).toBeGreaterThan(previousReads);
	await expect(page.getByRole('gridcell').first()).toHaveText('Saved data');
	await expect(page.getByText("This sheet doesn't exist in this workspace.", { exact: true })).toHaveCount(0);
});

test('a failed sheet read shows a retryable connection error and recovers', async ({ page, context, baseURL }) => {
	const { state, open } = await workspace(page, context, baseURL!);
	state.status = 503;
	await open();
	await expect(page.getByRole('alert').filter({ hasText: "Couldn't load this sheet." })).toContainText("Couldn't load this sheet.");
	await expect(page.getByText("This sheet doesn't exist in this workspace.", { exact: true })).toHaveCount(0);
	state.status = 200;
	await page.getByRole('button', { name: 'Retry', exact: true }).click();
	await expect(page.getByRole('gridcell').first()).toHaveText('Saved data');
});

test('only a confirmed server 404 shows the missing sheet message', async ({ page, context, baseURL }) => {
	const { state, open } = await workspace(page, context, baseURL!);
	state.status = 404;
	await open();
	await expect(page.getByText("This sheet doesn't exist in this workspace.", { exact: true })).toBeVisible();
	expect(state.reads).toBeGreaterThan(0);
});
