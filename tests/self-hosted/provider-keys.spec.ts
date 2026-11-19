import { expect, test, type Page } from '@playwright/test';

async function mockWorkspace(page: Page) {
 const sheet = { id: 'own-keys', name: 'Own keys', revision: 1, columns: [{ id: 'name', name: 'Name', type: 'source', width: 220, createdAt: 1 }, { id: 'domain', name: 'Company website', type: 'source', width: 220, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 };
 await page.route('**/api/sheets', route => route.fulfill({ json: [{ sheet, rowCount: 1 }] }));
 await page.route('**/api/sheets/own-keys*', route => route.fulfill({ json: { sheet, rows: [{ id: 'r1', sheetId: sheet.id, order: 0, createdAt: 1, cells: { name: { v: 'Example Person', s: 'done', t: 1 }, domain: { v: 'example.com', s: 'done', t: 1 } } }], next: null } }));
 // Even unexpected hosted metadata must not expose a funded offer in self-hosted mode.
 await page.route('**/api/keys/verify*', route => route.fulfill({ json: { openai: false, context: false, typesafe: false, passwordRequired: false, openaiTrial: { model: 'gpt-6-luna' }, enrichmentTrial: true } }));
}

test('self-hosted setup requires own keys, keeps optional providers in Configuration, and hides hosted balances', async ({ page }) => {
 await mockWorkspace(page);
 const usageRequests: string[] = [];
 page.on('request', request => { if (/\/api\/(openai|enrichment)\/usage/.test(request.url())) usageRequests.push(request.url()); });
 await page.goto('/app/settings');
 const dialog = page.getByRole('dialog', { name: 'Set up enrichment' });
 await expect(dialog).toBeVisible();
 await expect(dialog.getByLabel('Context.dev API key', { exact: true })).toHaveJSProperty('required', true);
 await expect(dialog.getByLabel('OpenAI API key', { exact: true })).toHaveJSProperty('required', true);
 await expect(dialog.getByRole('button', { name: 'Save and start', exact: true })).toBeDisabled();
 for (const name of ['QuickEnrich', 'Apollo', 'ContactOut', 'Hunter', 'Model']) await expect(dialog).not.toContainText(name);
 await expect(page.locator('body')).not.toContainText(/trial|allowance|included credit|\$1\.00/i);
 await dialog.getByRole('button', { name: 'Close', exact: true }).click();
 const connections = page.getByRole('region', { name: 'Connections' });
 for (const name of ['QuickEnrich', 'Apollo', 'ContactOut']) {
  await connections.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Connect', exact: true }).click();
  const connect = page.getByRole('dialog', { name: `Connect ${name}` });
  await connect.getByRole('button', { name: `About ${name} API key`, exact: true }).click();
  await expect(page.getByRole('tooltip')).toContainText('Checked on your first lookup; billed through your provider plan.');
  await page.keyboard.press('Tab');
  await connect.getByRole('button', { name: 'Close', exact: true }).click();
 }
 // Saved optional keys show as saved, not as optional.
 await connections.getByRole('listitem').filter({ hasText: 'Apollo' }).getByRole('button', { name: 'Connect', exact: true }).click();
 await page.getByRole('dialog', { name: 'Connect Apollo' }).getByLabel('Apollo API key', { exact: true }).fill('apollo-local-key');
 await page.getByRole('dialog', { name: 'Connect Apollo' }).getByRole('button', { name: 'Save', exact: true }).click();
 await expect(connections.getByRole('listitem').filter({ hasText: 'Apollo' })).toContainText('Saved');
 await page.reload();
 await expect(connections.getByRole('listitem').filter({ hasText: 'Apollo' })).toContainText('Saved');
 await expect(page.getByRole('dialog'), 'Setup opens once per browser').toHaveCount(0);
 await expect(page.locator('body')).not.toContainText(/trial|allowance|included credit|\$1\.00/i);
 expect(usageRequests).toEqual([]);
});

test('self-hosted email waterfall explains own-provider billing without hosted prices', async ({ page }) => {
 await mockWorkspace(page);
 await page.goto('/app/sheets/own-keys');
 await page.getByRole('dialog', { name: 'Set up enrichment' }).getByRole('button', { name: 'Close', exact: true }).click();
 await expect(page.getByRole('gridcell').first()).toContainText('Example Person');
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'Find email', exact: true }).click();
 await page.getByRole('button', { name: 'About Find email providers', exact: true }).click();
 const tooltip = page.getByRole('tooltip');
 await expect(tooltip).toContainText('Connect provider keys in Configuration → Connections.');
 await expect(tooltip).toContainText('Lookups use your provider plan and quotas');
 await expect(page.locator('body')).not.toContainText(/trial|allowance|included credit|\$0\.\d/i);
});
