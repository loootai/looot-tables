import { expect, type Page, type Route } from '@playwright/test';
import { test } from './authenticated-test';

async function researchSheet(page: Page, requests: Route[], concurrency = 1) {
	await page.addInitScript((concurrency) => localStorage.setItem('looot-tables.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', loootKey: 'test-looot', concurrency })), concurrency);
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/enrich', (route) => { requests.push(route); });
	await page.goto('/app');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Single cell run');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Name,Research\nOne,\nOne,\nThree,');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
	await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('looot-tables.cloud.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396'); request.onsuccess = () => resolve(request.result); });
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction('sheets', 'readwrite');
			const request = tx.objectStore('sheets').openCursor();
			request.onsuccess = () => {
				const cursor = request.result!;
				const sheet = cursor.value;
				sheet.columns[1] = { ...sheet.columns[1], type: 'enriched', op: { kind: 'ai', prompt: 'Research {{Name}}', output: 'text', research: 'web' } };
				cursor.update(sheet);
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	});
	await page.reload();
}

test('cell play runs one row and autofills matching empty rows', async ({ page }) => {
	const requests: Route[] = [];
	await researchSheet(page, requests);
	const cells = page.getByRole('gridcell');
	const firstOutput = cells.nth(1);
	const play = firstOutput.getByRole('button', { name: 'Run Research for row 1' });
	await expect(play).toHaveCSS('opacity', '0');
	await firstOutput.hover();
	await expect(play).toHaveCSS('opacity', '1');
	let releaseSave!: () => void;
	const saving = new Promise<void>((resolve) => { releaseSave = resolve; });
	await page.route('**/api/sheets/*', async (route) => {
		if (route.request().method() === 'PATCH') await saving;
		await route.fallback();
	});
	await play.click();
	await expect(firstOutput).toContainText('Researching…');
	await expect(page.getByText('Queued 1 cell', { exact: true })).toHaveCount(0);
	await expect(firstOutput).not.toContainText('Queued');
	releaseSave();
	await expect.poll(() => requests.length).toBe(1);
	await requests[0].fulfill({ json: { value: 'Shared result' } });
	await expect(firstOutput).toContainText('Shared result');
	await expect(cells.nth(3)).toContainText('Shared result');
	await expect(cells.nth(5)).not.toContainText('Shared result');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(cells.locator('[data-formula-editor]')).toHaveCount(0);
	const otherPlay = cells.nth(5).getByRole('button', { name: 'Run Research for row 3' });
	await otherPlay.focus();
	await expect(otherPlay).toHaveCSS('opacity', '1');
	await page.keyboard.press('Enter');
	await expect.poll(() => requests.length).toBe(2);
	await requests[1].fulfill({ json: { value: 'Other result' } });
	await expect(cells.nth(5)).toContainText('Other result');
});


test('drag-fill shows research and queued immediately before saving, and errors only after failure', async ({ page }) => {
	const requests: Route[] = [];
	await researchSheet(page, requests, 1);
	const cells = page.getByRole('gridcell');
	await cells.nth(1).click();
	const handle = await page.getByRole('button', { name: 'Drag to run enrichment', exact: true }).boundingBox();
	const destination = await cells.nth(5).boundingBox();
	expect(handle).not.toBeNull();
	expect(destination).not.toBeNull();
	let releaseSave!: () => void;
	const saving = new Promise<void>((resolve) => { releaseSave = resolve; });
	await page.route('**/api/sheets/*', async (route) => {
		if (route.request().method() === 'PATCH') await saving;
		await route.fallback();
	});
	await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
	await page.mouse.down();
	await page.mouse.move(destination!.x + destination!.width / 2, destination!.y + destination!.height / 2, { steps: 8 });
	await page.mouse.up();
	await expect(cells.nth(3)).toContainText('Researching…');
	await expect(cells.nth(5)).toContainText('Queued');
	await expect(cells.nth(5).locator('[data-cell-status="queued"]')).toHaveCount(1);
	await expect(cells.nth(5)).not.toContainText('Error');
	await expect(page.getByText('2 queued', { exact: true })).toHaveCount(0);
	releaseSave();
	await expect.poll(() => requests.length).toBe(1);
	await requests[0].fulfill({ json: { value: 'Filled result' } });
	await expect(cells.nth(3)).toContainText('Filled result');
	await expect.poll(() => requests.length).toBe(2);
	await expect(cells.nth(5)).toContainText('Researching…');
	await requests[1].fulfill({ status: 400, json: { error: 'Research failed' } });
	await expect(cells.nth(5)).toContainText('Research failed');
});
