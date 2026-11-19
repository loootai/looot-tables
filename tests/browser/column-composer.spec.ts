import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { ColumnOp, Row, Sheet } from '../../src/lib/types';

for (const width of [1360, 390]) {
 test(`column composer creates a document with references at ${width}px`, async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width, height: 900 });
  await context.addCookies([{ name: 'enrichable.session', value: memberCookie(`composer-${width}`), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
  let sheet: Sheet = { id: 'composer', name: 'Customer research', revision: 1, columns: [{ id: 'company', name: 'Company', type: 'source', width: 220, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
  const rows: Row[] = Array.from({ length: 15 }, (_, order) => ({ id: `company-${order}`, sheetId: sheet.id, order, createdAt: 1, cells: { company: { v: order ? `Company ${order + 1}` : 'Acme', s: 'done' as const, t: 1 } } }));
  await page.route('**/api/organization-settings', route => route.fulfill({ json: { local: true } }));
  await page.route('**/api/looot/balance*', route => route.fulfill({ json: { available: 5, reserved: 0 } }));
  await page.route('**/api/openai/usage*', route => route.fulfill({ json: { enabled: false } }));
  await page.route('**/api/keys/verify*', route => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
  await page.route('**/api/enrich', route => { throw new Error(`Unexpected enrichment: ${route.request().url()}`); });
  await page.route('**/api/sheets**', async route => {
   if (route.request().method() === 'PATCH') {
    sheet = { ...route.request().postDataJSON().sheet, revision: sheet.revision! + 1 };
    return route.fulfill({ json: { revision: sheet.revision, updatedAt: Date.now() } });
   }
   await route.fulfill({ json: new URL(route.request().url()).pathname === '/api/sheets' ? [{ sheet, rowCount: rows.length }] : { sheet, rows, next: null } });
  });
  let composed = '';
  let attempts = 0;
  await page.route('**/api/compose-column', async route => {
   composed = route.request().postDataJSON().ask;
   if (++attempts === 1) return route.fulfill({ status: 502, json: { error: 'Could not compose. Please retry.' } });
   const op: ColumnOp = { kind: 'ai', prompt: composed, output: 'document', research: 'web' };
   await route.fulfill({ json: { name: 'Proposal', op, rationale: 'Write a proposal using the company research in each row.' } });
  });
  await page.goto('/app/sheets/composer');
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
  const prompt = dialog.getByRole('textbox', { name: 'Describe the column', exact: true });
  const compose = dialog.getByRole('button', { name: 'Create column', exact: true });
  await expect(compose).toBeDisabled();
  await prompt.fill('Write a personalized proposal for /company');
  await page.getByRole('option').filter({ hasText: 'Company' }).click();
  await expect(prompt.locator('.column-prompt-pill')).toHaveText('Company');
  await expect(prompt).toBeFocused();
  // Nothing runs from the prompt: run scope appears only once an operation exists.
  await expect(dialog.getByRole('button', { name: 'Choose which rows to run' })).toHaveCount(0);
  const buttonBounds = (await compose.boundingBox())!;
  const cardBounds = (await dialog.locator('.populate-front').boundingBox())!;
  expect(buttonBounds.x).toBeGreaterThan(cardBounds.x);
  expect(buttonBounds.x + buttonBounds.width).toBeLessThan(cardBounds.x + cardBounds.width);
  expect(buttonBounds.y + buttonBounds.height).toBeLessThan(cardBounds.y + cardBounds.height);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/enrichable-column-composer-${width}.png` });
  await compose.click();
  await expect(dialog.getByRole('alert')).toContainText('Could not compose. Please retry.');
  await expect(prompt.locator('.column-prompt-pill')).toHaveText('Company');
  await expect(compose).toBeEnabled();
  await prompt.press('Enter');
  const run = dialog.getByRole('button', { name: 'Run on row 1', exact: true });
  await expect(run).toBeEnabled();
  await dialog.getByRole('button', { name: 'Choose which rows to run' }).click();
  await page.getByRole('menuitemradio', { name: 'Run on 10 rows', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Run on 10 rows', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('radio', { name: 'AI answer', exact: true })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: 'Ask AI', exact: true })).toBeChecked();
  expect(composed).toBe('Write a personalized proposal for {{Company}}');
  await expect(dialog.getByRole('textbox', { name: 'Question', exact: true }).locator('.column-prompt-pill')).toHaveText('Company');
  await expect(dialog.getByRole('combobox', { name: 'Answer type', exact: true })).toContainText('Document');
  await dialog.getByLabel('Column name', { exact: true }).fill('Company');
  await expect(dialog.getByText('Another column already has this name', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add without running', exact: true })).toBeDisabled();
  await dialog.getByLabel('Column name', { exact: true }).fill('Proposal');
  await dialog.getByRole('button', { name: 'Add without running', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Column menu for Proposal', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Create column', exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Describe the column' }).fill('Draft a summary of {{Company}}');
  await dialog.getByRole('button', { name: 'Configure manually', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Question', exact: true }).locator('.column-prompt-pill')).toHaveText('Company');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await page.pageErrors()).toEqual([]);
 });
}
