import { test, expect, type Page } from '@playwright/test';
import { memberCookie } from './authenticated-test';

async function mockProviders(page: Page, available: Record<string, unknown>) {
 await page.route('**/api/organization-settings', route => route.fulfill({ json: { local: true } }));
 await page.route('**/api/sheets', (route) => route.fulfill({ json: [] }));
 await page.route('**/api/looot/balance*', (route) => route.fulfill({ json: { credits: 1000, used: 0 } }));
 await page.route('**/api/openai/usage*', (route) => route.fulfill({ json: { enabled: false } }));
 await page.route('**/api/keys/verify*', (route) => {
  if (route.request().method() === 'GET') return route.fulfill({ json: available });
  const headers = route.request().headers();
  const context = Boolean(available.context || headers['x-looot-key'] === 'ctxt_valid');
  const exhausted = Boolean(available.trialExhausted && !headers['x-openai-key']);
  const openai = !exhausted && Boolean(available.openai || headers['x-openai-key'] === 'sk-valid');
  return route.fulfill({ json: { openai: { ok: openai, inference: openai, ...(exhausted ? { issue: 'billing', message: 'AI trial credit is exhausted. Add your own OpenAI key to continue.' } : {}) }, context: { ok: context }, typesafe: { configured: false, ok: false } } });
 });
}

test('hosted first run asks only for the required connections and offers one Reconnect button for Context.dev', async ({ page, context, baseURL }) => {
 await context.addCookies([{ name: 'enrichable.session', value: memberCookie('onboarding-new'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 await mockProviders(page, { openai: false, looot: false, typesafe: false, passwordRequired: false });
 await page.goto('/app');
 const dialog = page.getByRole('dialog', { name: 'Set up enrichment' });
 const providers = dialog.getByRole('region');
 await expect(providers).toHaveCount(2);
 await expect(providers.nth(0)).toContainText('Context.dev');
 await expect(providers.nth(1)).toContainText('OpenAI');
 for (const hidden of ['available', 'TypeSafe', 'Hunter', 'Prospeo', 'QuickEnrich', 'Apollo', 'ContactOut', 'Logo Link', 'model']) await expect(dialog).not.toContainText(hidden);
 await expect(dialog.getByLabel('Context.dev API key', { exact: true })).toHaveCount(0);
 const save = dialog.getByRole('button', { name: 'Save and start', exact: true });
 await expect(save).toBeDisabled();
 await dialog.getByLabel('OpenAI API key', { exact: true }).fill('sk-not-checked-yet');
 await expect(save, 'Saving never waits for a live check').toBeEnabled();
 let started = '';
 await page.route('**/api/auth/start*', route => { started = route.request().url(); return route.fulfill({ body: 'consent' }); });
 await dialog.getByRole('button', { name: 'Reconnect Context.dev', exact: true }).click();
 await expect.poll(() => started).toContain('reconnect=context');
 expect(new URL(started).searchParams.get('returnTo')).toBe('/app');
});

test('configured connections skip setup and are listed in Configuration', async ({ page, context, baseURL }) => {
 await context.addCookies([{ name: 'enrichable.session', value: memberCookie('onboarding-connected'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 await mockProviders(page, { openai: true, context: true, contextConnected: true, typesafe: false, passwordRequired: false });
 await page.goto('/app/settings');
 await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 const contextRow = page.getByRole('region', { name: 'Connections' }).getByRole('listitem').filter({ hasText: 'Context.dev' });
 await expect(contextRow).toContainText('Context.dev sign-in');
 await expect(contextRow).toContainText('Connected');
});

test('included OpenAI usage needs no key until the trial limit makes it required', async ({ page, context, baseURL }) => {
 await context.addCookies([{ name: 'enrichable.session', value: memberCookie('onboarding-included'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 await mockProviders(page, { openai: true, openaiTrial: { model: 'gpt-6-luna' }, context: true, contextConnected: true, typesafe: false, passwordRequired: false });
 await page.goto('/app/settings');
 const openaiRow = page.getByRole('region', { name: 'Connections' }).getByRole('listitem').filter({ hasText: 'OpenAI' });
 await expect(openaiRow).toContainText('Included trial');
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.evaluate(() => window.dispatchEvent(new CustomEvent('enrichable:openai-key-required', { detail: 'An OpenAI API key is required for future AI requests.' })));
 const dialog = page.getByRole('dialog', { name: 'Add your OpenAI API key' });
 await expect(dialog.getByRole('alert')).toContainText('An OpenAI API key is required');
 await expect(dialog.getByLabel('OpenAI API key', { exact: true })).toHaveJSProperty('required', true);
 await expect(dialog.getByRole('region', { name: 'Context.dev' })).toContainText('Connected');
 await expect(dialog.getByRole('button', { name: 'Save and start', exact: true })).toBeDisabled();
 expect(await page.pageErrors()).toEqual([]);
});

test('an exhausted allowance found while checking connections is shown on the OpenAI row', async ({ page, context, baseURL }) => {
 await context.addCookies([{ name: 'enrichable.session', value: memberCookie('onboarding-exhausted'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
 await mockProviders(page, { openai: true, openaiTrial: { model: 'gpt-6-luna' }, trialExhausted: true, context: true, contextConnected: true, typesafe: false, passwordRequired: false });
 await page.goto('/app/settings');
 await expect(page.getByRole('region', { name: 'Connections' }).getByRole('listitem').filter({ hasText: 'OpenAI' })).toContainText('AI trial credit is exhausted');
});
