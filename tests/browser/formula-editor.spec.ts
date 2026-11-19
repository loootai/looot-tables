import { expect } from '@playwright/test';
import { test } from './authenticated-test';

test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });

test.beforeEach(async ({ page }) => {
	// Formula editing requires no API keys. Keep setup independent of this deployment's credentials.
	await page.route('**/api/keys/verify', (route) => route.fulfill({ json: { openai: false, context: false, typesafe: false, passwordRequired: false } }));
	await page.goto('/app');
	await page.getByRole('dialog').waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Formula editor check');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Value,Formula,Other\n10,,\n20,,');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
});

test('keeps the caret after equals when delayed highlighting arrives', async ({ page }) => {
	await page.getByRole('gridcell').nth(1).click();
	await page.keyboard.type('=');
	const inline = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	// Wait for the worker response that redraws the initial equals sign.
	await expect(inline.locator('.formula-token-operator')).toHaveText('=');
	await page.keyboard.type('1+2');
	await expect(inline).toHaveText('=1+2');
	await inline.press('Enter');
	await expect(page.getByRole('gridcell').nth(1)).toHaveText('3');
});

test('completes formulas, shows nested argument help, highlights syntax, and persists calculations', async ({ page }) => {
	const cells = page.getByRole('gridcell');
	const bar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
	await cells.nth(1).click();
	await bar.fill('=SUM');
	await expect(page.getByRole('listbox')).toBeVisible();
	await expect(page.locator('[data-function-help="SUM"]')).toContainText('Adds all numbers');
	// A documentation preview must be reachable, not clipped by the suggestions list.
	await page.locator('[data-function-help="SUM"]').click();
	await expect(bar).toBeFocused();
	await bar.press('Tab');
	await expect(bar).toHaveText('=SUM()');
	await expect(page.locator('[data-function-help="SUM"] [data-active-argument="0"]')).toBeVisible();
	await page.keyboard.type('A1:A2');
	await expect(bar.locator('.formula-token-function')).toHaveText('SUM');
	await expect(bar.locator('.formula-token-reference')).toHaveText('A1:A2');
	await bar.press('Enter');
	await expect(cells.nth(1)).toHaveText('30');

	await cells.nth(2).click();
	await bar.fill('=IF(A1>5,');
	await expect(page.locator('[data-function-help="IF"] [data-active-argument="1"]')).toBeVisible();
	await page.keyboard.type('SUM(');
	await expect(page.locator('[data-function-help="SUM"] [data-active-argument="0"]')).toBeVisible();
	await page.keyboard.type('A1,');
	await expect(page.locator('[data-function-help="SUM"] [data-active-argument="1"]')).toBeVisible();
	await page.keyboard.type('A2),0)');
	await bar.press('Enter');
	await expect(cells.nth(2)).toHaveText('30');

	// Strict Mode must not mistake editor disposal for a blur/commit.
	await cells.nth(4).dblclick();
	const inline = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await inline.fill('=AV');
	await page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: /^AVERAGE$/ }) }).click();
	await expect(inline).toHaveText('=AVERAGE()');
	await page.keyboard.type('A1:A2');
	await inline.press('Enter');
	await expect(cells.nth(4)).toHaveText('15');

	await cells.nth(1).click();
	await bar.fill('=SU');
	await expect(page.getByRole('listbox')).toBeVisible();
	await bar.press('Escape');
	await expect(page.getByRole('listbox')).toHaveCount(0);
	await bar.press('Escape');
	await expect(bar).toHaveText('=SUM(A1:A2)');
	await cells.nth(3).dblclick();
	await inline.fill('25');
	await inline.press('Enter');
	await expect(cells.nth(1)).toHaveText('35');
	await expect(cells.nth(4)).toHaveText('17.5');
	await page.reload();
	await expect(cells.nth(1)).toHaveText('35');
});

test('supports explicit completion in the middle of Unicode text and keeps ordinary text literal', async ({ page }) => {
	const cells = page.getByRole('gridcell');
	const bar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
	await cells.nth(1).click();
	await bar.fill('=IF("😀",SU)');
	await bar.press('ArrowLeft');
	await bar.press('Control+Space');
	await page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: /^SUM$/ }) }).click();
	await expect(bar).toHaveText('=IF("😀",SUM())');
	await expect(page.locator('[data-function-help="SUM"] [data-active-argument="0"]')).toBeVisible();
	await expect(bar.locator('.formula-token-string')).toHaveText('"😀"');
	await bar.press('Escape'); // Hide help, then cancel the draft.
	await bar.press('Escape');
	await bar.fill('plain SUM text');
	await expect(page.getByRole('listbox')).toHaveCount(0);
	await expect(bar.locator('[class*="formula-token-"]')).toHaveCount(0);
	await bar.press('Enter');
	await expect(cells.nth(1)).toHaveText('plain SUM text');
});

for (const width of [1360, 672, 390]) {
	test(`autocomplete documentation does not cover the suggestions at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 800 });
		const cell = page.getByRole('gridcell').first();
		await cell.dblclick();
		const editor = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
		await editor.fill('=av');
		const list = page.getByRole('listbox');
		const help = page.locator('.cm-completionInfo');
		await expect(list).toBeVisible();
		await expect(help).toBeVisible();
		await expect.poll(async () => {
			const a = await list.boundingBox(), b = await help.boundingBox();
			if (!a || !b) return false;
			return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
		}).toBe(true);
		await expect.poll(async () => {
			const bounds = await help.boundingBox();
			return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 800;
		}).toBe(true);
		// Geometry assertions above cover the stacking behavior without fixed screenshot baselines.
		await page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: /^AVERAGE$/ }) }).click();
		await expect(editor).toHaveText('=AVERAGE()');
	});
}


test('resizes the formula bar without committing, wraps long formulas, and keeps height across cells', async ({ page }) => {
	const cells = page.getByRole('gridcell');
	const bar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
	const container = page.locator('[data-formula-bar]');
	const handle = page.getByRole('separator', { name: 'Resize formula bar', exact: true });
	await cells.nth(1).click();
	const formula = '=' + Array.from({ length: 100 }, () => 'A1').join('+');
	await bar.fill(formula);
	const start = (await handle.boundingBox())!;
	await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
	await page.mouse.down();
	await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 100, { steps: 5 });
	await page.mouse.up();
	await expect(bar).toBeFocused();
	await expect(cells.nth(1)).toHaveText('');
	await expect.poll(async () => (await container.boundingBox())!.height).toBe(136);
	await expect.poll(() => bar.locator('.cm-line').evaluate((line) => line.getBoundingClientRect().height)).toBeGreaterThan(30);
	await bar.press('Enter');
	await expect(cells.nth(1)).toHaveText('1000');
	await cells.first().click();
	await expect.poll(async () => (await container.boundingBox())!.height).toBe(136);
	await handle.focus();
	await handle.press('ArrowDown');
	await expect.poll(async () => (await container.boundingBox())!.height).toBe(156);
	await handle.press('Home');
	await expect.poll(async () => (await container.boundingBox())!.height).toBe(36);
});

test('Enter selects the cell below after selection and editing, while blur preserves the clicked cell', async ({ page }) => {
	const grid = page.getByRole('grid', { name: 'Sheet grid' });
	const dataRows = page.getByRole('row').filter({ has: page.getByRole('gridcell') });
	const top = dataRows.nth(0).getByRole('gridcell').nth(0);
	const below = dataRows.nth(1).getByRole('gridcell').nth(0);
	const other = dataRows.nth(0).getByRole('gridcell').nth(1);
	const inline = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await top.click();
	await page.keyboard.press('Enter');
	await expect(below).toHaveAttribute('aria-selected', 'true');
	await expect(inline).toHaveCount(0);
	await page.keyboard.press('Enter');
	await expect(below).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('Shift+Enter');
	await expect(top).toHaveAttribute('aria-selected', 'true');
	await page.keyboard.press('F2');
	await inline.fill('42');
	await inline.press('Enter');
	await expect(top).toHaveText('42');
	await expect(below).toHaveAttribute('aria-selected', 'true');
	await expect(grid).toBeFocused();
	await top.click();
	const bar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
	await bar.fill('43');
	await bar.press('Enter');
	await expect(top).toHaveText('43');
	await expect(below).toHaveAttribute('aria-selected', 'true');
	await expect(grid).toBeFocused();
	await top.dblclick();
	await inline.fill('44');
	await other.click();
	await expect(top).toHaveText('44');
	await expect(other).toHaveAttribute('aria-selected', 'true');
});
