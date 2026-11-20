import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';

test('API-key onboarding, persistence, and browser isolation work without OAuth', async ({ page, browser, baseURL }) => {
 await page.goto('/login');
 await expect(page).toHaveURL(/\/app$/);
 await expect(page.getByRole('dialog', { name: 'Set up enrichment' })).toBeVisible();
 await expect(page.getByLabel('looot API key', { exact: true })).toBeVisible();
 await expect(page.getByLabel('OpenAI API key', { exact: true })).toBeVisible();
 await expect(page.getByRole('button', { name: 'Save and start', exact: true })).toBeDisabled();
 await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
 await page.getByRole('button', { name: 'Close', exact: true }).click();
 await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
 await page.getByLabel('Or paste CSV', { exact: true }).fill('Value,Other\n10,20');
 await page.getByLabel('Sheet name', { exact: true }).fill('Self-hosted test');
 await page.getByRole('button', { name: 'Import', exact: true }).click();
 await expect(page.getByRole('gridcell').first()).toHaveText('10');
 const sheetURL = page.url();
 await page.reload();
 await expect(page.getByRole('gridcell').first()).toHaveText('10');
 await expect(page.getByRole('dialog'), 'Setup opens once per browser').toHaveCount(0);
 // Exercise a real API operation without paid provider keys.
 const ownSession = await (await page.request.get('/api/auth/session')).json();
 const ownHeaders = { 'x-looot-tables-account': ownSession.partition, 'x-looot-tables-session': ownSession.sessionId, origin: baseURL! };
 const enriched = await page.request.post('/api/enrich', { headers: ownHeaders, data: { op: { kind: 'template', template: 'Value {{Value}}' }, row: { Value: '10' } } });
 expect(enriched.ok()).toBeTruthy();
 expect(await enriched.json()).toMatchObject({ value: 'Value 10' });
 // Verify the downloaded data, not just that an export button exists.
 for (const format of ['CSV', 'Excel (.xlsx)']) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: format, exact: true }).click();
  const downloaded = await downloadReady;
  const contents = await readFile((await downloaded.path())!);
  if (format === 'CSV') {
   expect(contents.toString('utf8')).toContain('Value,Other');
   expect(contents.toString('utf8')).toContain('10,20');
  } else {
   const files = unzipSync(contents);
   const xml = strFromU8(files['xl/worksheets/sheet1.xml']);
   expect(xml).toContain('>10<');
   expect(xml).toContain('>20<');
  }
 }
 const other = await browser.newContext({ baseURL });
 try {
  const otherPage = await other.newPage();
  await otherPage.goto('/app');
  await otherPage.getByRole('dialog').waitFor();
  await otherPage.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(otherPage.getByText('Self-hosted test', { exact: true })).toHaveCount(0);
  const session = await (await other.request.get('/api/auth/session')).json();
  const stolen = await other.request.get(new URL(sheetURL).pathname.replace('/app/sheets/', '/api/sheets/'), { headers: { 'x-looot-tables-account': session.partition, 'x-looot-tables-session': session.sessionId } });
  expect(stolen.status()).toBe(404);
 } finally { await other.close(); }
 // Remove only the sheet created by this browser's isolated test workspace.
 const session = await (await page.request.get('/api/auth/session')).json();
 const headers = { 'x-looot-tables-account': session.partition, 'x-looot-tables-session': session.sessionId, origin: baseURL! };
 const index = await (await page.request.get('/api/sheets', { headers })).json();
 for (const entry of index) expect((await page.request.delete(`/api/sheets/${entry.sheet.id}?revision=${entry.sheet.revision}`, { headers })).ok()).toBeTruthy();
});
