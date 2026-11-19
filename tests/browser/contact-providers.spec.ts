import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';

test('Hunter and Prospeo keys are checked, saved, and listed in Configuration → Connections', async ({ page, context, baseURL }) => {
 await context.addCookies([{ name: 'enrichable.session', value: memberCookie('browser-user'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 await page.route('**/api/organization-settings', route => route.fulfill({ json: { local: true } }));
 await page.route('**/api/sheets', route => route.fulfill({ json: [] }));
 await page.route('**/api/context/usage*', route => route.fulfill({ json: { credits: 1000, used: 0 } }));
 await page.route('**/api/openai/usage*', route => route.fulfill({ json: { enabled: false } }));
 const received: Array<Record<string, string>> = [];
 await page.route('**/api/keys/verify*', async route => {
  if (route.request().method() === 'GET') return route.fulfill({ json: { openai: true, context: true, typesafe: false, hunter: false, prospeo: false, passwordRequired: false } });
  const headers = route.request().headers(); received.push(headers);
  const hunter = headers['x-hunter-key'], prospeo = headers['x-prospeo-key'];
  await route.fulfill({ json: { openai: { ok: true, inference: true }, context: { ok: true }, typesafe: { configured: false, ok: false }, hunter: { configured: Boolean(hunter), ok: hunter === 'hunter-valid', message: hunter === 'hunter-valid' ? undefined : 'Hunter rejected this API key.' }, prospeo: { configured: Boolean(prospeo), ok: prospeo === 'prospeo-valid' } } });
 });
 await page.goto('/app/settings');
 const connections = page.getByRole('region', { name: 'Connections' });
 const row = (name: string) => connections.getByRole('listitem').filter({ hasText: name });
 await row('Hunter').getByRole('button', { name: 'Connect', exact: true }).click();
 let dialog = page.getByRole('dialog', { name: 'Connect Hunter', exact: true });
 await dialog.getByLabel('Hunter API key', { exact: true }).fill('hunter-invalid');
 await expect(dialog.getByText('Hunter rejected this API key.', { exact: true })).toBeVisible();
 await expect(dialog.getByRole('button', { name: 'Save', exact: true }), 'A failed check never blocks saving').toBeEnabled();
 await dialog.getByLabel('Hunter API key', { exact: true }).fill('hunter-valid');
 await expect(dialog.getByText('Hunter rejected this API key.', { exact: true })).toHaveCount(0);
 await expect(dialog.getByText('Connected', { exact: true })).toBeVisible();
 await dialog.getByRole('button', { name: 'Save', exact: true }).click();
 await expect(dialog).toHaveCount(0);
 await row('Prospeo').getByRole('button', { name: 'Connect', exact: true }).click();
 dialog = page.getByRole('dialog', { name: 'Connect Prospeo', exact: true });
 await dialog.getByLabel('Prospeo API key', { exact: true }).fill('prospeo-valid');
 await dialog.getByRole('button', { name: 'Save', exact: true }).click();
 await expect(dialog).toHaveCount(0);
 expect(received.some(headers => headers['x-hunter-key'] === 'hunter-valid')).toBeTruthy();
 await page.reload();
 await expect(row('Hunter')).toContainText('hunter-•');
 await expect(row('Hunter')).toContainText('Connected');
 await expect(row('Prospeo')).toContainText('Connected');
 await page.screenshot({ path: '/tmp/enrichable-contact-providers.png', fullPage: true });
 expect(await page.pageErrors()).toEqual([]);
});

test('provider columns save their configuration, send row inputs, and display returned values', async ({ page, context, baseURL }) => {
 await context.addCookies([{ name: 'enrichable.session', value: memberCookie('browser-user'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 const { sheetSchema, rowSchema } = await import('../../src/lib/workspace');
 let sheet = sheetSchema.parse({ id: 'provider-sheet', name: 'Provider lookups', revision: 1, columns: [{ id: 'name', name: 'Name', type: 'source', width: 180, createdAt: 1 }, { id: 'domain', name: 'Website', type: 'source', width: 180, createdAt: 1 }, { id: 'email', name: 'Email', type: 'source', width: 180, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 }) as import('../../src/lib/types').Sheet;
 let rows = [rowSchema.parse({ id: 'row', sheetId: sheet.id, order: 0, createdAt: 1, cells: { name: { v: 'Ada Lovelace', s: 'done', t: 1 }, domain: { v: 'example.com', s: 'done', t: 1 }, email: { v: 'ada@example.com', s: 'done', t: 1 } } })];
 await page.route('**/api/sheets', route => route.fulfill({ json: [{ sheet, rowCount: 1 }] }));
 await page.route('**/api/sheets/provider-sheet*', async route => {
  if (route.request().method() === 'PATCH') {
   const body = route.request().postDataJSON();
   sheet = { ...body.sheet, revision: (sheet.revision ?? 1) + 1 };
   if (body.rows.length) rows = body.rows;
   return route.fulfill({ json: { revision: sheet.revision, updatedAt: Date.now() } });
  }
  return route.fulfill({ json: { sheet, rows, next: null } });
 });
 await page.route('**/api/context/usage*', route => route.fulfill({ json: { credits: 1000, used: 0 } }));
 await page.route('**/api/openai/usage*', route => route.fulfill({ json: { enabled: false } }));
 await page.route('**/api/keys/verify*', route => route.fulfill({ json: { openai: true, context: true, typesafe: false, hunter: true, prospeo: true, passwordRequired: false } }));
 const requests: Array<{ op: { kind: string; field?: string }; row: Record<string, string> }> = [];
 await page.route('**/api/enrich', route => {
  const body = route.request().postDataJSON(); requests.push(body);
  return route.fulfill({ json: { value: body.op.kind === 'hunter' ? 'deliverable' : '+14155550123', meta: { provider: body.op.kind } } });
 });
 await page.goto('/app/sheets/provider-sheet');
 await expect(page.getByRole('gridcell').first()).toBeVisible();
 // Hunter and Prospeo live under Find email, next to the provider waterfall.
 for (const [choice, title, value] of [['Verify email', 'Email status', 'deliverable'], ['Mobile & profile', 'Mobile', '+14155550123']]) {
  await page.getByRole('button', { name: 'Add column', exact: true }).click();
  await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
  await dialog.getByRole('button', { name: 'Configure manually', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Find email', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: 'Work email', exact: true })).toBeChecked();
  await dialog.getByRole('radio', { name: choice, exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Configuration → Connections', exact: true })).toHaveAttribute('href', '/app/settings');
  if (choice === 'Verify email') await expect(dialog.getByRole('textbox', { name: 'Email to verify', exact: true }).locator('.column-prompt-pill')).toHaveText('Email');
  else {
   await dialog.getByLabel('Full name', { exact: true }).fill('{{Name}}');
   await dialog.getByLabel('Company domain', { exact: true }).fill('{{Website}}');
   await expect(dialog.getByRole('combobox', { name: 'Look up', exact: true })).toContainText('Mobile number');
   await expect(dialog).toContainText('Mobile lookup can cost');
   await dialog.getByRole('switch', { name: 'Only verified email' }).click();
  }
  await expect(dialog.getByLabel('Column name', { exact: true })).toHaveValue(title);
  await dialog.getByRole('button', { name: 'Run on row 1', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('gridcell').filter({ hasText: value })).toBeVisible();
 }
 expect(requests.map(request => request.op.kind)).toEqual(['hunter', 'prospeo']);
 expect(requests[1].op.field).toBe('mobile');
 expect(requests[0].op).toMatchObject({ action: 'verify', email: '{{Email}}' });
 expect(requests[1].row.Name).toBe('Ada Lovelace');
 expect(sheet.columns.filter(column => column.op).map(column => column.op?.kind)).toEqual(['hunter', 'prospeo']);
 expect(await page.pageErrors()).toEqual([]);
});
