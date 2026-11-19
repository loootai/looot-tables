import { expect } from '@playwright/test';
import { test } from './authenticated-test';

test('entity names expand when they fit, and compact together when a column narrows', async ({ page }) => {
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: false, context: false, typesafe: false, passwordRequired: false } }));
	await page.goto('/app');
	await page.getByRole('dialog').waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Adaptive entity names');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Schools\nRevi Solutions,School');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
	await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('enrichable.cloud.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396'); request.onsuccess = () => resolve(request.result); });
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(['sheets', 'rows'], 'readwrite');
			const sheetRequest = tx.objectStore('sheets').openCursor();
			sheetRequest.onsuccess = () => {
				const cursor = sheetRequest.result!;
				const sheet = cursor.value;
				sheet.columns.forEach((column: { width: number }) => { column.width = 450; });
				cursor.update(sheet);
				const rowRequest = tx.objectStore('rows').openCursor();
				rowRequest.onsuccess = () => {
					const rowCursor = rowRequest.result!;
					const row = rowCursor.value;
					row.cells[sheet.columns[1].id].v = ['Stanford University', 'Harvard University'];
					rowCursor.update(row);
				};
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	});
	await page.reload();
	const labels = page.locator('[data-entity-visible-label]');
	await expect(labels).toHaveText(['Revi Solutions', 'Stanford University', 'Harvard University']);
	const resize = async (header: number, delta: number) => {
		const handle = page.getByRole('columnheader').nth(header).getByRole('separator');
		await handle.scrollIntoViewIfNeeded();
		const box = await handle.boundingBox();
		if (!box) throw new Error('Missing resize handle');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await handle.dispatchEvent('pointerdown', { button: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
		await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 8 });
		await page.mouse.up();
	};
	await resize(2, -280);
	await expect(labels).toHaveText(['Revi Solutions', 'Stanford …', 'Harvard U…']);
	await resize(1, -350);
	await expect(labels.first()).toHaveText('Revi Solu…');
	await resize(1, 350);
	await resize(2, 280);
	await expect(labels).toHaveText(['Revi Solutions', 'Stanford University', 'Harvard University']);
	expect(await page.pageErrors()).toEqual([]);
});
