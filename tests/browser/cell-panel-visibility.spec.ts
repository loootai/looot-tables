import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Sheet, Row } from '../../src/lib/types';

for (const columnIndex of [0, 2]) {
 test(`opening cell details keeps column ${columnIndex + 1} visible`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'enrichable.session', value: memberCookie('panel-visibility'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
  const columns: Sheet['columns'] = Array.from({ length: 3 }, (_, index) => ({ id: `draft-${index}`, name: `Email ${index + 1}`, type: 'source', format: 'email-draft', width: 300, createdAt: 1 }));
  const sheet: Sheet = { id: 'panel-visibility', name: 'Panel visibility', columns, filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
  const rows: Row[] = [{ id: 'r', sheetId: sheet.id, order: 0, createdAt: 1, cells: Object.fromEntries(columns.map((column) => [column.id, { v: JSON.stringify({ subject: 'Hello', body: 'Hi Alice' }), s: 'done', t: 1 }])) }];
  await page.route('**/api/context/usage*', (route) => route.fulfill({ json: { credits: 25000, used: 0 } }));
  await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: false, context: false, typesafe: false, passwordRequired: false } }));
  await page.route('**/api/sheets**', (route) => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/sheets' ? [{ sheet, rowCount: 1 }] : { sheet, rows, next: null } }));
  await page.goto(`/app/sheets/${sheet.id}`);
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const grid = page.getByRole('grid');
  const cell = page.getByRole('gridcell').nth(columnIndex);
  // Select first: the panel must reveal the column even when selection is unchanged.
  await cell.click();
  const before = await grid.evaluate((element) => element.scrollLeft);
  await cell.dblclick();
  const panel = page.getByRole('complementary', { name: 'Cell details' });
  await expect(panel).toBeVisible();
  const expectVisibleColumn = async () => {
   await expect.poll(async () => {
    const [cellBox, gridBox, panelBox] = await Promise.all([cell.boundingBox(), grid.boundingBox(), panel.boundingBox()]);
    if (!cellBox || !gridBox || !panelBox) return false;
    return cellBox.x >= gridBox.x + 48 - 1 && cellBox.x + cellBox.width <= Math.min(gridBox.x + gridBox.width, panelBox.x) + 1;
   }).toBe(true);
  };
  await expectVisibleColumn();
  if (columnIndex === 0) expect(await grid.evaluate((element) => element.scrollLeft)).toBe(before);
  else expect(await grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(before);
  await page.setViewportSize({ width: 1100, height: 900 });
  await expectVisibleColumn();
  const after = await grid.evaluate((element) => element.scrollLeft);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const closed = await grid.evaluate((element) => ({ left: element.scrollLeft, max: element.scrollWidth - element.clientWidth }));
  expect(closed.left).toBe(Math.min(after, closed.max));
  expect(await page.pageErrors()).toEqual([]);
 });
}
