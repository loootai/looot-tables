import { test, expect } from '@playwright/test';
import { memberCookie } from './authenticated-test';

test('workspace trial balance shows dollars against the grant and the setup stays out of the way', async ({ page, context, baseURL }) => {
	await context.addCookies([{ name: 'enrichable.session', value: memberCookie('browser-user'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
	let remainingUsd = 2;
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: route.request().method() === 'POST'
		? { openai: { ok: true, inference: true }, context: { ok: true }, typesafe: { configured: false, ok: false } }
		: { openai: true, openaiTrial: { model: 'gpt-6-luna' }, context: true, contextConnected: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/sheets', (route) => route.fulfill({ json: [] }));
	await page.route('**/api/context/usage', (route) => route.fulfill({ json: { credits: 1000, used: 0 } }));
	await page.route('**/api/openai/usage', (route) => route.fulfill({ json: { enabled: true, model: 'gpt-6-luna', grantedUsd: 2, remainingUsd, deploymentAvailable: true } }));
	await page.goto('/app');
	const trials = page.getByRole('button', { name: 'Included trials', exact: true });
	await expect(trials).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByRole('progressbar', { name: 'AI trial remaining' })).toBeHidden();
	await trials.click();
	await expect(page.getByRole('progressbar', { name: 'AI trial remaining' })).toHaveAttribute('aria-valuenow', '100');
	await expect(page.getByText('$2.00 of $2.00 left', { exact: true })).toBeVisible();
	await expect(page.getByText('1,000 credits left', { exact: true })).toBeVisible();
	remainingUsd = 0.62;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(page.getByText('$0.62 of $2.00 left', { exact: true })).toBeVisible();
	await expect(page.getByRole('progressbar', { name: 'AI trial remaining' })).toHaveAttribute('aria-valuenow', '31');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.goto('/app/settings');
	await page.getByText('Advanced', { exact: true }).click();
	await expect(page.getByText('Your workspace uses the included AI trial (gpt-6-luna). Connect your own OpenAI key to choose models.', { exact: true })).toBeVisible();
	await expect(page.getByRole('combobox', { name: 'AI model', exact: true }), 'Model pickers are hidden while the trial key is in use').toHaveCount(0);
	expect(await page.pageErrors()).toEqual([]);
});


for (const exhausted of ['organization', 'deployment']) {
 test(`${exhausted} trial limit explains the limit and opens the required OpenAI key field`, async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'enrichable.session', value: memberCookie('browser-user'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
  await page.route('**/api/keys/verify*', (route) => {
   if (route.request().method() === 'POST') return route.fulfill({ json: { openai: { ok: true, inference: true }, context: { ok: true }, typesafe: { ok: false, configured: false } } });
   return route.fulfill({ json: { openai: true, openaiTrial: { model: 'gpt-6-luna' }, context: true, contextConnected: true, typesafe: false, passwordRequired: false } });
  });
  await page.route('**/api/sheets', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/context/usage', (route) => route.fulfill({ json: { credits: 1000 } }));
  await page.route('**/api/openai/usage', (route) => route.fulfill({ json: { enabled: true, remainingUsd: exhausted === 'organization' ? 0 : 1, deploymentAvailable: exhausted !== 'deployment' } }));
  await page.goto('/app');
  await expect(page.getByRole('dialog', { name: 'Add your OpenAI API key' })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('limit has been reached. An OpenAI API key is required for future AI requests.');
  const key = page.getByLabel('OpenAI API key', { exact: true });
  await expect(key).toBeVisible();
  await expect(key).toHaveAttribute('required', '');
  await expect(page.getByRole('button', { name: 'Save and start', exact: true })).toBeDisabled();
  await expect(key).toBeFocused();
  await key.fill('test-personal-openai-key');
  await expect(page.getByRole('button', { name: 'Save and start', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Save and start', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Included trials', exact: true }).click();
  await expect(page.getByText('Using your own OpenAI key', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.pageErrors()).toEqual([]);
 });
}
