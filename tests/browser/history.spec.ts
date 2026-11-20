import { expect } from '@playwright/test';
import { test } from './authenticated-test';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });
test.beforeEach(async ({ page }) => {
	await page.route('**/api/keys/verify', (route) => route.fulfill({ json: { openai: false, looot: false, typesafe: false, passwordRequired: false } }));
	await page.goto('/app');
	await page.getByRole('dialog').waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Undo sheet');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Value,Other\n10,20\n30,40');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
});

test('committed cell edits support shortcut undo/redo and toolbar controls', async ({ page }) => {
	const cells = page.getByRole('gridcell'), grid = page.getByRole('grid');
	await cells.first().dblclick();
	const inline = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await inline.fill('99');
	await inline.press('Enter');
	await expect(cells.first()).toHaveText('99');
	await grid.press(`${mod}+z`);
	await expect(cells.first()).toHaveText('10');
	await grid.press(`${mod}+Shift+z`);
	await expect(cells.first()).toHaveText('99');
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(cells.first()).toHaveText('10');
	await page.getByRole('button', { name: 'Redo', exact: true }).click();
	await expect(cells.first()).toHaveText('99');
	await grid.press('Control+z');
	await expect(cells.first()).toHaveText('10');
	await grid.press('Control+y');
	await expect(cells.first()).toHaveText('99');
});

test('text editing keeps its own history and bulk clear is one undo step', async ({ page }) => {
	const cells = page.getByRole('gridcell'), grid = page.getByRole('grid');
	await cells.first().dblclick();
	const inline = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await inline.press(`${mod}+a`);
	await inline.pressSequentially('123');
	await inline.press(`${mod}+z`);
	await expect(inline).toHaveText('10');
	await expect(cells.nth(1)).toHaveText('20');
	await inline.press('Escape');
	await cells.first().click();
	await grid.press('Shift+ArrowRight');
	await grid.press('Delete');
	await expect(cells.first()).toBeEmpty();
	await expect(cells.nth(1)).toBeEmpty();
	await grid.press(`${mod}+z`);
	await expect(cells.first()).toHaveText('10');
	await expect(cells.nth(1)).toHaveText('20');
	await expect(cells.nth(2)).toHaveText('30');
	await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
	await grid.press('Delete');
	await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
});

test('history survives navigation per sheet and resets on reload', async ({ page }) => {
	const cells = page.getByRole('gridcell');
	await cells.first().dblclick();
	const inline = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await inline.fill('77');
	await inline.press('Enter');
	await expect(cells.first()).toHaveText('77');
	const sheetUrl = page.url();
	await page.getByRole('link', { name: 'Back to sheets', exact: true }).click();
	await page.getByText('Undo sheet', { exact: true }).last().click();
	await expect(page).toHaveURL(sheetUrl);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(cells.first()).toHaveText('10');
	await page.reload();
	await expect(cells.first()).toHaveText('10');
	await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
	await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
});

for (const mode of ['inline', 'formula bar', 'failed save'] as const) {
	test(`${mode} keeps the new value visible until saving completes`, async ({ page }) => {
		const cells = page.getByRole('gridcell');
		const bar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
		await cells.nth(1).click();
		await bar.fill('=A1*2');
		await bar.press('Enter');
		await expect(cells.nth(1)).toHaveText('20');
		// Hold the real calculation before persistence to make a one-frame flash
		// reproducible, independent of machine speed or IndexedDB timing.
		await page.evaluate(() => {
			const state = window as typeof window & { releaseCalculation?: (fail?: boolean) => void; waitingCalculations?: number };
			const original = Worker.prototype.postMessage;
			let hold = true;
			const waiting: Array<(fail: boolean) => void> = [];
			Worker.prototype.postMessage = function (message, options) {
				if (hold && message.grid) {
					waiting.push((fail) => fail ? this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, error: 'Test save failed' } })) : original.call(this, message, (Array.isArray(options) ? { transfer: options } : options) as StructuredSerializeOptions));
					state.waitingCalculations = waiting.length;
				} else original.call(this, message, (Array.isArray(options) ? { transfer: options } : options) as StructuredSerializeOptions);
			};
			state.releaseCalculation = (fail = false) => { hold = false; for (const send of waiting.splice(0)) send(fail); };
		});
		await cells.first().click();
		if (mode === 'inline') await cells.first().dblclick();
		const editor = mode === 'inline' ? page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true }) : bar;
		await editor.fill('99');
		await editor.press('Enter');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { waitingCalculations?: number }).waitingCalculations)).toBeGreaterThan(0);
		await expect(cells.first()).toHaveText('99');
		await expect(bar).toHaveText('99');
		await page.evaluate((fail) => (window as typeof window & { releaseCalculation?: (fail: boolean) => void }).releaseCalculation?.(fail), mode === 'failed save');
		if (mode === 'failed save') {
			await expect(cells.first()).toHaveText('10');
			await expect(bar).toHaveText('10');
			await expect(page.getByText('Test save failed', { exact: true })).toBeVisible();
			return;
		}
		await expect(cells.nth(1)).toHaveText('198');
		await page.getByRole('button', { name: 'Undo', exact: true }).click();
		await expect(cells.first()).toHaveText('10');
		await expect(cells.nth(1)).toHaveText('20');
	});
}
