import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Sheet, Row } from '../../src/lib/types';

test('chip extensions and column setup share remembered run scope and run only the selected rows', async ({ page, context, baseURL }) => {
 await context.addCookies([{ name: 'enrichable.session', value: memberCookie('run-scope'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 let sheet: Sheet = { id: 'run-scope', name: 'Scopes', columns: [{ id: 'site', name: 'Website', type: 'source', format: 'website', width: 220, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
 let rows: Row[] = Array.from({ length: 15 }, (_, i) => ({ id: `r${i}`, sheetId: sheet.id, order: i, createdAt: 1, cells: { site: { v: `company${i}.com`, s: 'done', t: 1 } } }));
 const requests: string[] = [];
 await page.route('**/api/looot/balance*', (route) => route.fulfill({ json: { available: 5, reserved: 0 } }));
 await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
 await page.route('**/api/compose-column', (route) => route.fulfill({ json: { name: 'Email draft', op: { kind: 'email-draft', mode: 'ai', prompt: 'Draft an introduction', to: '', cc: '', bcc: '', subject: '', body: '' } } }));
 await page.route('**/api/enrich', (route) => {
  requests.push(route.request().postDataJSON().row.Website);
  return route.fulfill({ json: { value: JSON.stringify({ to: '', cc: '', bcc: '', subject: 'Hello', body: 'Hi!' }) } });
 });
 await page.route('**/api/sheets**', async (route) => {
  const request = route.request();
  if (request.method() === 'PATCH') {
   const body = request.postDataJSON(); sheet = { ...body.sheet, revision: sheet.revision! + 1 };
   const updates = new Map<string, Row>(body.rows.map((row: Row) => [row.id, row])); rows = rows.map((row) => updates.get(row.id) ?? row);
   await route.fulfill({ json: { revision: sheet.revision, updatedAt: Date.now() } });
  } else if (new URL(request.url()).pathname === '/api/sheets') await route.fulfill({ json: [{ sheet, rowCount: rows.length }] });
  else await route.fulfill({ json: { sheet, rows, next: null } });
 });
 await page.goto(`/app/sheets/${sheet.id}`);
 const chips = page.getByRole('button', { name: 'Website actions', exact: true });
 await chips.first().click();
 await page.getByRole('button', { name: 'Choose which rows to run' }).click();
 await page.getByRole('menuitemradio', { name: 'Run on 10 rows', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Run on 10 rows, 0 fields selected', exact: true })).toBeVisible();
 await page.keyboard.press('Escape');
 await page.locator('[role="row"][aria-rowindex="3"]').getByRole('gridcell').first().click({ position: { x: 210, y: 15 } });
  await expect(page.locator('[role="row"][aria-rowindex="3"]').getByRole('gridcell').first()).toHaveAttribute('aria-selected', 'true');
 async function openEditor() {
  await page.locator('[role="row"][aria-rowindex="3"]').getByRole('gridcell').first().click({ position: { x: 210, y: 15 } });
  await expect(page.locator('[role="row"][aria-rowindex="3"]').getByRole('gridcell').first()).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
  await page.getByRole('textbox', { name: 'Describe the column' }).fill('Draft an email');
  await page.getByRole('button', { name: 'Create column', exact: true }).click();
 }
 await openEditor();
 const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
 // The editor names real rows: the active cell is on row 3.
 await expect(dialog.getByRole('button', { name: 'Run on 10 rows from row 3', exact: true })).toBeEnabled();
 await dialog.getByRole('button', { name: 'Choose which rows to run' }).click();
 await expect(page.getByRole('menuitemradio', { name: 'Run on all 15 rows', exact: true })).toBeVisible();
 await page.getByRole('menuitemradio', { name: 'Run on row 3', exact: true }).click();
 await dialog.getByRole('button', { name: 'Close', exact: true }).click();
 await chips.first().click();
 await expect(page.getByRole('button', { name: 'Run on this row, 0 fields selected', exact: true })).toBeVisible();
 await page.keyboard.press('Escape');
 await openEditor();
 await dialog.getByRole('button', { name: 'Choose which rows to run' }).click();
 await page.getByRole('menuitemradio', { name: 'Run on 10 rows from row 3', exact: true }).click();
 await dialog.getByRole('button', { name: 'Run on 10 rows from row 3', exact: true }).click();
 await expect.poll(() => requests.length).toBe(10);
 expect([...requests].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `company${i + 2}.com`).sort());
 await expect.poll(() => rows.filter((row) => Object.values(row.cells).some((cell) => typeof cell.v === 'string' && cell.v.includes('"subject":"Hello"'))).length).toBe(10);
 const draftCells = page.getByRole('gridcell').filter({ hasText: /^Hello$/ });
 await expect(draftCells.first().locator('img[src="/providers/email/gmail.svg"]')).toBeVisible();
 await page.reload();
 await chips.first().click();
 await expect(page.getByRole('button', { name: 'Run on 10 rows, 0 fields selected', exact: true })).toBeVisible();
 expect(await page.pageErrors()).toEqual([]);
});
