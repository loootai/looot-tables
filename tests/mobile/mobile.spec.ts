import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Row, Sheet } from '../../src/lib/types';

// Exercise the real app and IndexedDB while keeping every remote write/provider
// request in memory. Mobile tests never access a configured shared database.
/** Phones keep Search, Find rows and Run in the toolbar and put Filter, Add and Export under More actions. */
async function toolbarAction(page: Page, name: 'Filter' | 'Add' | 'Export') {
	const more = page.getByRole('button', { name: 'More actions', exact: true });
	if (await more.isVisible()) {
		await more.click();
		await page.getByRole('menuitem', { name, exact: true }).click();
	} else await page.getByRole('button', { name, exact: true }).click();
}

async function workspace(page: Page, options: { connected?: boolean; seeded?: boolean } = {}) {
	const sheets = new Map<string, { sheet: Sheet; rows: Row[] }>();
	if (options.seeded) {
		const sheet: Sheet = {
			id: 'mobile-fixture', name: 'A long mobile research sheet title',
			columns: [
				{ id: 'name', name: 'Company', type: 'source', width: 220, createdAt: 1 },
				{ id: 'domain', name: 'Website', type: 'source', width: 220, createdAt: 1 },
				{ id: 'draft', name: 'Email draft', type: 'enriched', format: 'email-draft', width: 300, createdAt: 1, op: { kind: 'email-draft', mode: 'ai', prompt: 'Write an introduction to {{Company}}', to: '', cc: '', bcc: '', subject: '', body: '' } },
			], filters: [], sort: null, revision: 1, createdAt: 1, updatedAt: 1,
		};
		const rows: Row[] = [{ id: 'mobile-row', sheetId: sheet.id, order: 0, createdAt: 1, cells: { name: { v: 'Acme', s: 'done', t: 1 }, domain: { v: 'acme.example', s: 'done', t: 1 }, draft: { v: JSON.stringify({ to: 'hello@acme.example', cc: '', bcc: '', subject: 'A mobile-friendly introduction', body: 'Hello Acme,\n\nHere is a long email draft to read comfortably on a phone.' }), s: 'done', t: 1 } } }];
		sheets.set(sheet.id, { sheet, rows });
	}
	await page.route('**/api/**', async (route) => {
		const request = route.request(), url = new URL(request.url());
		if (url.pathname.startsWith('/api/auth/')) return route.continue();
		if (url.pathname === '/api/keys/verify') return route.fulfill({ json: { openai: options.connected !== false, context: options.connected !== false, typesafe: false, passwordRequired: false } });
		if (url.pathname === '/api/context/usage') return route.fulfill({ json: { credits: 25000, used: 0 } });
		if (url.pathname === '/api/mcp-key') return route.fulfill({ json: { key: null } });
		if (url.pathname === '/api/logos/resolve') return route.fulfill({ json: { domain: null } });
		if (url.pathname === '/api/populate') return route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'rows', rows: [{ Company: 'Orbit', Domain: 'orbit.example' }], key: 'Domain' }, { type: 'done', total: 1 }].map((event) => JSON.stringify(event)).join('\n') + '\n' });
		if (url.pathname === '/api/enrich') return route.fulfill({ json: { value: JSON.stringify({ to: 'hello@orbit.example', cc: '', bcc: '', subject: 'A simulated enriched value', body: 'Hello Orbit' }) } });
		if (url.pathname === '/api/sheets') {
			if (request.method() === 'POST') {
				const value = request.postDataJSON() as { sheet: Sheet; rows: Row[] };
				value.sheet.revision = 1;
				sheets.set(value.sheet.id, value);
				return route.fulfill({ json: value.sheet });
			}
			return route.fulfill({ json: [...sheets.values()].map(({ sheet, rows }) => ({ sheet, rowCount: rows.length })) });
		}
		if (url.pathname.startsWith('/api/sheets/')) {
			const id = decodeURIComponent(url.pathname.split('/')[3]), value = sheets.get(id);
			if (!value) return route.fulfill({ status: 404, json: { error: 'Sheet not found' } });
			if (request.method() === 'PATCH') {
				const patch = request.postDataJSON() as { sheet: Sheet; rows: Row[]; deleted: string[] };
				value.sheet = { ...patch.sheet, revision: (value.sheet.revision ?? 0) + 1, updatedAt: Date.now() };
				const next = new Map(value.rows.filter((row) => !patch.deleted.includes(row.id)).map((row) => [row.id, row]));
				for (const row of patch.rows) next.set(row.id, row);
				value.rows = [...next.values()];
				return route.fulfill({ json: { revision: value.sheet.revision, updatedAt: value.sheet.updatedAt } });
			}
			return route.fulfill({ json: { ...value, next: null } });
		}
		return route.fulfill({ json: { enabled: false, peers: [] } });
	});
	return sheets;
}

async function fitsViewport(page: Page, target: Locator) {
	await expect(target).toBeVisible();
	await expect.poll(async () => {
		const box = await target.boundingBox(), viewport = page.viewportSize()!;
		return Boolean(box && box.x >= -1 && box.x + box.width <= viewport.width + 1 && box.y >= -1 && box.y + box.height <= viewport.height + 1);
	}).toBe(true);
}

async function noPageOverflow(page: Page) {
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

async function capture(page: Page, name: string) {
	const output = resolve('output/mobile');
	await mkdir(output, { recursive: true });
	await page.screenshot({ path: resolve(output, name) });
}

async function touchSwipeLeft(page: Page, grid: Locator) {
	const box = (await grid.boundingBox())!;
	const session = await page.context().newCDPSession(page);
	const startX = box.x + box.width - 30, endX = box.x + 60, y = box.y + Math.min(box.height / 2, 130);
	await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] });
	for (let step = 1; step <= 8; step++) {
		await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX + (endX - startX) * step / 8, y }] });
		await page.waitForTimeout(25);
	}
	await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await session.detach();
}

test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });

test('landing page and onboarding fit narrow screens', async ({ page }) => {
	await workspace(page, { connected: false });
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await noPageOverflow(page);
	await page.getByRole('link', { name: 'Start enriching', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Set up enrichment' });
	await fitsViewport(page, dialog);
	await expect(page.getByLabel('Context.dev API key', { exact: true })).toBeVisible();
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Sheets', exact: true })).toBeVisible();
	await noPageOverflow(page);
});

test('navigation, settings, and provider dialog remain reachable', async ({ page }) => {
	await workspace(page);
	await page.goto('/app');
	const mobile = page.viewportSize()!.width < 768;
	if (mobile) {
		await page.getByRole('button', { name: 'Open navigation' }).tap();
		await fitsViewport(page, page.getByRole('complementary', { name: 'Workspace navigation' }));
		await expect(page.locator('main')).toHaveJSProperty('inert', true);
	}
	await page.getByRole('link', { name: 'Configuration', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Configuration', exact: true })).toBeVisible();
	await expect(page.locator('main')).toHaveJSProperty('inert', false);
	await noPageOverflow(page);
	await page.getByRole('region', { name: 'Connections' }).getByRole('listitem').filter({ hasText: 'Hunter' }).getByRole('button', { name: 'Connect', exact: true }).click();
	await fitsViewport(page, page.getByRole('dialog', { name: 'Connect Hunter' }));
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Agent access', exact: true })).toBeVisible();
});

test('CSV import creates a horizontally scrollable sheet and exports data', async ({ page, hasTouch }, testInfo) => {
	await workspace(page);
	await page.goto('/app');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Mobile imported sheet');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Domain,Location,Description\nAcme,acme.example,New York,A much longer company description\nOrbit,orbit.example,London,A second company description');
	await fitsViewport(page, page.getByRole('dialog'));
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	const grid = page.getByRole('grid', { name: 'Sheet grid' });
	await expect(page.getByRole('gridcell').first()).toContainText('Acme');
	await noPageOverflow(page);
	await fitsViewport(page, grid);
	if (page.viewportSize()!.width < 1000) {
		expect(await grid.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
		if (hasTouch) await touchSwipeLeft(page, grid);
		else await grid.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
		await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
	}
	await capture(page, `${testInfo.project.name}-sheet.png`);
	await toolbarAction(page, 'Export');
	await fitsViewport(page, page.getByRole('menu', { name: 'Export', exact: true }));
	const downloadReady = page.waitForEvent('download');
	await page.getByRole('menuitem', { name: 'CSV', exact: true }).click();
	expect((await downloadReady).suggestedFilename()).toMatch(/\.csv$/);
	await page.getByRole('searchbox', { name: 'Search rows', exact: true }).fill('Orbit');
	await expect(page.getByRole('gridcell').first()).toContainText('Orbit');
});

test('cell details, filtering, and enriched column setup fit the viewport', async ({ page, hasTouch }, testInfo) => {
	await workspace(page, { seeded: true });
	await page.goto('/app/sheets/mobile-fixture');
	const cell = page.getByRole('gridcell').nth(2);
	if (hasTouch) {
		await cell.tap();
		await expect(cell).toHaveAttribute('aria-selected', 'true');
		await cell.tap();
	} else await cell.dblclick();
	const panel = page.getByRole('complementary', { name: 'Cell details' });
	await fitsViewport(page, panel);
	await expect(panel.getByLabel('Subject', { exact: true })).toHaveValue('A mobile-friendly introduction');
	await capture(page, `${testInfo.project.name}-cell-details.png`);
	await panel.getByLabel('Body', { exact: true }).scrollIntoViewIfNeeded();
	await expect(panel.getByLabel('Body', { exact: true })).toBeInViewport();
	await panel.getByRole('button', { name: 'Close', exact: true }).click();
	await toolbarAction(page, 'Filter');
	await fitsViewport(page, page.getByRole('dialog', { name: 'Filters', exact: true }));
	await page.keyboard.press('Escape');
	await toolbarAction(page, 'Add');
	await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
	await fitsViewport(page, page.getByRole('dialog'));
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await noPageOverflow(page);
});

test('simulated row discovery and template enrichment work from a mobile dialog', async ({ page }) => {
	const sheets = await workspace(page, { seeded: true });
	await page.goto('/app/sheets/mobile-fixture');
	await page.getByRole('button', { name: 'Find rows', exact: true }).click();
	await fitsViewport(page, page.getByRole('dialog'));
	await page.getByLabel('Describe the rows you want', { exact: true }).fill('Developer tool companies');
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Find rows', exact: true })).toBeEnabled({ timeout: 20_000 });
	await expect.poll(() => sheets.get('mobile-fixture')!.rows.length).toBe(2);
	await page.getByRole('searchbox', { name: 'Search rows', exact: true }).fill('Orbit');
	await expect(page.getByRole('gridcell').first()).toContainText('Orbit');
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Run (\d+ )?unfinished cells?$/ }).click();
	await expect.poll(() => {
		const value = sheets.get('mobile-fixture')!.rows.find((row) => row.cells.name?.v === 'Orbit')?.cells.draft?.v;
		return typeof value === 'string' ? JSON.parse(value).subject : null;
	}, { timeout: 20_000 }).toBe('A simulated enriched value');
	await noPageOverflow(page);
});
