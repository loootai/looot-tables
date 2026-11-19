import { expect, test } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Row, Sheet } from '../../src/lib/types';

const timestamp = 1_800_000_000_000;
const initialSheet: Sheet = {
 id: 'ui-review', revision: 1, name: 'Solar companies with a deliberately long sheet name',
 columns: [
  { id: 'company', name: 'Company', type: 'source', width: 200, createdAt: timestamp },
  { id: 'domain', name: 'Result', type: 'source', format: 'text', width: 190, createdAt: timestamp },
  { id: 'fit', name: 'ICP fit', type: 'enriched', width: 220, createdAt: timestamp, op: { kind: 'check', question: 'Is {{Company}} a solar company?', decider: 'openai', threshold: 0.5 } },
 ], filters: [], sort: null, createdAt: timestamp, updatedAt: timestamp,
};

test.beforeEach(async ({ context, baseURL }) => {
 await context.addCookies([{ name: 'enrichable.session', value: memberCookie('browser-user'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 let sheet = structuredClone(initialSheet);
 let rows: Row[] = Array.from({ length: 12 }, (_, index) => index === 0 ? 'Sunrun' : index === 1 ? 'Enphase Energy' : `Company ${index + 1}`).map((name, index) => ({
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
 await context.route('**/api/context/usage*', (route) => route.fulfill({ json: { credits: 25000, used: 5000 } }));
});

test('opens AI from equals without saving the draft, generates and applies a formula', async ({ page }, testInfo) => {
 const errors: string[] = [];
 page.on('pageerror', (error) => errors.push(error.message));
 await page.route('**/api/formula-builder', async (route) => {
  const body = route.request().postDataJSON();
  expect(body.target).toBe('B1');
  expect(body.columns[0]).toEqual({ name: 'Company', address: 'A' });
  await route.fulfill({ json: { formula: '=UPPER(A1)', explanation: 'Converts the company name to uppercase.' } });
 });
 await page.goto('/app/sheets/ui-review');
 const cells = page.getByRole('gridcell');
 await cells.nth(1).click();
 await page.keyboard.type('=');
 const ai = page.getByRole('button', { name: 'Write formula with AI', exact: true });
 await expect(ai).toBeVisible();
 await page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true }).press('Alt+Enter');
 const dialog = page.getByRole('dialog', { name: 'Formula', exact: true });
 await expect(dialog).toBeVisible();
 await dialog.getByLabel('Describe the formula you want').fill('Uppercase the company name');
 await dialog.getByRole('button', { name: 'Write with AI', exact: true }).click();
 await expect(dialog.getByRole('status')).toHaveText('SUNRUN');
 await dialog.screenshot({ path: testInfo.outputPath('formula-builder.png') });
 await dialog.getByRole('button', { name: 'Apply formula', exact: true }).click();
 await expect(dialog).toHaveCount(0);
 await expect(cells.nth(1)).toHaveText('SUNRUN');
 await page.reload();
 await expect(cells.nth(1)).toHaveText('SUNRUN');
 expect(errors).toEqual([]);
});

test('cancels equals without overwriting the original cell and supports manual formulas', async ({ page }) => {
 await page.goto('/app/sheets/ui-review');
 const cells = page.getByRole('gridcell');
 await cells.nth(1).click();
 await page.keyboard.type('=');
 await page.getByRole('button', { name: 'Write formula with AI' }).click();
 await page.getByRole('button', { name: 'Cancel', exact: true }).click();
 await expect(cells.nth(1)).toContainText('sunrun.com');
 await cells.nth(1).dblclick();
 const inline = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
 await inline.fill('=1+2');
 await page.getByRole('button', { name: 'Write formula with AI' }).click();
 const dialog = page.getByRole('dialog', { name: 'Formula', exact: true });
 await expect(dialog.getByRole('textbox', { name: 'Formula to apply' })).toHaveText('=1+2');
 await expect(dialog.getByRole('status')).toHaveText('3');
 await dialog.getByRole('textbox', { name: 'Formula to apply' }).fill('=1/0');
 await expect(dialog.getByRole('status')).toContainText('#DIV/0!');
 await expect(dialog.getByRole('button', { name: 'Apply formula', exact: true })).toBeDisabled();
});

test('adds a formula column and fills relative references for every row', async ({ page }) => {
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await expect(page.getByRole('menuitem', { name: 'AI column', exact: true })).toBeVisible();
 await expect(page.getByRole('menuitem', { name: 'Find email', exact: true })).toBeVisible();
 await expect(page.getByRole('menuitem', { name: 'Text', exact: true })).toHaveCount(0);
 await page.getByRole('menuitem', { name: 'Formula', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Formula', exact: true });
 await dialog.getByLabel('Column name', { exact: true }).fill('Uppercase company');
 await dialog.getByRole('textbox', { name: 'Formula to apply' }).fill('=UPPER(A1)');
 const preview = dialog.getByRole('table', { name: 'Formula preview' });
 await expect(preview.getByRole('row')).toHaveCount(11);
 await expect(preview.getByRole('row').nth(1)).toHaveText('D1SUNRUN');
 await expect(preview.getByRole('row').nth(2)).toHaveText('D2ENPHASE ENERGY');
 await expect(preview.getByRole('row').nth(10)).toHaveText('D10COMPANY 10');
 await expect(preview).not.toContainText('COMPANY 11');
 await dialog.getByRole('button', { name: 'Add formula column', exact: true }).click();
 await expect(dialog).toHaveCount(0);
 await expect(page.getByRole('gridcell').nth(3)).toHaveText('SUNRUN');
 await expect(page.locator('[role="row"][aria-rowindex="2"]').getByRole('gridcell').nth(3)).toHaveText('ENPHASE ENERGY');
});

test('saves a formula column when only some preview rows error, and says how many', async ({ page }) => {
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'Formula', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Formula', exact: true });
 await dialog.getByLabel('Column name', { exact: true }).fill('Ratio');
 const formula = dialog.getByRole('textbox', { name: 'Formula to apply' });
 const add = dialog.getByRole('button', { name: 'Add formula column', exact: true });
 await formula.fill('=1/(ROW()-3)');
 await expect(dialog.locator('[data-preview-warning]')).toHaveText('1 of 10 preview rows return errors');
 await expect(add).toBeEnabled();
 await formula.fill('=1/0');
 await expect(dialog.locator('[data-preview-warning]')).toContainText('All 10 preview rows return errors');
 await expect(add).toBeDisabled();
 await formula.fill('=1/(ROW()-3)');
 await expect(add).toBeEnabled();
 await add.click();
 await expect(dialog).toHaveCount(0);
 await expect(page.locator('[role="row"][aria-rowindex="1"]').getByRole('gridcell').nth(3)).toHaveText('-0.5');
});

test('shows generation errors and keeps the description for retry on mobile', async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await page.route('**/api/formula-builder', (route) => route.fulfill({ status: 429, json: { error: 'Rate limited. Try again.' } }));
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('gridcell').nth(1).click();
 await page.keyboard.type('=');
 await page.getByRole('button', { name: 'Write formula with AI' }).click();
 const dialog = page.getByRole('dialog', { name: 'Formula', exact: true });
 await dialog.getByLabel('Describe the formula you want').fill('Get the first word');
 await dialog.getByRole('button', { name: 'Write with AI', exact: true }).click();
 await expect(dialog.getByRole('alert')).toHaveText('Rate limited. Try again.');
 await expect(dialog.getByLabel('Describe the formula you want')).toHaveText('Get the first word');
 await expect(dialog.getByRole('button', { name: 'Write with AI', exact: true })).toBeEnabled();
 await expect(dialog.getByRole('button', { name: 'Apply formula', exact: true })).toBeInViewport();
});


test('AI column composes a formula inline, previews ten rows, and saves a formula column', async ({ page }) => {
 await page.route('**/api/compose-column', (route) => route.fulfill({ json: { name: 'Uppercase company', op: { kind: 'formula', request: 'Uppercase Company' }, rationale: 'A formula can transform the existing data.' } }));
 await page.route('**/api/formula-builder', (route) => route.fulfill({ json: { formula: '=UPPER(A1)', explanation: 'Uppercase company names.' } }));
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
 await dialog.getByLabel('Describe the column', { exact: true }).fill('Uppercase Company');
 await dialog.getByRole('button', { name: 'Create column', exact: true }).click();
 await expect(page.getByRole('dialog')).toHaveCount(1);
 const preview = dialog.getByRole('table', { name: 'Formula preview' });
 await expect(preview.getByRole('row')).toHaveCount(11);
 await expect(preview.getByRole('row').nth(2)).toHaveText('D2ENPHASE ENERGY');
 await dialog.getByRole('button', { name: 'Add formula column', exact: true }).click();
 await expect(dialog).toHaveCount(0);
 await expect(page.getByRole('gridcell').nth(3)).toHaveText('SUNRUN');
 await page.reload();
 await expect(page.locator('[role="row"][aria-rowindex="2"]').getByRole('gridcell').nth(3)).toHaveText('ENPHASE ENERGY');
});

for (const failure of ['generation', 'preview']) {
 test(`AI formula ${failure} failure chooses another operation once`, async ({ page }) => {
  const requests: boolean[] = [];
  await page.route('**/api/compose-column', async (route) => {
   const body = route.request().postDataJSON();
   requests.push(body.excludeFormula);
   await route.fulfill({ json: body.excludeFormula ? { name: 'Uppercase company', op: { kind: 'ai', prompt: 'Uppercase {{Company}}', output: 'text', research: 'none' }, rationale: 'Use row data.' } : { name: 'Uppercase company', op: { kind: 'formula', request: 'Uppercase Company' } } });
  });
  await page.route('**/api/formula-builder', (route) => failure === 'generation' ? route.fulfill({ status: 502, json: { error: 'Could not generate' } }) : route.fulfill({ json: { formula: '=1/(ROW()-10)', explanation: 'Fails only on row ten.' } }));
  await page.goto('/app/sheets/ui-review');
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
  await dialog.getByLabel('Describe the column', { exact: true }).fill('Uppercase Company');
  await dialog.getByRole('button', { name: 'Create column', exact: true }).click();
  await expect(dialog.getByText(/The formula could not be generated or failed its preview/)).toBeVisible();
  await expect(dialog.getByLabel('Question', { exact: true })).toHaveText('Uppercase Company');
  expect(requests).toEqual([false, true]);
  await expect(dialog.getByRole('button', { name: 'Add without running', exact: true })).toBeEnabled();
 });
}

test('Formula is available in manual AI column setup', async ({ page }) => {
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
 await dialog.getByRole('button', { name: 'Configure manually', exact: true }).click();
 await dialog.getByRole('radio', { name: 'Formula', exact: true }).click();
 await expect(dialog.getByLabel('Describe the formula you want')).toBeVisible();
 await dialog.getByRole('textbox', { name: 'Formula to apply' }).fill('=UPPER(A1)');
 await expect(dialog.getByRole('table', { name: 'Formula preview' }).getByRole('row')).toHaveCount(11);
});


test('column mentions render as pills, autocomplete in formulas, and fill correctly', async ({ page }, testInfo) => {
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'Formula', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Formula', exact: true });
 const prompt = dialog.getByRole('textbox', { name: 'Describe the formula you want', exact: true });
 await prompt.fill('Uppercase ');
 await dialog.getByRole('button', { name: 'A Company', exact: true }).click();
 await expect(prompt.locator('.column-prompt-pill')).toHaveText('Company');
 const formula = dialog.getByRole('textbox', { name: 'Formula to apply' });
 const height = await formula.evaluate((node) => node.closest('[data-formula-editor]')!.getBoundingClientRect().height);
 expect(height).toBeLessThan(48);
 await formula.fill('=CONCAT(' + Array.from({ length: 25 }, () => '"long segment"').join(',') + ')');
 const wrapped = await formula.evaluate((node) => ({ width: node.scrollWidth, available: node.clientWidth, height: node.closest('[data-formula-editor]')!.getBoundingClientRect().height }));
 expect(wrapped.height).toBeGreaterThan(height);
 expect(wrapped.width).toBeLessThanOrEqual(wrapped.available + 1);
 await formula.fill('=UPPER(Comp');
 await expect(page.getByRole('option').filter({ hasText: 'Company' })).toBeVisible();
 await page.getByRole('option').filter({ hasText: 'Company' }).click();
 await formula.press('End');
 await page.keyboard.type(')');
 await expect(formula.locator('.column-prompt-pill')).toHaveText('Company');
 const preview = dialog.getByRole('table', { name: 'Formula preview' });
 await expect(preview.getByRole('row').nth(2)).toHaveText('D2ENPHASE ENERGY');
 const panel = dialog.getByRole('region', { name: 'Result preview' });
 expect(await panel.evaluate((node) => [...node.querySelectorAll('*')].every((child) => child.scrollHeight <= child.clientHeight + 1 || getComputedStyle(child).overflowY !== 'auto'))).toBe(true);
 await dialog.screenshot({ path: testInfo.outputPath('formula-named-columns.png') });
 await dialog.getByRole('button', { name: 'Add formula column', exact: true }).click();
 await expect(page.getByRole('gridcell').nth(3)).toHaveText('SUNRUN');
 await expect(page.locator('[role="row"][aria-rowindex="2"]').getByRole('gridcell').nth(3)).toHaveText('ENPHASE ENERGY');
 expect(await page.pageErrors()).toEqual([]);
});

test('a failed sample gets one formula repair before falling back', async ({ page }) => {
 const compositions: boolean[] = [];
 const builds: Array<Record<string, unknown>> = [];
 await page.route('**/api/compose-column', async (route) => {
  compositions.push(route.request().postDataJSON().excludeFormula);
  await route.fulfill({ json: { name: 'Ratio', op: { kind: 'formula', request: 'Calculate 1 divided by row number minus 10' } } });
 });
 await page.route('**/api/formula-builder', async (route) => {
  const body = route.request().postDataJSON();
  builds.push(body);
  if (builds.length === 2) {
   expect(body.formula).toBe('=1/(ROW()-10)');
   expect(body.feedback.samples).toEqual([{ address: 'D10', error: '#DIV/0!', inputs: { Company: 'Company 10', Result: 'enphase.com', 'ICP fit': 'true' } }]);
  }
  await route.fulfill({ json: builds.length === 1 ? { formula: '=1/(ROW()-10)', explanation: 'Ratio.' } : { formula: '=IFERROR(1/(ROW()-10),"")', explanation: 'Return blank for a zero denominator.' } });
 });
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
 await dialog.getByLabel('Describe the column', { exact: true }).fill('Calculate 1 divided by row number minus 10');
 await dialog.getByRole('button', { name: 'Create column', exact: true }).click();
 const apply = dialog.getByRole('button', { name: 'Add formula column', exact: true });
 await expect(apply).toBeEnabled();
 await expect(dialog.getByRole('radio', { name: 'Formula', exact: true })).toBeChecked();
 await expect(dialog.getByRole('table', { name: 'Formula preview' }).getByRole('row').nth(10)).toHaveText('D10(empty)');
 expect(builds).toHaveLength(2);
 expect(compositions).toEqual([false]);
 await apply.click();
 await expect(dialog).toHaveCount(0);
 await expect(page.locator('[role="row"][aria-rowindex="10"]').getByRole('gridcell').nth(3)).toHaveText('—');
});

test('a failed formula repair falls back once without further repair calls', async ({ page }) => {
 const compositions: boolean[] = [];
 let builds = 0;
 await page.route('**/api/compose-column', async (route) => {
  const body = route.request().postDataJSON();
  compositions.push(body.excludeFormula);
  await route.fulfill({ json: body.excludeFormula ? { name: 'Ratio', op: { kind: 'ai', prompt: 'Calculate a ratio', output: 'number', research: 'none' } } : { name: 'Ratio', op: { kind: 'formula', request: 'Calculate a ratio' } } });
 });
 await page.route('**/api/formula-builder', async (route) => {
  builds++;
  await route.fulfill({ json: { formula: builds === 1 ? '=1/(ROW()-10)' : '=2/(ROW()-10)', explanation: 'Ratio.' } });
 });
 await page.goto('/app/sheets/ui-review');
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
 await dialog.getByLabel('Describe the column', { exact: true }).fill('Calculate a ratio');
 await dialog.getByRole('button', { name: 'Create column', exact: true }).click();
 await expect(dialog.getByRole('radio', { name: 'Ask AI', exact: true })).toBeChecked();
 expect(builds).toBe(2);
 expect(compositions).toEqual([false, true]);
});
