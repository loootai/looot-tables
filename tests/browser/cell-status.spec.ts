import { expect, type Route } from '@playwright/test';
import { test } from './authenticated-test';

test('queued dots shimmer softly in grey, active dots shimmer blue, and completion removes the loader', async ({ page }) => {
	const requests: Route[] = [];
	await page.addInitScript(() => localStorage.setItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', contextKey: 'test-context', concurrency: 1 })));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/enrich', (route) => { requests.push(route); });
	await page.goto('/app');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Cell status loaders');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Name,Research\nOne,\nTwo,\nThree,');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
	await page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('enrichable.cloud.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396'); request.onsuccess = () => resolve(request.result); });
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
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Run (\d+ )?unfinished cells?$/ }).click();
	const active = page.locator('[data-cell-status="running"]');
	const queued = page.locator('[data-cell-status="queued"]');
	await expect(active).toHaveCount(1);
	await expect(queued).toHaveCount(2);
	await expect(active.locator('i')).toHaveCount(16);
	await expect(queued.first().locator('i')).toHaveCount(16);
	await expect(active.locator('i').first()).toHaveCSS('background-color', 'rgb(37, 99, 235)');
	const running = await active.evaluate((node) => ({ size: node.getBoundingClientRect().width, color: getComputedStyle(node.firstElementChild!).backgroundColor, animations: node.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSAnimation && animation.animationName === 'cell-status-shimmer').length }));
	expect(running).toEqual({ size: 18, color: 'rgb(37, 99, 235)', animations: 16 });
	// Golden values from the approved preview's three phases, not a new random pattern.
	const preview = [
		{ delay: -3735.1986104755924, peak: .731404727652989, echo: .38140472765298905 },
		{ delay: -4308.736003434198, peak: .8283017513735103, echo: .4783017513735103 },
		{ delay: -4851.24800954169, peak: .9524140267178154, echo: .6024140267178154 },
	];
	const recipe = await active.evaluate((node) => {
		const dot = node.firstElementChild!;
		const css = getComputedStyle(dot);
		const animation = dot.getAnimations().find((animation) => animation instanceof CSSAnimation && animation.animationName === 'cell-status-shimmer')!;
		const effect = animation.effect as KeyframeEffect;
		return { phase: Number((node as HTMLElement).dataset.phase), duration: effect.getTiming().duration, delay: effect.getTiming().delay, offsets: effect.getKeyframes().map((frame) => frame.offset), peak: Number(css.getPropertyValue('--status-peak')), echo: Number(css.getPropertyValue('--status-echo')), gap: getComputedStyle(node).gap, easing: css.animationTimingFunction };
	});
	expect(recipe.duration).toBe(3600);
	expect(recipe.gap).toBe('2.25px');
	expect(recipe.easing).toBe('ease-in-out');
	expect(recipe.offsets).toEqual([0, .08, .15, .23, .34, 1]);
	expect(recipe.delay).toBeCloseTo(preview[recipe.phase].delay, 3);
	expect(recipe.peak).toBeCloseTo(preview[recipe.phase].peak, 6);
	expect(recipe.echo).toBeCloseTo(preview[recipe.phase].echo, 6);
	const waiting = await queued.first().evaluate((node) => ({ animations: node.getAnimations({ subtree: true }).length, colors: [...node.children].map((dot) => getComputedStyle(dot).backgroundColor), intensities: [...node.children].map((dot) => getComputedStyle(dot).opacity) }));
	expect(waiting.animations).toBe(16);
	await expect(queued.first().locator('i').first()).toHaveCSS('animation-duration', '5.4s');
	expect(waiting.colors.every((color) => color === 'rgb(112, 112, 112)')).toBe(true);
	expect(new Set(waiting.intensities).size).toBeGreaterThan(1);
	await requests[0].fulfill({ json: { value: 'Complete 1', meta: {} } });
	await expect(page.getByText('Complete 1', { exact: true })).toBeVisible();
	await expect(active).toHaveCount(1);
	await expect(queued).toHaveCount(1);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect.poll(() => active.evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
	await expect.poll(() => queued.first().evaluate((node) => node.getAnimations({ subtree: true }).length)).toBe(0);
	await expect.poll(() => requests.length).toBe(2);
	await requests[1].fulfill({ json: { value: 'Complete 2', meta: {} } });
	await expect.poll(() => requests.length).toBe(3);
	await requests[2].fulfill({ json: { value: 'Complete 3', meta: {} } });
	await expect(page.locator('.cell-status-loader')).toHaveCount(0);
	expect(await page.pageErrors()).toEqual([]);
});
