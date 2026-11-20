import { expect, type Page } from '@playwright/test';
import { test } from './authenticated-test';

async function sheet(page: Page) {
	await page.addInitScript(() => localStorage.setItem('looot-tables.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', loootKey: 'test-looot' })));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/logos/resolve', (route) => route.fulfill({ json: { domain: null } }));
	await page.goto('/app');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Live row arrival');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Domain,Industry\nExisting,existing.example,Software');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
	await page.getByRole('button', { name: 'Find rows', exact: true }).click();
	await page.getByLabel('Describe the rows you want', { exact: true }).fill('Developer tool companies');
}

test.afterEach(async ({ page }) => { expect(await page.pageErrors()).toEqual([]); });

test('Find rows hides the dialog while running, persists a deduped burst, and reports it once', async ({ page }) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	await page.route('**/api/populate', async (route) => {
		await gate;
		const rows = Array.from({ length: 30 }, (_, i) => ({ Company: `Result ${i}`, Domain: `result-${i}.example` }));
		await route.fulfill({ contentType: 'application/x-ndjson', body: [
			{ type: 'rows', rows, key: 'Domain' },
			{ type: 'rows', rows: rows.slice(0, 2), key: 'Domain' },
			{ type: 'done', total: 30 },
		].map((event) => JSON.stringify(event)).join('\n') + '\n' });
	});
	await sheet(page);
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const pending = page.getByRole('row', { name: /^Finding row/ });
	await expect(pending).toHaveCount(3);
	const columns = await page.getByRole('columnheader').count() - 1;
	await expect(pending.nth(0).locator('.row-loading')).toHaveCount(columns);
	await expect(pending.nth(1).locator('.row-loading')).toHaveCount(2);
	await expect(pending.nth(2).locator('.row-loading')).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Stop finding rows', exact: true })).toBeVisible();
	release();
	await expect(page.getByText('Added 30 companies', { exact: true })).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Find rows', exact: true })).toBeEnabled({ timeout: 12000 });
	await expect(pending).toHaveCount(0);
	await expect(page.getByText('31 rows ·', { exact: false })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await page.reload();
	await expect(page.getByText('31 rows ·', { exact: false })).toBeVisible();
});

test('a stream failure removes the loading cells and lets the user retry', async ({ page }) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	await page.route('**/api/populate', async (route) => {
		await gate;
		await route.fulfill({ status: 500, json: { error: 'Search unavailable' } });
	});
	await sheet(page);
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Stop finding rows', exact: true })).toBeVisible();
	release();
	await expect(page.getByRole('dialog')).toBeVisible();
	await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Search unavailable');
	await expect(page.getByLabel('Describe the rows you want', { exact: true })).toHaveValue('Developer tool companies');
	await expect(page.getByText('Search unavailable', { exact: true })).toHaveCount(1);
	await expect(page.getByRole('row', { name: /^Finding row/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Find companies', exact: true })).toBeEnabled();
	await page.route('**/api/populate', (route) => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'done', total: 0 }) + '\n' }));
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	// No matches is not a silent close: the dialog comes back with the prompt and a way forward.
	await expect(page.getByRole('dialog').getByRole('status')).toHaveText('No companies matched. Try a broader description.');
	await expect(page.getByLabel('Describe the rows you want', { exact: true })).toHaveValue('Developer tool companies');
});

test('a stream cut off before the server finishes is an error, not a success', async ({ page }) => {
	await page.route('**/api/populate', (route) => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'rows', rows: [{ Company: 'Partial', Domain: 'partial.example' }], key: 'Domain' }) + '\n' }));
	await sheet(page);
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	await expect(page.getByRole('dialog').getByRole('alert')).toContainText('The connection closed before Find rows finished, after 1 row');
	await expect(page.getByText('Added', { exact: false })).toHaveCount(0);
	await expect(page.getByText('2 rows ·', { exact: false })).toBeVisible();
});

test('an open stream animates text, meters rows, and preserves pacing on completion', async ({ page }) => {
	await page.addInitScript(() => {
		const originalFetch = window.fetch.bind(window);
		let stream: ReadableStreamDefaultController<Uint8Array>;
		Object.assign(window, {
			discoveryTest: {
				get ready() { return Boolean(stream); },
				send(rows: Array<Record<string, string>>) { stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'rows', rows, key: 'Domain' }) + '\n')); },
				finish() { stream.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'done', total: 40 }) + '\n')); stream.close(); },
			},
		});
		window.fetch = async (input, init) => {
			if (String(input) !== '/api/populate') return originalFetch(input, init);
			return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
		};
	});
	await sheet(page);
	await page.getByRole('button', { name: 'Find companies', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	const send = (prefix: string) => page.evaluate((prefix) => {
		(window as unknown as { discoveryTest: { send: (rows: Array<Record<string, string>>) => void } }).discoveryTest.send(Array.from({ length: 20 }, (_, i) => ({ Company: `${prefix} ${i}`, Domain: `${prefix}-${i}.example` })));
	}, prefix);
	const firstSlot = page.locator('[data-arrival-slot="1"]');
	await firstSlot.evaluate((node) => {
		Object.assign(window, { loadingCellBeforeArrival: node.querySelector('[role="gridcell"]'), loadingDotsBeforeArrival: node.querySelector('.row-loading') });
	});
	await page.waitForFunction(() => (window as unknown as { discoveryTest: { ready: boolean } }).discoveryTest.ready);
	await send('First');
	await expect(page.getByText('21 rows ·', { exact: false })).toBeVisible();
	expect(await firstSlot.evaluate((node) => {
		const previous = window as unknown as { loadingCellBeforeArrival: Element; loadingDotsBeforeArrival: Element };
		return node.querySelector('[role="gridcell"]') === previous.loadingCellBeforeArrival && node.querySelector('.row-loading') === previous.loadingDotsBeforeArrival;
	})).toBe(true);
	await expect(firstSlot.locator('[data-entity-visible-label]').filter({ hasText: /^First 0$/ })).toBeVisible();
	// The triangle advances on the first cell's text reveal, not the last column.
	const nextSlot = page.locator('[data-arrival-slot="2"]');
	await expect(nextSlot).toHaveAttribute('data-loading-frontier', 'head');
	const textHandoff = await firstSlot.locator('.row-arrival-text').first().evaluate((node) => {
		const animation = node.getAnimations()[0];
		return { started: Number(animation.currentTime) >= Number(animation.effect?.getTiming().delay), loaderVisible: node.previousElementSibling!.querySelectorAll('.row-loading-reveal').length === 57 };
	});
	expect(textHandoff.started).toBe(true);
	expect(textHandoff.loaderVisible).toBe(true);
	await expect(nextSlot).toHaveAttribute('aria-label', 'Finding row 3');
	await expect(page.locator('[data-arrival-slot="3"] .row-loading')).toHaveCount(2);
	await expect(page.locator('[data-arrival-slot="4"] .row-loading')).toHaveCount(1);
	const expansion = await nextSlot.locator('.row-arrival-dots').nth(3).evaluate((node) => node.getAnimations().map((animation) => animation.effect?.getTiming()));
	expect(expansion.some((value) => value?.delay === 100 && value.duration === 130)).toBe(true);

	const dotsTiming = await firstSlot.locator('.row-arrival-dots').first().evaluate((node) => node.getAnimations().map((animation) => animation.effect?.getTiming()));
	expect(dotsTiming.some((value) => value?.duration === 240)).toBe(true);
	const visibleRows = page.locator('[role="row"][aria-selected]');
	const initial = await visibleRows.count();
	expect(initial).toBeLessThan(10);
	const animated = page.locator('.row-arrival-text').first();
	await expect(animated).toBeVisible();
	const timing = await animated.evaluate((node) => node.getAnimations().map((animation) => animation.effect?.getTiming()));
	expect(timing.some((value) => value?.duration === 520)).toBe(true);
	await page.waitForTimeout(1000);
	const afterOneSecond = await visibleRows.count();
	const alignment = await firstSlot.evaluate((node) => [...node.querySelectorAll('[role="gridcell"]')].slice(0, 2).map((cell) => {
		const dots = cell.querySelector('.row-loading')!.getBoundingClientRect();
		const text = cell.querySelector('.row-arrival-text')!.getBoundingClientRect();
		const content = cell.getBoundingClientRect();
		return { leftDelta: dots.left - text.left, centerDelta: (dots.top + dots.height / 2) - (text.top + text.height / 2), inset: dots.left - content.left, textRight: text.right, cellRight: content.right };
	}));
	for (const cell of alignment) {
		expect(Math.abs(cell.leftDelta)).toBeLessThan(1);
		expect(Math.abs(cell.centerDelta)).toBeLessThan(1);
		expect(cell.inset).toBeCloseTo(12, 0);
		expect(cell.textRight).toBeLessThanOrEqual(cell.cellRight);
	}

	expect(afterOneSecond).toBeGreaterThan(initial);
	expect(afterOneSecond).toBeLessThan(21);
	await expect(page.getByRole('button', { name: 'Stop finding rows', exact: true })).toBeVisible();
	await send('Second');
	await expect(page.getByText('41 rows ·', { exact: false })).toBeVisible();
	await page.evaluate(() => (window as unknown as { discoveryTest: { finish: () => void } }).discoveryTest.finish());
	await page.waitForTimeout(1000);
	await expect(page.getByRole('row', { name: /^Finding row/ })).toHaveCount(3);
	await expect(page.getByRole('button', { name: 'Find rows', exact: true })).toBeEnabled({ timeout: 12000 });
	await expect(page.getByRole('row', { name: /^Finding row/ })).toHaveCount(0);
});


test('streamed errors without a trailing newline stay inline and preserve the prompt', async ({ page }) => {
 await page.route('**/api/populate', route => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'error', message: 'Could not research this company' }) }));
 await sheet(page);
 await page.getByRole('button', { name: 'Find companies', exact: true }).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Could not research this company');
 await page.screenshot({ path: '/tmp/looot-tables-inline-company-warning.png' });
 await expect(page.getByLabel('Describe the rows you want', { exact: true })).toHaveValue('Developer tool companies');
 await expect(page.getByRole('button', { name: 'Find companies', exact: true })).toBeEnabled();
});


test('closing during collapse leaves discovery running', async ({ page }) => {
 let release!: () => void;
 const gate = new Promise<void>((resolve) => { release = resolve; });
 await page.route('**/api/populate', async (route) => {
  await gate;
  await route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'rows', rows: [{ Company: 'Still running', Domain: 'still-running.example' }], key: 'Domain' }, { type: 'done', total: 1 }].map((event) => JSON.stringify(event)).join('\n') + '\n' });
 });
 await sheet(page);
 // Close before the collapse animation finishes.
 await page.getByRole('button', { name: 'Find companies', exact: true }).evaluate((button) => {
  (button as HTMLButtonElement).click();
 });
 await page.getByRole('button', { name: 'Close', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('button', { name: 'Stop finding rows', exact: true })).toBeVisible();
 release();
 await expect(page.getByText('2 rows ·', { exact: false })).toBeVisible();
 await expect(page.getByText('Added 1 company', { exact: true })).toBeVisible();
});

test('prompt grows to ten lines and countries are searchable with multiple selections', async ({ page }) => {
	await sheet(page);
	const prompt = page.getByLabel('Describe the rows you want', { exact: true });
	const initial = await prompt.evaluate((node) => (node as HTMLTextAreaElement).offsetHeight);
	await prompt.fill(Array.from({ length: 6 }, (_, i) => `Line ${i}`).join('\n'));
	const grown = await prompt.evaluate((node) => (node as HTMLTextAreaElement).offsetHeight);
	expect(grown).toBeGreaterThan(initial);
	await prompt.fill(Array.from({ length: 15 }, (_, i) => `Line ${i}`).join('\n'));
	const dimensions = await prompt.evaluate((node) => {
		const style = getComputedStyle(node);
		return { height: node.clientHeight, line: parseFloat(style.lineHeight), padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), scroll: node.scrollHeight, resize: style.resize, mask: style.maskImage };
	});
	expect(dimensions.height).toBeLessThanOrEqual(dimensions.line * 10 + dimensions.padding + 1);
	expect(dimensions.scroll).toBeGreaterThan(dimensions.height);
	expect(dimensions.resize).toBe('none');
	expect(dimensions.mask).toContain('linear-gradient');
	await prompt.fill('Short prompt');
	expect(await prompt.evaluate((node) => (node as HTMLTextAreaElement).offsetHeight)).toBe(initial);
	await page.getByLabel('Countries', { exact: true }).click();
	await page.getByRole('textbox', { name: 'Search countries' }).fill('Japan');
	await page.getByRole('checkbox', { name: /Japan/ }).check();
	await page.getByRole('textbox', { name: 'Search countries' }).fill('Brazil');
	await page.getByRole('checkbox', { name: /Brazil/ }).check();
	await page.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(page.getByLabel('Countries', { exact: true })).toHaveText('Japan, Brazil');
});

test('composer reads the count from the prompt, shows the cap inline, and blocks requests over 100', async ({ page }) => {
	await page.route('**/api/populate', (route) => route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'done', total: 0 }) + '\n' }));
	await sheet(page);
	const dialog = page.getByRole('dialog');
	await expect(dialog.locator('.populate-summary')).toHaveText('20 companies · up to 100');
	await expect(dialog.getByLabel('Limit', { exact: true })).toHaveCount(0);
	await expect(dialog.getByLabel('Countries', { exact: true })).toHaveText('Any country');
	const prompt = page.getByLabel('Describe the rows you want', { exact: true });
	await prompt.fill('Find me 101 companies');
	await expect(dialog.getByRole('alert')).toHaveText('Only 100 at a time. Ask for 100 or fewer.');
	await expect(prompt).toHaveAttribute('aria-describedby', /.+/);
	await expect(dialog.locator('.populate-front')).toHaveCSS('border-radius', '22px');
	await expect(dialog.locator('.populate-error')).toHaveCSS('display', 'flex');
	await dialog.screenshot({ path: '/tmp/looot-tables-composer-implemented.png' });
	await expect(dialog.getByRole('button', { name: 'Find companies' })).toBeDisabled();
	await prompt.fill('Find 100 companies');
	await expect(dialog.getByRole('alert')).toHaveCount(0);
	await expect(dialog.locator('.populate-summary')).toHaveText('100 companies · up to 100');
	await expect(dialog.getByRole('button', { name: 'Find companies' })).toBeEnabled();
	await prompt.fill('Find me 80 companies');
	const request = page.waitForRequest('**/api/populate');
	await dialog.getByRole('button', { name: 'Find companies' }).click();
	expect((await request).postDataJSON().target).toBe(80);
});
