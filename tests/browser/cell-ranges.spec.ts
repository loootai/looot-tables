import { expect, type Page, type Locator } from '@playwright/test';
import { test } from './authenticated-test';

test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });

test.beforeEach(async ({ page }) => {
	await page.route('**/api/keys/verify', (route) => route.fulfill({ json: { openai: false, looot: false, typesafe: false, passwordRequired: false } }));
	await page.goto('/app');
	await page.getByRole('dialog').waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Cell ranges');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Value,Other,Formula\n' + Array.from({ length: 100 }, (_, i) => `${(i + 1) * 10},,`).join('\n'));
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
});

async function point(cell: Locator) {
	const box = await cell.boundingBox();
	if (!box) throw new Error('Cell is not visible');
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('column cells track the header width before releasing a resize drag', async ({ page }) => {
	const header = page.getByRole('columnheader').nth(1);
	const cell = page.getByRole('gridcell').first();
	const nextCell = page.getByRole('gridcell').nth(1);
	const before = await header.boundingBox();
	const handle = await header.getByRole('separator').boundingBox();
	if (!before || !handle) throw new Error('Missing column resize handle');
	const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 90, y, { steps: 5 });
	await expect.poll(async () => (await cell.boundingBox())?.width).toBeCloseTo(before.width + 90, 0);
	const during = await header.boundingBox();
	expect((await cell.boundingBox())?.width).toBeCloseTo(during!.width, 0);
	expect((await nextCell.boundingBox())?.x).toBeCloseTo(during!.x + during!.width, 0);
	const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname.startsWith('/api/sheets/') && response.ok());
	await page.mouse.up();
	await saved;
	await page.reload();
	await expect.poll(async () => (await page.getByRole('gridcell').first().boundingBox())?.width).toBeCloseTo(before.width + 90, 0);
});

test('headers drag in either direction, persist, undo, and cancel without sorting', async ({ page }) => {
	const header = (name: string) => page.getByRole('columnheader').filter({ has: page.getByRole('button', { name: new RegExp(`^[A-Z]+ ${name}$`) }) });
	const value = () => header('Value').getByRole('button', { name: /^[A-Z]+ Value$/ });
	const formula = () => header('Formula').getByRole('button', { name: /^[A-Z]+ Formula$/ });
	await page.getByRole('button', { name: 'Column menu for Value', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'Move left', exact: true })).toHaveCount(0);
	await expect(page.getByRole('menuitem', { name: 'Move right', exact: true })).toHaveCount(0);
	await page.keyboard.press('Escape');
	const start = await point(value()), end = await point(formula());
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(end.x + 30, end.y, { steps: 8 });
	await page.mouse.up();
	await expect(page.getByRole('columnheader').nth(3)).toContainText('Value');
	await expect(header('Value')).toHaveAttribute('aria-sort', 'none');
	await expect(page.getByRole('gridcell').nth(2)).toHaveText('10');
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(page.getByRole('columnheader').nth(1)).toContainText('Value');
	await page.getByRole('button', { name: 'Redo', exact: true }).click();
	await expect(page.getByRole('columnheader').nth(3)).toContainText('Value');
	await page.reload();
	await expect(page.getByRole('columnheader').nth(3)).toContainText('Value');
	const a = await point(value()), b = await point(header('Other').getByRole('button', { name: /^[A-Z]+ Other$/ }));
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x - 30, b.y, { steps: 8 });
	await page.keyboard.press('Escape');
	await page.mouse.up();
	await expect(page.getByRole('columnheader').nth(3)).toContainText('Value');
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x - 30, b.y, { steps: 8 });
	await page.mouse.up();
	await expect(page.getByRole('columnheader').nth(1)).toContainText('Value');
	await expect(header('Value')).toHaveAttribute('aria-sort', 'none');
});

test('sorting preserves the viewport while keyboard navigation still reveals the selected cell', async ({ page }) => {
	const grid = page.getByRole('grid');
	await page.getByRole('gridcell').first().click();
	const header = page.getByRole('button', { name: 'A Value', exact: true });
	await header.click();
	await expect(page.getByRole('columnheader').nth(1)).toHaveAttribute('aria-sort', 'ascending');
	await header.click();
	await expect(page.getByRole('columnheader').nth(1)).toHaveAttribute('aria-sort', 'descending');
	await expect(page.getByRole('gridcell').first()).toHaveText('1,000');
	await header.click();
	await expect(page.getByRole('columnheader').nth(1)).toHaveAttribute('aria-sort', 'none');
	await expect(page.getByRole('gridcell').first()).toHaveText('10');
	await header.click();
	await expect(page.getByRole('columnheader').nth(1)).toHaveAttribute('aria-sort', 'ascending');
	await header.click();
	await expect(page.getByRole('columnheader').nth(1)).toHaveAttribute('aria-sort', 'descending');
	expect(await grid.evaluate((element) => element.scrollTop)).toBe(0);
	await grid.press('ArrowUp');
	await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});
async function drag(page: Page, from: Locator, to: Locator, release = true) {
	const a = await point(from), b = await point(to);
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x, b.y, { steps: 8 });
	if (release) await page.mouse.up();
}

for (const key of ['Backspace', 'Delete']) {
test(`drag selects a rectangle, copies table data, supports Shift extension, and ${key} clears selected cells`, async ({ page }) => {
	const cells = page.getByRole('gridcell'), grid = page.getByRole('grid');
	await drag(page, cells.nth(0), cells.nth(4));
	await expect(page.locator('[data-range-selected="true"]')).toHaveCount(4);
	await expect(grid).toBeFocused();
	await expect(page.getByLabel('Cell address')).toHaveText('A1:B2');
	const copied = await grid.evaluate((element) => {
		const data = new DataTransfer();
		element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
		return data.getData('text/plain');
	});
	expect(copied).toBe('10\t\n20\t');
	await grid.press('Shift+ArrowRight');
	await expect(page.locator('[data-range-selected="true"]')).toHaveCount(6);
	await cells.nth(4).click({ modifiers: ['Shift'] });
	await expect(page.locator('[data-range-selected="true"]')).toHaveCount(4);
	await page.keyboard.press(key);
	await expect(cells.nth(0)).toBeEmpty();
	await expect(cells.nth(3)).toBeEmpty();
	await expect(cells.nth(6)).toHaveText('30');
	await grid.press('ArrowRight');
	await expect(page.locator('[data-range-selected="true"]')).toHaveCount(1);
});
}

test('Backspace clears enrichment results and formulas together, supports undo, and persists', async ({ page }) => {
	await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('looot-tables.cloud.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396'); request.onsuccess = () => resolve(request.result); });
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(['sheets', 'rows'], 'readwrite');
			const request = tx.objectStore('sheets').openCursor();
			request.onsuccess = () => {
				const cursor = request.result!;
				const sheet = cursor.value;
				sheet.columns[1] = { ...sheet.columns[1], type: 'enriched', op: { kind: 'ai', prompt: 'Research {{Value}}', output: 'text', research: 'web' } };
				cursor.update(sheet);
				const rows = tx.objectStore('rows').openCursor();
				rows.onsuccess = () => {
					const rowCursor = rows.result;
					if (!rowCursor) return;
					const row = rowCursor.value;
					row.cells[sheet.columns[1].id] = { v: 'Research result', s: 'done', t: Date.now(), m: { reasoning: 'Research details' } };
					rowCursor.update(row);
					rowCursor.continue();
				};
			};
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	});
	await page.reload();
	await page.getByRole('dialog').waitFor();
	await page.getByRole('button', { name: 'Close', exact: true }).click();
	const cells = page.getByRole('gridcell');
	await expect(cells.nth(1)).toHaveText('Research result');
	await cells.nth(2).dblclick();
	const editor = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await editor.fill('=A1*2');
	await editor.press('Enter');
	await expect(cells.nth(2)).toHaveText('20');
	await drag(page, cells.nth(0), cells.nth(2));
	await page.keyboard.press('Backspace');
	for (let i = 0; i < 3; i++) await expect(cells.nth(i)).toBeEmpty();
	await expect(cells.nth(3)).toHaveText('20');
	await expect(cells.nth(4)).toHaveText('Research result');
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
	await expect(cells.nth(0)).toHaveText('10');
	await expect(cells.nth(1)).toHaveText('Research result');
	await expect(cells.nth(2)).toHaveText('20');
	await page.keyboard.press('Backspace');
	for (let i = 0; i < 3; i++) await expect(cells.nth(i)).toBeEmpty();
	await page.reload();
	for (let i = 0; i < 3; i++) await expect(cells.nth(i)).toBeEmpty();
	await expect(cells.nth(3)).toHaveText('20');
});

test('formula-bar dragging inserts a range without committing, supports undo, and replaces the range on another pick', async ({ page }) => {
	const cells = page.getByRole('gridcell'), bar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
	await cells.nth(2).click();
	await bar.fill('=SUM()');
	await bar.press('ArrowLeft');
	await drag(page, cells.nth(0), cells.nth(3), false);
	await expect(page.locator('[data-formula-range="true"]')).toHaveCount(2);
	await expect(bar).toHaveText('=SUM(A1:A2)');
	await page.mouse.up();
	await expect(bar).toBeFocused();
	await expect(cells.nth(2)).toHaveText('—');
	await bar.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
	await expect(bar).toHaveText('=SUM()');
	await drag(page, cells.nth(3), cells.nth(0));
	await expect(bar).toHaveText('=SUM(A1:A2)');
	await cells.nth(3).click();
	await expect(bar).toHaveText('=SUM(A2)');
	await bar.press('Enter');
	await expect(cells.nth(2)).toHaveText('20');
});

test('inline formulas accept rectangular and single-cell references while preserving the editing cell', async ({ page }) => {
	const cells = page.getByRole('gridcell');
	await cells.nth(2).dblclick();
	const editor = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await editor.fill('=SUM()');
	await editor.press('ArrowLeft');
	await drag(page, cells.nth(0), cells.nth(4));
	await expect(editor).toHaveText('=SUM(A1:B2)');
	await expect(editor).toBeFocused();
	await editor.press('Enter');
	await expect(cells.nth(2)).toHaveText('30');
	// Selecting formula text must remain possible inside the grid's cell-selection surface.
	await cells.nth(2).dblclick();
	const reference = editor.locator('.formula-token-reference');
	await expect(reference).toHaveText('A1:B2');
	const bounds = await reference.boundingBox();
	if (!bounds) throw new Error('Reference text is not visible');
	await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('A1:B2');
	await page.keyboard.type('10');
	await expect(editor).toHaveText('=SUM(10)');
	await editor.press('Enter');
	await expect(cells.nth(2)).toHaveText('10');
	await cells.nth(5).dblclick();
	await editor.fill('=IF(A1>5,)');
	await editor.press('ArrowLeft');
	await cells.nth(3).click();
	await expect(editor).toHaveText('=IF(A1>5,A2)');
	await editor.press('Enter');
	await expect(cells.nth(5)).toHaveText('20');
});

test('Escape cancels an in-progress reference drag without discarding the formula draft', async ({ page }) => {
	const cells = page.getByRole('gridcell'), bar = page.getByRole('textbox', { name: 'Cell value or formula', exact: true });
	await cells.nth(2).click();
	await bar.fill('=SUM()');
	await bar.press('ArrowLeft');
	await drag(page, cells.nth(0), cells.nth(3), false);
	await expect(bar).toHaveText('=SUM(A1:A2)');
	await page.keyboard.press('Escape');
	await page.mouse.up();
	await expect(bar).toHaveText('=SUM()');
	await expect(bar).toBeFocused();
	await page.keyboard.type('A1:A2');
	await bar.press('Enter');
	await expect(cells.nth(2)).toHaveText('30');
});

test('dragging near the bottom scrolls through virtual rows and keeps an inline formula mounted', async ({ page }) => {
	const cells = page.getByRole('gridcell'), grid = page.getByRole('grid');
	await cells.nth(2).dblclick();
	const editor = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await editor.fill('=SUM()');
	await editor.press('ArrowLeft');
	const start = await point(cells.nth(0)), bounds = await grid.boundingBox();
	if (!bounds) throw new Error('Grid is not visible');
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x, bounds.y + bounds.height - 4, { steps: 8 });
	await expect.poll(() => grid.evaluate((element) => element.scrollTop)).toBeGreaterThan(1200);
	await expect(editor).toBeAttached();
	await expect(editor).toHaveText(/^=SUM\(A1:A\d+\)$/);
	await page.mouse.up();
	await editor.press('Enter');
	// The edited first row is no longer pinned once the editor closes.
	// Bring it back into the virtual viewport before checking its saved result.
	await grid.evaluate((element) => { element.scrollTop = 0; });
	await expect(page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select row 1', exact: true }) }).getByRole('gridcell').nth(2)).not.toBeEmpty();
});

test('fill handle extends formulas down, across and up with adjusted references', async ({ page }) => {
	const cells = page.getByRole('gridcell');
	await cells.nth(4).dblclick(); // B2
	const editor = page.getByRole('textbox', { name: 'Edit cell value or formula', exact: true });
	await editor.fill('=A2+$A$1');
	await editor.press('Enter');
	await expect(cells.nth(4)).toHaveText('30');
	await cells.nth(4).click();
	await drag(page, page.getByRole('button', { name: 'Drag to fill formulas', exact: true }), cells.nth(10)); // B4
	await expect(cells.nth(7)).toHaveText('40');
	await expect(cells.nth(10)).toHaveText('50');
	await cells.nth(10).click();
	await expect(page.getByRole('textbox', { name: 'Cell value or formula', exact: true })).toHaveText('=A4+$A$1');
	await cells.nth(4).click();
	await drag(page, page.getByRole('button', { name: 'Drag to fill formulas', exact: true }), cells.nth(5)); // C2
	await expect(cells.nth(5)).toHaveText('40');
	await cells.nth(5).click();
	await expect(page.getByRole('textbox', { name: 'Cell value or formula', exact: true })).toHaveText('=B2+$A$1');
	await cells.nth(4).click();
	await drag(page, page.getByRole('button', { name: 'Drag to fill formulas', exact: true }), cells.nth(1)); // B1
	await expect(cells.nth(1)).toHaveText('20');
	await page.getByRole('grid').press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
	await expect(cells.nth(1)).toHaveText('—');
	await page.getByRole('grid').press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
	await expect(cells.nth(1)).toHaveText('20');
	// A cancelled drag must leave the destination unchanged.
	await cells.nth(4).click();
	await drag(page, page.getByRole('button', { name: 'Drag to fill formulas', exact: true }), cells.nth(13), false);
	await page.keyboard.press('Escape');
	await page.mouse.up();
	await expect(cells.nth(13)).toHaveText('—');
	await page.reload();
	await expect(cells.nth(1)).toHaveText('20');
	await expect(cells.nth(10)).toHaveText('50');
});
