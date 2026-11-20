import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Sheet, Row } from '../../src/lib/types';

test('completed nulls appear in the formula bar, stay null on blur, and differ from unrun cells', async ({ page, context, baseURL }) => {
 await context.addCookies([{ name: 'looot-tables-session', value: memberCookie('null-test'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 let sheet: Sheet = { id: 'null-test', name: 'Null results', columns: [{ id: 'result', name: 'Result', type: 'source', format: 'text', width: 240, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1, revision: 1 };
 let rows: Row[] = [0, 1].map((i) => ({ id: `r${i}`, sheetId: sheet.id, order: i, createdAt: 1, cells: { result: { v: null, s: i === 0 ? 'done' : 'idle', t: 1 } } }));
 await page.route('**/api/looot/balance*', (route) => route.fulfill({ json: { available: 5, reserved: 0 } }));
 await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: false, looot: false, typesafe: false, passwordRequired: false } }));
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
 await page.getByRole('dialog').waitFor();
 await page.getByRole('button', { name: 'Close', exact: true }).click();
 const cells = page.getByRole('gridcell');
 const bar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
 await cells.first().click();
 await expect(cells.first()).toHaveText('—');
 await expect(bar).toHaveText('null');
 await bar.focus();
 await cells.nth(1).click();
 await expect(bar.locator('.cm-placeholder')).toBeVisible();
 expect(rows[0].cells.result.v).toBe(null);
 await bar.fill('null');
 await bar.press('Enter');
 await expect(cells.nth(1)).toHaveText('—');
 await expect.poll(() => rows[1].cells.result.s).toBe('done');
 expect(rows[1].cells.result.v).toBe(null);
 expect(await page.pageErrors()).toEqual([]);
});
