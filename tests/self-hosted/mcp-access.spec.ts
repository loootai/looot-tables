import { expect, test } from '@playwright/test';

test('agent access retrieves and copies a shared key after reload and preserves atomic rotation', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	// UI boundary test; database and protocol behavior are covered with embedded Postgres in server/mcp.test.ts.
	await page.route('**/api/sheets', (route) => route.fulfill({ json: [] }));
	await page.route('**/api/keys/verify', (route) => route.fulfill({ json: { openai: false, context: false, typesafe: false, contextConnected: false, passwordRequired: false } }));
	let key: { prefix: string; version: string; createdAt: number; recoverable?: boolean; secret?: string } | null = null;
	const first = `enr_mcp_${'a'.repeat(43)}`;
	const replacement = `enr_mcp_${'b'.repeat(43)}`;
	const writes: string[] = [];
	await page.route('**/api/mcp-key*', async (route) => {
		const request = route.request();
		expect(request.headers()['x-enrichable-account']).toBeTruthy();
		expect(request.headers()['x-enrichable-session']).toBeTruthy();
		if (request.method() === 'GET') return route.fulfill({ json: { key: request.url().includes('reveal=1') ? key : key && { ...key, secret: undefined } } });
		writes.push(request.method());
		if (request.method() === 'POST') {
			key = { prefix: first.slice(0, 16), version: '11111111-1111-4111-8111-111111111111', createdAt: Date.now(), recoverable: true, secret: first };
			return route.fulfill({ json: { key: { ...key, secret: first } } });
		}
		expect(request.postDataJSON()).toEqual({ version: key!.version });
		key = { prefix: replacement.slice(0, 16), version: '22222222-2222-4222-8222-222222222222', createdAt: Date.now(), recoverable: true, secret: replacement };
		return route.fulfill({ json: { key: { ...key, secret: replacement } } });
	});
	await page.goto('/app/settings');
	await page.getByRole('dialog', { name: 'Set up enrichment' }).waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Agent access' })).toBeVisible();
	await expect(page.getByText('Required:')).toBeVisible();
	await page.getByRole('button', { name: 'Create agent key' }).click();
	await expect(page.getByText(first, { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Create agent key' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Hide key' }).click();
	await expect(page.getByText(first, { exact: true })).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Agent access' })).toBeVisible();
	await expect(page.getByRole('dialog'), 'Setup opens once per browser').toHaveCount(0);
	await expect(page.getByText(first, { exact: true })).toHaveCount(0);
	await page.getByRole('button', { name: 'Copy MCP config', exact: true }).click();
	await expect(page.getByText('MCP config copied. Replace the two provider key placeholders before using it.', { exact: true })).toBeVisible();
	const config = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).mcpServers.enrichable;
	expect(config.headers).toEqual({ Authorization: `Bearer ${first}`, 'x-openai-key': 'YOUR_OPENAI_API_KEY', 'x-looot-key': 'YOUR_CONTEXT_DEV_API_KEY' });
	expect(config.url).toMatch(/\/mcp$/);
	await page.getByRole('button', { name: 'Show key', exact: true }).click();
	await expect(page.getByText(first, { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Hide key', exact: true }).click();
	await page.getByRole('button', { name: 'Show key', exact: true }).click();
	await expect(page.getByText(first, { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Rotate key', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Rotate the agent key?' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Rotate key', exact: true }).click();
	await expect(page.getByText(replacement, { exact: true })).toBeVisible();
	expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(first);
	expect(writes).toEqual(['POST', 'PATCH']);
	expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(replacement);
});
