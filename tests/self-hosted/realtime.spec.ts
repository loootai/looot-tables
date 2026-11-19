import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadEnvConfig } from '@next/env';
import { randomUUID } from 'node:crypto';

loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
test('independent clients receive MCP edits, collaborator selections, conflict prompts, and reconnect without polling', async ({ page, browser, baseURL }) => {
	test.skip(!process.env.NEON_REALTIME_SECRET?.startsWith('nrt_live_1'), 'A configured Neon Realtime branch is required.');
	test.setTimeout(150_000);
	await page.goto('/app');
	await page.getByRole('dialog', { name: 'Set up enrichment' }).waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	const account = await page.request.get('/api/auth/session').then((r) => r.json());
	const headers = { 'x-enrichable-account': account.partition, 'x-enrichable-session': account.sessionId, origin: baseURL! };
	const sheetId = `rt-${randomUUID()}`;
	const now = Date.now();
	const sheet = { id: sheetId, name: 'Realtime verification', columns: [{ id: 'name', name: 'Value', type: 'source', width: 220, createdAt: now }], filters: [], sort: null, createdAt: now, updatedAt: now };
	const response = await page.request.post('/api/sheets', { headers, data: { sheet, rows: [{ id: `row-${sheetId}`, sheetId, order: 0, createdAt: now, cells: { name: { v: 'Initial', s: 'done', t: now } } }] } });
	expect(response.ok()).toBeTruthy();
	const keyResponse = await page.request.post('/api/mcp-key', { headers, data: {} });
	expect(keyResponse.ok()).toBeTruthy();
	const key = (await keyResponse.json()).key.secret;
	const other = await browser.newContext({ baseURL });
	await other.addCookies(await page.context().cookies());
	const second = await other.newPage();
	const pageErrors: string[] = [];
	for (const p of [page, second]) p.on('pageerror', (error) => pageErrors.push(error.message));
	const client = new Client({ name: 'realtime-browser-test', version: '1.0.0' });
	await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseURL), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
	try {
		await page.goto(`/app/sheets/${sheetId}`);
		await second.goto(`/app/sheets/${sheetId}`);
		await second.getByRole('dialog', { name: 'Set up enrichment' }).waitFor();
		await second.getByRole('button', { name: 'Close', exact: true }).click();
		for (const p of [page, second]) {
			await expect(p.locator('[data-collaboration-status="live"]')).toBeVisible({ timeout: 20_000 });
			await expect(p.getByRole('gridcell').first()).toContainText('Initial');
		}
		await second.getByRole('gridcell').first().click();
		await expect(page.locator('[data-collaborator-cell]')).toBeVisible({ timeout: 10_000 });
		let revision = 1;
		const write = async (value: string) => {
			const result = await client.callTool({ name: 'update_cells', arguments: { sheetId, revision, cells: [{ rowId: `row-${sheetId}`, columnId: 'name', value }] } });
			expect(result.isError).not.toBeTruthy();
			revision = (result.structuredContent as { revision: number }).revision;
		};
		// Simulate the Page Visibility API transition deterministically; headless
		// Chromium does not consistently hide tabs across independent contexts.
		await expect(page.locator('[data-collaborator-cell]')).toContainText('You (another tab)');
		const departures: string[] = [];
		const heartbeats: unknown[] = [];
		second.on('request', (request) => {
			if (!request.url().endsWith('/api/realtime/presence')) return;
			if (request.method() === 'DELETE') departures.push(request.url());
			if (request.method() === 'POST') heartbeats.push(request.postDataJSON());
		});
		await second.evaluate(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await write('Changed in background');
		await expect(page.getByRole('gridcell').first()).toContainText('Changed in background');
		await expect(second.getByRole('gridcell').first()).toContainText('Initial');
		// A quick return reuses the live subscriptions and drains buffered edits.
		const bundlesOnReturn: string[] = [];
		second.on('request', (request) => { if (new URL(request.url()).pathname === '/api/realtime') bundlesOnReturn.push(request.url()); });
		const resumedPresence = second.waitForResponse((response) => response.url().endsWith('/api/realtime/presence') && response.request().method() === 'POST');
		await second.evaluate(() => {
			Reflect.deleteProperty(document, 'hidden');
			Reflect.deleteProperty(document, 'visibilityState');
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await expect(second.locator('[data-collaboration-status="live"]')).toBeVisible();
		await expect(second.getByRole('gridcell').first()).toContainText('Changed in background');
		expect(bundlesOnReturn).toEqual([]);
		await resumedPresence;
		await second.clock.install();
		const hiddenPresence = second.waitForResponse((response) => response.url().endsWith('/api/realtime/presence') && response.request().method() === 'POST');
		await second.evaluate(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		// Longer absences still close subscriptions and stop collaboration traffic.
		await hiddenPresence;
		await expect.poll(() => heartbeats.length).toBeGreaterThanOrEqual(1);
		await second.clock.fastForward(4 * 60_000);
		await expect(second.locator('[data-collaboration-status="paused"]')).toHaveCount(0);
		await second.clock.fastForward(60_001);
		await expect(second.locator('[data-collaboration-status="paused"]')).toBeVisible();
		const requestsWhileHidden: string[] = [];
		second.on('request', (request) => { if (new URL(request.url()).pathname.startsWith('/api/realtime')) requestsWhileHidden.push(request.url()); });
		await page.waitForTimeout(21_000);
		expect(requestsWhileHidden).toEqual([]);
		expect(departures).toEqual([]);
		expect(heartbeats.every((body) => (body as { rowId: string }).rowId === `row-${sheetId}`)).toBeTruthy();
		await expect(page.locator('[data-collaborator-cell]')).toBeVisible();
		await second.clock.setSystemTime(Date.now());
		await second.evaluate(() => {
			Reflect.deleteProperty(document, 'hidden');
			Reflect.deleteProperty(document, 'visibilityState');
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await expect(second.getByRole('gridcell').first()).toContainText('Changed in background');
		await write('Agent update');
		for (const p of [page, second]) await expect(p.getByRole('gridcell').first()).toContainText('Agent update', { timeout: 10_000 });
		await page.getByRole('gridcell').first().dblclick();
		const editor = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
		await editor.fill('My unsaved draft', { timeout: 10_000 });
		await write('Teammate update');
		await expect(second.getByRole('gridcell').first()).toContainText('Teammate update', { timeout: 10_000 });
		await expect(editor).toHaveText('My unsaved draft');
		await editor.press('Enter');
		const conflict = page.getByRole('dialog', { name: 'This cell changed while you were editing' });
		await expect(conflict).toBeVisible();
		await expect(conflict).toContainText('My unsaved draft');
		await conflict.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(page.getByRole('gridcell').first()).toContainText('Teammate update');
		await other.setOffline(true);
		await expect(second.locator('[data-collaboration-status="offline"]')).toBeVisible();
		await write('Changed while offline');
		await other.setOffline(false);
		await expect(second.locator('[data-collaboration-status="live"]')).toBeVisible({ timeout: 20_000 });
		await expect(second.getByRole('gridcell').first()).toContainText('Changed while offline');
		await page.getByRole('gridcell').first().click();
		const formulaBar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
		await formulaBar.fill('Formula bar draft');
		await write('Another saved value');
		await expect(second.getByRole('gridcell').first()).toContainText('Another saved value');
		await expect(formulaBar).toHaveText('Formula bar draft');
		await formulaBar.press('Enter');
		await expect(conflict).toBeVisible();
		await conflict.getByRole('button', { name: 'Keep my edit', exact: true }).click();
		await expect(second.getByRole('gridcell').first()).toContainText('Formula bar draft');
		revision = (await page.request.get(`/api/sheets/${sheetId}`, { headers }).then((r) => r.json())).sheet.revision;
		const configured = await client.callTool({ name: 'configure_column', arguments: { sheetId, revision, column: { id: 'greeting', name: 'Greeting', type: 'enriched', op: { kind: 'template', template: 'Hello {{Value}}' } } } });
		expect(configured.isError).not.toBeTruthy();
		const enriched = await client.callTool({ name: 'enrich_cells', arguments: { sheetId, columnId: 'greeting', rowIds: [`row-${sheetId}`], idempotencyKey: randomUUID() } });
		expect(enriched.isError).not.toBeTruthy();
		for (const p of [page, second]) await expect(p.getByRole('gridcell').nth(1)).toContainText('Hello Formula bar draft', { timeout: 10_000 });
		expect(pageErrors).toEqual([]);
		await page.screenshot({ path: '/private/tmp/enrichable-realtime.png' });
	} finally {
		await client.close(); await other.close();
		const current = await page.request.get(`/api/sheets/${sheetId}`, { headers }).then((r) => r.json());
		if (current.sheet) await page.request.delete(`/api/sheets/${sheetId}?revision=${current.sheet.revision}`, { headers });
	}
});
