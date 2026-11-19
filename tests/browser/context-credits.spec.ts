import { expect } from '@playwright/test';
import { test } from './authenticated-test';

test('shows credits in the sidebar, refreshes after company searches, and marks stale balances', async ({ page }) => {
	let credits = 800;
	let unavailable = false;
	await page.addInitScript(() => localStorage.setItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', contextKey: 'test-context' })));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/context/usage', (route) => unavailable ? route.fulfill({ status: 502, json: { error: 'Unavailable' } }) : route.fulfill({ json: { credits, used: 1000 - credits } }));
	await page.route('**/api/companies/search', (route) => {
		credits = 799;
		return route.fulfill({ json: { companies: [{ name: 'Stripe', domain: 'stripe.com' }] } });
	});
	await page.goto('/app');
	await expect(page.getByText('800 credits left', { exact: true })).toBeVisible();
	await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Credits check');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Company domain\nExample,example.com');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().dblclick({ position: { x: 160, y: 16 } });
	await page.getByRole('combobox', { name: 'Company', exact: true }).fill('Stripe');
	await expect(page.getByRole('option', { name: 'Stripe stripe.com', exact: true })).toBeVisible();
	await expect(page.getByText('799 credits left', { exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	unavailable = true;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText('799 credits left · stale', { exact: true })).toBeVisible();
	unavailable = false;
	credits = 0;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText(/^0 credits left · Top up$/)).toBeVisible();
	await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
	await expect(page.getByRole('link', { name: 'Top up', exact: true })).toHaveAttribute('href', 'https://context.dev/dashboard/subscription');
	await page.getByRole('link', { name: 'Manage', exact: true }).click();
	await expect(page).toHaveURL(/\/app\/settings$/);
	expect(await page.pageErrors()).toEqual([]);
});
