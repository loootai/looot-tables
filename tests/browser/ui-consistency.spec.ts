import { expect, test } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Row, Sheet } from '../../src/lib/types';

const timestamp = 1_800_000_000_000;
const initialSheet: Sheet = {
 id: 'ui-review', revision: 1, name: 'Solar companies with a deliberately long sheet name',
 columns: [
  { id: 'company', name: 'Company', type: 'source', width: 200, createdAt: timestamp },
  { id: 'domain', name: 'Website', type: 'source', format: 'website', width: 190, createdAt: timestamp },
  { id: 'fit', name: 'ICP fit', type: 'enriched', width: 220, createdAt: timestamp, op: { kind: 'check', question: 'Is {{Company}} a solar company?', decider: 'openai', threshold: 0.5 } },
 ], filters: [], sort: null, createdAt: timestamp, updatedAt: timestamp,
};

test.beforeEach(async ({ context, baseURL }) => {
 await context.addCookies([{ name: 'looot-tables-session', value: memberCookie('browser-user'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 let sheet = structuredClone(initialSheet);
 let rows: Row[] = ['Sunrun', 'Enphase Energy'].map((name, index) => ({
  id: `row-${index}`, sheetId: sheet.id, order: index, createdAt: timestamp,
  cells: {
   company: { v: name, s: 'done', t: timestamp },
   domain: { v: index ? 'enphase.com' : 'sunrun.com', s: 'done', t: timestamp },
   fit: { v: true, s: 'done', t: timestamp, m: { confidence: 0.91, reasoning: 'Provides solar energy technology.', sources: ['https://example.com/solar'] } },
  },
 }));
 await context.route('**/api/sheets**', async (route) => {
  const request = route.request();
  if (request.method() === 'PATCH') {
   const body = request.postDataJSON();
   sheet = { ...body.sheet, revision: (sheet.revision ?? 0) + 1 };
   const changed = new Map<string, Row>(body.rows.map((row: Row) => [row.id, row]));
   rows = rows.filter((row) => !body.deleted.includes(row.id)).map((row) => changed.get(row.id) ?? row);
   await route.fulfill({ json: { revision: sheet.revision, updatedAt: sheet.updatedAt } });
  } else {
   await route.fulfill({ json: new URL(request.url()).pathname === '/api/sheets' ? [{ sheet, rowCount: rows.length }] : { sheet, rows, next: null } });
  }
 });
 await context.route('**/api/keys/verify', (route) => route.fulfill({ json: route.request().method() === 'GET' ? { openai: true, context: true, typesafe: false } : { openai: { ok: true, inference: true }, context: { ok: true, credits: 25000 }, typesafe: { ok: true, configured: false } } }));
 await context.route('**/api/looot/balance*', (route) => route.fulfill({ json: { credits: 25000, used: 5000 } }));
});

test('toolbar inserts a row below and columns to the right of the selected cell', async ({ page }) => {
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('gridcell').nth(1).click({ position: { x: 175, y: 12 } });
 await expect(page.getByRole('gridcell').nth(1)).toHaveAttribute('aria-selected', 'true');
 await page.getByRole('button', { name: 'Add', exact: true }).click();
 await page.getByRole('menuitem', { name: 'Add row', exact: true }).click();
 const dataRows = page.getByRole('row').filter({ has: page.getByRole('gridcell') });
 await expect(dataRows).toHaveCount(3);
 await expect(dataRows.nth(0)).toContainText('Sunrun');
 await expect(dataRows.nth(1).getByRole('gridcell').first()).toHaveText('');
 await expect(dataRows.nth(2)).toContainText('Enphase Energy');
 await page.getByRole('button', { name: 'Add', exact: true }).click();
 await page.getByRole('menuitem', { name: 'Blank column', exact: true }).click();
 const rename = page.getByRole('textbox', { name: 'Rename column', exact: true });
 await rename.fill('Notes');
 await rename.press('Enter');
 await page.getByRole('button', { name: 'Column menu for Notes', exact: true }).click();
 const insertRight = page.getByRole('menuitem', { name: 'Insert column right', exact: true });
 await expect(insertRight).toHaveAttribute('aria-haspopup', 'menu');
 await insertRight.focus();
 await page.keyboard.press('ArrowRight');
 const insertOptions = page.getByRole('menu', { name: 'Insert column right', exact: true });
 await expect(insertOptions.getByRole('menuitem')).toHaveCount(5);
 await page.keyboard.press('ArrowLeft');
 await expect(insertRight).toBeFocused();
 await page.keyboard.press('ArrowRight');
 await insertOptions.getByRole('menuitem', { name: 'Blank column', exact: true }).click();
 await page.getByRole('textbox', { name: 'Rename column', exact: true }).press('Escape');
 const headers = page.getByRole('columnheader');
 await expect(headers.nth(2).getByRole('button', { name: 'Column menu for Website', exact: true })).toHaveCount(1);
 await expect(headers.nth(3)).toContainText('Notes');
 await expect(headers.nth(4)).toContainText('New column');
 await expect(headers.nth(5).getByRole('button', { name: 'Column menu for ICP fit', exact: true })).toHaveCount(1);
});

test('menus support keyboard navigation and return focus to their trigger', async ({ page }) => {
 await page.goto('/app');
 const trigger = page.getByRole('button', { name: `Actions for ${initialSheet.name}`, exact: true });
 await trigger.click();
 await expect(page.getByRole('menu')).toBeVisible();
 await expect(trigger).toBeFocused();
 await page.keyboard.press('ArrowDown');
 await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
 await page.keyboard.press('ArrowDown');
 await expect(page.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeFocused();
 await page.keyboard.press('End');
 await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('menu')).toHaveCount(0);
 await expect(trigger).toBeFocused();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(trigger).toBeFocused();
});

test('all operation editors keep their actions visible on desktop and mobile', async ({ page }) => {
 const errors: string[] = [];
 page.on('pageerror', (error) => errors.push(error.message));
 for (const width of [1360, 390, 320]) {
  await page.setViewportSize({ width, height: 740 });
  await page.goto('/app/sheets/ui-review');
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
  await page.getByRole('button', { name: 'Configure manually', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
  const options = await dialog.getByRole('radiogroup', { name: 'Operation', exact: true }).getByRole('radio').allTextContents();
  expect(options).toEqual(['AI answer', 'Classify', 'Web page', 'Company & person', 'Find email', 'Formula']);
  for (const name of options) {
   await dialog.getByRole('radio', { name, exact: true }).click();
   const bounds = await dialog.boundingBox();
   expect(bounds).not.toBeNull();
   expect(bounds!.x).toBeGreaterThanOrEqual(0);
   expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
   if (name === 'Formula') continue; // The formula builder's actions scroll with its preview.
   const action = await dialog.getByRole('button', { name: /^Run on / }).boundingBox();
   expect(action!.y + action!.height).toBeLessThanOrEqual(740);
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
 }
 expect(errors).toEqual([]);
});

test('mobile landing, settings, filters and navigation stay usable', async ({ page }) => {
 await page.setViewportSize({ width: 320, height: 740 });
 for (const url of ['/', '/app/settings', '/app/sheets/ui-review']) {
  await page.goto(url);
  if (url.startsWith('/app')) await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
 }
 // Phones keep Search, Find rows and Run in the toolbar; everything else is under More actions.
 await page.getByRole('button', { name: 'More actions', exact: true }).click();
 await page.getByRole('menuitem', { name: 'Filter', exact: true }).click();
 await page.getByRole('button', { name: 'Add filter', exact: true }).click();
 await expect(page.getByRole('combobox', { name: 'Filter column' })).toBeVisible();
 const filter = await page.getByRole('button', { name: 'Remove filter' }).boundingBox();
 expect(filter!.x + filter!.width).toBeLessThanOrEqual(320);
 await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
 await expect(page.locator('main')).toHaveAttribute('inert', '');
 await page.keyboard.press('Escape');
 await expect(page.locator('main')).not.toHaveAttribute('inert');
 await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
 await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
 await page.setViewportSize({ width: 1360, height: 900 });
 await expect(page.locator('main')).not.toHaveAttribute('inert');
 await page.setViewportSize({ width: 320, height: 740 });
 await page.getByRole('button', { name: 'More actions', exact: true }).click();
 const columnMenu = page.getByRole('menuitem', { name: 'Add', exact: true });
 await columnMenu.focus();
 await page.keyboard.press('ArrowRight');
 const submenu = page.getByRole('menu', { name: 'Add', exact: true });
 await expect(submenu.getByRole('menuitem', { name: 'Back', exact: true })).toBeFocused();
 const submenuBounds = await submenu.boundingBox();
 expect(submenuBounds!.x).toBeGreaterThanOrEqual(0);
 expect(submenuBounds!.x + submenuBounds!.width).toBeLessThanOrEqual(320);
 await page.keyboard.press('ArrowLeft');
 await expect(columnMenu).toBeFocused();
 await page.keyboard.press('ArrowRight');
 await page.keyboard.press('Escape');
 await expect(submenu).toHaveCount(0);
 await expect(columnMenu).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('menu')).toHaveCount(0);
});

test('choice controls and entity field menus support keyboard selection', async ({ page }) => {
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Add company field column', exact: true }).first().click();
 const panel = page.getByRole('dialog', { name: 'Company fields', exact: true });
 const category = panel.getByRole('button').first();
 await expect(category).toBeFocused();
 await page.keyboard.press('ArrowRight');
 const fields = panel.getByRole('checkbox');
 await expect(fields.first()).toBeFocused();
 await page.keyboard.press('ArrowDown');
 await expect(fields.nth(1)).toBeFocused();
 await page.keyboard.press('Space');
 await expect(fields.nth(1)).toHaveAttribute('aria-checked', 'true');
 await page.keyboard.press('ArrowLeft');
 await expect(category).toBeFocused();
 await page.keyboard.press('Escape');
 await expect(panel).toHaveCount(0);
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
 await page.getByRole('button', { name: 'Configure manually', exact: true }).click();
 const ask = page.getByRole('radio', { name: 'AI answer', exact: true });
 await ask.focus();
 await page.keyboard.press('ArrowRight');
 const classify = page.getByRole('radio', { name: 'Classify', exact: true });
 await expect(classify).toBeFocused();
 await expect(classify).toHaveAttribute('aria-checked', 'true');
 await expect(page.getByRole('radio', { name: 'True / false', exact: true })).toHaveAttribute('aria-checked', 'true');
 await expect(ask).toHaveAttribute('tabindex', '-1');
 await page.keyboard.press('End');
 await expect(page.getByRole('radio', { name: 'Formula', exact: true })).toBeFocused();
 await page.keyboard.press('Home');
 await expect(ask).toBeFocused();
 await expect(ask).toHaveAttribute('aria-checked', 'true');
});

test('filters open below the toolbar without moving the grid and keep rules when dismissed', async ({ page }) => {
 await page.goto('/app/sheets/ui-review');
 const trigger = page.getByRole('button', { name: /^Filter(?: \d+)?$/ });
 const grid = page.getByRole('grid');
 await expect(grid).toBeVisible();
 const before = await grid.boundingBox();
 await trigger.click();
 const panel = page.getByRole('dialog', { name: 'Filters', exact: true });
 await expect(panel).toBeVisible();
 const anchor = await trigger.boundingBox();
 const bounds = await panel.boundingBox();
 expect(bounds!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height);
 expect(bounds!.width).toBeLessThanOrEqual(640);
 expect((await grid.boundingBox())!.y).toBe(before!.y);
 await panel.getByRole('button', { name: 'Add filter', exact: true }).click();
 await panel.getByLabel('Filter value', { exact: true }).fill('Sunrun');
 await expect(panel.getByRole('status')).toHaveText('1 of 2 rows shown');
 await page.screenshot({ animations: 'disabled', path: test.info().outputPath('filters-desktop.png') });
 // The first Escape closes the value suggestions, the second the panel; the rule is already applied.
 await page.keyboard.press('Escape');
 await page.keyboard.press('Escape');
 await expect(panel).toBeHidden();
 await expect(trigger).toBeFocused();
 await trigger.click();
 await expect(panel.getByLabel('Filter value', { exact: true })).toHaveValue('Sunrun');
 await page.setViewportSize({ width: 390, height: 740 });
 await expect.poll(async () => { const rect = await panel.boundingBox(); return rect!.x + rect!.width; }).toBeLessThanOrEqual(390);
 await page.screenshot({ animations: 'disabled', path: test.info().outputPath('filters-mobile.png') });
 await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
 await expect(panel.getByRole('status')).toHaveText('2 of 2 rows shown');
 await panel.getByRole('button', { name: 'Done', exact: true }).click();
 await expect(panel).toBeHidden();
 await page.getByRole('button', { name: 'More actions', exact: true }).click();
 await page.getByRole('menuitem', { name: 'Filter', exact: true }).click();
 await expect(panel).toBeVisible();
 await page.getByRole('searchbox', { name: 'Search rows' }).click();
 await expect(panel).toBeHidden();
});


test('filtering from a column opens the anchored filter panel', async ({ page }) => {
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Column menu for Company', exact: true }).click();
 await page.getByRole('menuitem', { name: 'Filter by this column', exact: true }).click();
 const panel = page.getByRole('dialog', { name: 'Filters', exact: true });
 await expect(panel).toBeVisible();
 await expect(panel.getByRole('combobox', { name: 'Filter column', exact: true })).toHaveText('Company');
 await panel.getByLabel('Filter value', { exact: true }).fill('Enphase');
 await expect(panel.getByRole('status')).toHaveText('1 of 2 rows shown');
});
