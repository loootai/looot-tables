import { expect, type Page } from '@playwright/test';
import { test } from './authenticated-test';

async function companySheet(page: Page, enriched = false) {
	await page.addInitScript(() => {
		if (!localStorage.getItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396')) localStorage.setItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', loootKey: 'test-looot', logolinkKey: 'brandLL_test' }));
	});
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/logos/resolve', (route) => route.fulfill({ json: { domain: null } }));
	await page.route('https://logos.context.dev/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" fill="purple"/></svg>' }));
	await page.goto('/app');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Company editing');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Company domain,Notes\nExample,example.com,Test');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
	if (enriched) {
		await page.evaluate(async () => {
   const session = await fetch('/api/auth/session').then((response) => response.json());
   const headers = { 'content-type': 'application/json', 'x-enrichable-account': session.partition, 'x-enrichable-session': session.sessionId };
   const entries = await fetch('/api/sheets', { headers }).then((response) => response.json());
   const sheet = entries[0].sheet;
   sheet.columns[0] = { ...sheet.columns[0], name: 'Legal name', type: 'enriched', op: { kind: 'company', domain: '{{Company domain}}', field: 'title' } };
   const response = await fetch(`/api/sheets/${sheet.id}`, { method: 'PATCH', headers, body: JSON.stringify({ revision: sheet.revision, sheet, rows: [], deleted: [] }) });
   if (!response.ok) throw new Error('Could not configure the test company column.');
  });
		await page.reload();
		await page.getByRole('gridcell').first().waitFor();
	}
}

test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });

test('waits for three characters and 400ms of idle typing, previews logos, and persists the selected domain', async ({ page }) => {
	const queries: string[] = [];
	await page.route('**/api/companies/search', (route) => {
		queries.push(route.request().postDataJSON().query);
		return route.fulfill({ json: { companies: [{ name: 'Stripe', domain: 'stripe.com' }] } });
	});
	await companySheet(page);
	await page.getByRole('gridcell').first().dblclick({ position: { x: 160, y: 16 } });
	const input = page.getByRole('combobox', { name: 'Company', exact: true });
	await page.clock.install();
	await page.clock.pauseAt(new Date(Date.now() + 1000));
	await page.clock.fastForward(1000);
	expect(queries).toEqual([]); // Opening an existing company does not search automatically.
	await input.fill('  St  ');
	await page.clock.fastForward(1000);
	expect(queries).toEqual([]);
	await input.fill('Str');
	await page.clock.fastForward(399);
	expect(queries).toEqual([]);
	await input.fill('Strip');
	await page.clock.fastForward(399);
	expect(queries).toEqual([]);
	await page.clock.fastForward(1);
	const option = page.getByRole('option', { name: 'Stripe stripe.com', exact: true });
	await expect(option).toBeVisible();
	expect(queries).toEqual(['Strip']);
	await expect(option.locator('img')).toHaveAttribute('src', /publicClientId=brandLL_test&domain=stripe.com/);
	await expect(option.locator('img')).toHaveCSS('border-radius', '6px');
	await input.press('ArrowDown');
	await input.press('Enter');
	await expect(input).toHaveCount(0);
	await expect(page.getByRole('gridcell').first()).toHaveAccessibleName('Stripe');
	await page.clock.resume();
	await expect.poll(() => page.evaluate(async () => {
  const session = await fetch('/api/auth/session').then((response) => response.json());
  const headers = { 'x-enrichable-account': session.partition, 'x-enrichable-session': session.sessionId };
  const entries = await fetch('/api/sheets', { headers }).then((response) => response.json());
  const data = await fetch(`/api/sheets/${entries[0].sheet.id}`, { headers }).then((response) => response.json());
  return Object.values(data.rows[0].cells).some((cell) => (cell as { v?: unknown }).v === 'Stripe');
 })).toBe(true);
	await page.reload();
	const chip = page.locator('[data-organization-chip="company"]');
	await expect(chip).toContainText('Stripe');
	await expect(chip.locator('img')).toHaveAttribute('src', /domain=stripe.com/);
	await expect(page.getByRole('gridcell').nth(1)).toHaveText('example.com');
});

test('edits Company data name fields inline and in the detail panel, including mouse selection', async ({ page }) => {
	await page.route('**/api/companies/search', (route) => route.fulfill({ json: { companies: [{ name: 'Microsoft', domain: 'microsoft.com' }] } }));
	await companySheet(page, true);
	const cell = page.getByRole('gridcell').first();
	await cell.dblclick({ position: { x: 160, y: 16 } });
	const input = page.getByRole('combobox', { name: 'Company', exact: true });
	await input.fill('Mic');
	await page.getByRole('option', { name: 'Microsoft microsoft.com' }).click();
	await expect(input).toHaveCount(0);
	await expect(cell).toHaveAccessibleName('Microsoft');
	await cell.locator('[data-organization-chip]').click();
	const panel = page.locator('aside').filter({ hasText: 'Re-run cell' });
	await panel.getByRole('button', { name: 'Edit', exact: true }).click();
	await input.fill('Micro');
	await page.getByRole('option', { name: 'Microsoft microsoft.com' }).click();
	await expect(input).toHaveValue('Microsoft');
	await panel.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(input).toHaveCount(0);
	await expect(cell.locator('img')).toHaveAttribute('src', /domain=microsoft.com/);
});

test('cancels obsolete lookups, hides stale results, and permits manual values after empty or failed searches', async ({ page }) => {
	const queries: string[] = [];
	let releaseOld: () => void = () => {};
	await page.route('**/api/companies/search', async (route) => {
		const { query } = route.request().postDataJSON();
		queries.push(query);
		if (query === 'Str') {
			await new Promise<void>((resolve) => { releaseOld = resolve; });
			await route.fulfill({ json: { companies: [{ name: 'Stripe', domain: 'stripe.com' }] } }).catch(() => {});
		} else if (query === 'Mic') {
			await route.fulfill({ json: { companies: [{ name: 'Microsoft', domain: 'microsoft.com' }] } });
		} else if (query === 'Unknown') {
			await route.fulfill({ json: { companies: [] } });
		} else {
			await route.fulfill({ status: 429, json: { error: 'Too many searches. Wait a moment and try again.' } });
		}
	});
	await companySheet(page);
	await page.getByRole('gridcell').first().dblclick({ position: { x: 160, y: 16 } });
	const input = page.getByRole('combobox', { name: 'Company', exact: true });
	await page.clock.install();
	await page.clock.pauseAt(new Date(Date.now() + 1000));
	await input.fill('Str');
	await page.clock.fastForward(400);
	await expect.poll(() => queries).toEqual(['Str']);
	await input.fill('Mic');
	await page.clock.fastForward(400);
	await expect(page.getByRole('option', { name: 'Microsoft microsoft.com' })).toBeVisible();
	releaseOld();
	await expect(page.getByRole('option', { name: 'Stripe stripe.com' })).toHaveCount(0);
	await input.fill('Mi');
	await expect(page.getByRole('option')).toHaveCount(0);
	await page.clock.fastForward(1000);
	expect(queries).toEqual(['Str', 'Mic']);
	await input.fill('Unknown');
	await page.clock.fastForward(400);
	await expect(page.getByRole('status').filter({ hasText: 'No companies found' })).toBeVisible();
	await input.fill('Custom company');
	await page.clock.fastForward(400);
	await expect(page.getByRole('status').filter({ hasText: 'Too many searches' })).toBeVisible();
	await input.press('Enter');
	await expect(page.getByRole('gridcell').first()).toHaveAccessibleName('Custom company');
});

test('validates the minimum search length on the server', async ({ page, baseURL }) => {
 const session = await page.request.get('/api/auth/session').then((response) => response.json());
	for (const query of ['', 'ab', '  ab  ', 'x'.repeat(201), 123]) {
		const response = await page.request.post('/api/companies/search', { headers: { 'x-looot-key': 'test-looot', 'x-enrichable-account': session.partition, 'x-enrichable-session': session.sessionId, origin: baseURL! }, data: { query } });
		expect(response.status()).toBe(400);
	}
});


test('company chips open details on click while cell space keeps double-click editing', async ({ page }) => {
	await companySheet(page);
	const cell = page.getByRole('gridcell').first();
	const chip = cell.locator('[data-organization-chip]');
	const panel = page.getByRole('complementary', { name: 'Cell details' });
	const input = page.getByRole('combobox', { name: 'Company', exact: true });
	await cell.click({ position: { x: 160, y: 16 } });
	await expect(input).toHaveCount(0);
	await expect(panel).toHaveCount(0);
	await chip.click();
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Example');
	await expect(input).toHaveCount(0);
	await panel.getByRole('button', { name: 'Close', exact: true }).click();
	await cell.dblclick({ position: { x: 160, y: 16 } });
	await expect(input).toBeFocused();
	await input.fill('Changed company');
	await input.press('Escape');
	await input.press('Escape');
	await expect(chip).toContainText('Example');
	await expect(panel).toHaveCount(0);
});
