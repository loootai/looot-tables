import { expect, type Page } from '@playwright/test';
import { test } from './authenticated-test';

async function connected(page: Page, events: unknown[]) {
	await page.addInitScript(() => localStorage.setItem('looot-tables.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', loootKey: 'test-looot' })));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/logos/resolve', (route) => route.fulfill({ json: { domain: null } }));
	const requests: unknown[] = [];
	await page.route('**/api/populate', async (route) => {
		requests.push(route.request().postDataJSON());
		await route.fulfill({ contentType: 'application/x-ndjson', body: events.map((event) => JSON.stringify(event)).join('\n') + '\n' });
	});
	await page.goto('/app');
	return requests;
}

test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });

test('the empty Sheets page is one composer: nothing is created until the prompt is sent', async ({ page }) => {
	await connected(page, []);
	await expect(page.getByText('0 / 10 sheets')).toBeVisible();
	await expect(page.getByRole('button', { name: 'New sheet', exact: true })).toHaveCount(0);
	for (const entity of ['companies', 'people', 'websites']) {
		await page.getByRole('radio', { name: entity, exact: false }).click();
		await expect(page.getByRole('button', { name: `Find ${entity}`, exact: true })).toBeDisabled();
	}
	await page.getByRole('radio', { name: 'Companies', exact: false }).click();
	await page.getByLabel('Describe the rows you want', { exact: true }).fill('Find me 101 companies');
	await expect(page.getByRole('alert')).toHaveText('Only 100 at a time. Ask for 100 or fewer.');
	await expect(page.getByRole('button', { name: 'Find companies', exact: true })).toBeDisabled();
	await page.reload();
	await expect(page.getByText('0 / 10 sheets')).toBeVisible();
	await expect(page.getByRole('list', { name: 'Sheets' })).toHaveCount(0);
});

test('Find rows names the new sheet from the prompt and streams rows into it', async ({ page }) => {
	const requests = await connected(page, [
		{ type: 'rows', key: 'Domain', rows: [{ Company: 'Sunrun', Domain: 'sunrun.example' }, { Company: 'Sunnova', Domain: 'sunnova.example' }] },
		{ type: 'done', total: 2 },
	]);
	await page.getByLabel('Describe the rows you want', { exact: true }).fill('Find 50 solar installers in Texas that offer financing');
	await expect(page.getByText('50 companies')).toBeVisible();
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	await expect(page).toHaveURL(/\/app\/sheets\/[^?]+$/);
	await expect(page.getByText('Solar installers in Texas', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Added 2 companies')).toBeVisible({ timeout: 12_000 });
	await expect(page.getByText('Added 2 companies')).toHaveCount(1);
	await expect(page.getByRole('dialog')).toHaveCount(0);
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({ entity: 'companies', target: 50 });
	await page.goto('/app');
	await expect(page.getByText('1 / 10 sheets')).toBeVisible();
	await expect(page.getByRole('list', { name: 'Sheets' }).getByText('Solar installers in Texas')).toBeVisible();
});

test('the prompt picks what to find until the user picks it', async ({ page }) => {
	await connected(page, []);
	const prompt = page.getByLabel('Describe the rows you want', { exact: true });
	await prompt.fill('Find 30 heads of growth at Series B fintechs in the US');
	await expect(page.getByRole('radio', { name: 'People', exact: false })).toBeChecked();
	await expect(page.getByText('30 people')).toBeVisible();
	await prompt.fill('SaaS pricing pages that mention a free tier');
	await expect(page.getByRole('radio', { name: 'Websites', exact: false })).toBeChecked();
	await page.getByRole('radio', { name: 'Companies', exact: false }).click();
	await prompt.fill('Founders of climate startups');
	await expect(page.getByRole('radio', { name: 'Companies', exact: false })).toBeChecked();
});

test('a search with no matches reopens Find rows with the prompt kept, and closing it removes the empty sheet', async ({ page }) => {
	await connected(page, [{ type: 'done', total: 0 }]);
	await page.getByLabel('Describe the rows you want', { exact: true }).fill('Heads of growth at imaginary companies');
	await page.getByRole('button', { name: 'Find people', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Find rows', exact: true });
	await expect(dialog.getByRole('status')).toHaveText('No people matched. Try a broader description.');
	await expect(dialog.getByLabel('Describe the rows you want', { exact: true })).toHaveValue('Heads of growth at imaginary companies');
	await expect(dialog.getByRole('radio', { name: 'People', exact: false })).toBeChecked();
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page).toHaveURL(/\/app$/);
	await expect(page.getByText('0 / 10 sheets')).toBeVisible();
});

test('a rejected key is caught before a sheet exists, with the fix in place', async ({ page }) => {
	await connected(page, []);
	await page.route('**/api/keys/verify*', (route) => route.request().method() === 'POST'
		? route.fulfill({ json: { openai: { ok: true }, context: { ok: false, issue: 'key', message: 'looot rejected this key.' }, typesafe: { ok: false, configured: false } } })
		: route.fallback());
	await page.getByLabel('Describe the rows you want', { exact: true }).fill('Solar installers in Texas');
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	await expect(page.getByRole('alert')).toContainText('looot rejected this key.');
	await expect(page.getByRole('link', { name: 'Open Connections', exact: true })).toBeVisible();
	await expect(page).toHaveURL(/\/app$/);
	await expect(page.getByText('0 / 10 sheets')).toBeVisible();
});

test('a failed search offers the same fix as a paused run', async ({ page }) => {
	await connected(page, [{ type: 'error', message: 'looot rejected the API key.', failure: { reason: 'credential_invalid', retryable: false, provider: 'context' } }]);
	await page.getByLabel('Describe the rows you want', { exact: true }).fill('Solar installers in Texas');
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Find rows', exact: true });
	await expect(dialog.getByRole('alert')).toContainText('looot rejected the API key.');
	await expect(dialog.getByRole('link', { name: 'Open Connections', exact: true })).toBeVisible();
});

test('Import CSV and Blank sheet stay one click away, and New sheet opens the same composer', async ({ page }) => {
	await connected(page, []);
	await page.getByRole('button', { name: 'Blank sheet', exact: true }).click();
	await expect(page).toHaveURL(/\/app\/sheets\/[^?]+$/);
	await expect(page.getByRole('row')).toHaveCount(2);
	await expect(page.getByText('Type your own rows, or fill the sheet from the web.')).toBeVisible();
	await page.goto('/app');
	await page.getByRole('button', { name: 'New sheet', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'New sheet', exact: true });
	await expect(dialog.getByLabel('Describe the rows you want', { exact: true })).toBeFocused();
	await dialog.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Import a CSV', exact: true })).toBeVisible();
	await expect(page.getByText('Drop a CSV or TSV file here, or')).toBeVisible();
});
