import { expect } from '@playwright/test';
import { test } from './authenticated-test';

test('saves the Logo Link key and fits company and school logos inside unchanged chips', async ({ page }) => {
	await page.addInitScript(() => { if (!localStorage.getItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396')) localStorage.setItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', contextKey: 'test-context' })); });
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: route.request().method() === 'POST' ? { openai: { ok: true, inference: true }, context: { ok: true }, typesafe: { configured: false, ok: false } } : { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	const lookedUp: string[] = [];
	await page.route('**/api/logos/resolve', async (route) => {
		const { name } = route.request().postDataJSON();
		lookedUp.push(name);
		await route.fulfill({ json: { domain: name === 'Stanford University' ? 'stanford.edu' : null } });
	});
	await page.route('https://logos.context.dev/**', (route) => {
		const url = new URL(route.request().url());
		expect(url.searchParams.get('publicClientId')).toBe('brandLL_test');
		return url.searchParams.get('domain') === 'stripe.com'
			? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="purple"/></svg>' })
			: route.abort();
	});
	await page.goto('/app');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Organization logos');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Company domain,Schools,Skills\nStripe,stripe.com,Stanford University,Design');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	const chips = page.locator('[data-organization-chip]');
	await expect(chips).toHaveCount(2);
	const original = await chips.evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
	await expect(page.locator('[data-organization-chip] img')).toHaveCount(0);
	await page.goto('/app/settings');
	await page.getByRole('button', { name: 'Context.dev actions', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Logo Link key', exact: true }).click();
	await page.getByLabel('Logo Link key (optional override)', { exact: true }).fill('brandLL_test');
	await page.getByRole('dialog', { name: 'Logo Link key' }).getByRole('button', { name: 'Save', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(await page.evaluate(() => JSON.parse(localStorage.getItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396')!).logolinkKey)).toBe('brandLL_test');
	await page.goBack();
	await expect(chips).toHaveCount(2);
	const companyImage = page.locator('[data-organization-chip="company"] img');
	await expect(companyImage).toBeVisible();
	await expect.poll(() => companyImage.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
	await expect.poll(() => lookedUp).toContain('Stanford University');
	await expect(page.locator('[data-organization-chip="school"] img')).toHaveCount(0);
	await expect(page.locator('[data-organization-chip="school"] svg')).toBeVisible();
	const final = await chips.evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
	expect(final).toEqual(original);
	await expect(companyImage).toHaveCSS('border-radius', '4px');
	await expect(companyImage).toHaveCSS('width', '16px');
	expect(await page.pageErrors()).toEqual([]);
});

test('rejects invalid organization lookups before contacting Context.dev', async ({ request }) => {
	for (const data of [{ name: '' }, { name: 'x'.repeat(301) }, { name: 42 }, null]) {
		const response = await request.post('/api/logos/resolve', { headers: { 'x-context-key': 'test-context' }, data });
		expect(response.status()).toBe(400);
	}
});
