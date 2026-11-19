import { expect } from '@playwright/test';
import { test } from './authenticated-test';

test.setTimeout(240_000);

for (const connected of [false, true]) test(`company and person fields insert to the right (${connected ? 'connected' : 'without keys'})`, async ({ page }) => {
	const requests: Array<{ op: { kind: string; field?: string; domain?: string; name?: string; prompt?: string; research?: string }; row: Record<string, string> }> = [];
	if (connected) await page.addInitScript(() => localStorage.setItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', loootKey: 'test-looot' })));
	await page.route('**/api/enrich', async (route) => {
		const body = route.request().postDataJSON();
		requests.push(body);
		await route.fulfill({ json: { value: body.op.kind === 'ai' ? 'Custom answer' : body.op.kind === 'company' ? 'San Francisco' : 'Engineer' } });
	});
	await page.route('**/api/keys/verify', (route) => route.fulfill({ json: { openai: false, looot: false, typesafe: false, passwordRequired: false } }));
	await page.goto('/app');
	if (!connected) {
		await page.getByRole('dialog').waitFor();
		await page.getByRole('button', { name: 'Close', exact: true }).click();
	}
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Entity fields');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Domain,Name\nAcme,acme.com,Jane Doe\nExample,example.com,John Smith');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	const company = page.getByRole('button', { name: 'Add company field column', exact: true }).first();
	await company.click();
	await page.getByRole('button', { name: 'Address', exact: true }).click();
	await page.getByRole('checkbox', { name: 'City', exact: true }).click();
	await expect(page.getByRole('checkbox', { name: 'City', exact: true })).toBeChecked();
	await expect(page.getByRole('columnheader', { name: /City/ })).toHaveCount(0);
	await page.getByRole('button', { name: 'Choose which rows to run', exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Run on all 2 rows', exact: true }).click();
	await page.getByRole('button', { name: 'Run on all 2 rows, 1 field selected', exact: true }).click();
	await expect(page.getByRole('columnheader').nth(2)).toContainText('City');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await company.click();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(company).toBeFocused();
	await page.getByRole('button', { name: 'Add person field column', exact: true }).first().click();
	await page.getByRole('button', { name: 'Employment', exact: true }).click();
	await page.getByRole('checkbox', { name: 'Job title', exact: true }).click();
	await expect(page.getByRole('checkbox', { name: 'Job title', exact: true })).toBeChecked();
	await expect(page.getByRole('columnheader', { name: /Job title/ })).toHaveCount(0);
	await page.getByRole('button', { name: 'Choose which rows to run', exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Run on all 2 rows', exact: true }).click();
	await page.getByRole('button', { name: 'Run on all 2 rows, 1 field selected', exact: true }).click();
	await expect(page.getByRole('columnheader').nth(5)).toContainText('Job title');
	if (connected) {
		await expect(page.getByRole('gridcell').filter({ hasText: /^San Francisco$/ })).toHaveCount(2, { timeout: 20_000 });
		await expect(page.getByRole('gridcell').filter({ hasText: /^Engineer$/ })).toHaveCount(2, { timeout: 20_000 });
		expect(requests.filter((entry) => entry.op.kind === 'company').map((entry) => entry.row.Domain).sort()).toEqual(['acme.com', 'example.com']);
		expect(requests.find((entry) => entry.op.kind === 'company')?.op).toMatchObject({ field: 'city', domain: '{{Domain}}' });
		expect(requests.find((entry) => entry.op.kind === 'person')?.op).toMatchObject({ field: 'title', name: '{{Name}}' });
	}
	for (const kind of ['company', 'person']) {
		await page.getByRole('button', { name: `Add ${kind} field column`, exact: true }).first().click();
		const query = page.getByRole('textbox', { name: 'Custom query', exact: true });
		await expect(query).toHaveJSProperty('tagName', 'TEXTAREA');
		await expect.poll(async () => (await query.boundingBox())?.height).toBe(64);
		await query.fill('Line one\nLine two\nLine three\nLine four\nLine five');
		await expect.poll(async () => (await query.boundingBox())?.height).toBe(124);
		await query.press('End');
		await query.press('Enter');
		await query.pressSequentially('Line six');
		expect((await query.boundingBox())?.height).toBe(124);
		expect(await query.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
		await query.fill('A long query that wraps onto multiple lines. '.repeat(8));
		expect((await query.boundingBox())?.height).toBe(124);
		await query.fill('');
		await expect.poll(async () => (await query.boundingBox())?.height).toBe(64);
		const defaultRun = page.getByRole('button', { name: /^Run on all 2 rows,/ });
		await expect(defaultRun).toBeEnabled();
		await defaultRun.click();
		await expect(query).toBeFocused();
		await expect(query).toHaveValue('');
		await expect(page.locator('[data-query-placeholder]')).toHaveAttribute('style', /query-placeholder-shake/);
		await expect(page.getByRole('dialog')).toBeVisible();
		await query.fill('   ');
		await expect(defaultRun).toBeEnabled();
		await defaultRun.click();
		await expect(query).toBeFocused();
		await expect(query).toHaveValue('');
		await expect(page.locator('[data-query-placeholder]')).toHaveAttribute('style', /query-placeholder-shake/);
		await expect(page.getByRole('dialog')).toBeVisible();
		// The query remains available when browsing a nested field group.
		const menuBox = await page.getByRole('dialog').boundingBox();
		const queryBox = await query.boundingBox();
		await page.getByRole('button', { name: kind === 'company' ? 'Brand' : 'Employment', exact: true }).click();
		expect(await page.getByRole('dialog').boundingBox()).toEqual(menuBox);
		expect(await query.boundingBox()).toEqual(queryBox);
		await query.fill(`What is this ${kind} known for?`);
		await page.getByRole('button', { name: 'Choose which rows to run', exact: true }).click();
		await expect(page.getByRole('menuitemradio', { name: 'Run on 10 rows', exact: true })).toHaveCount(0);
		await expect(page.getByRole('menuitemradio', { name: 'Run on 100 rows', exact: true })).toHaveCount(0);
		if (kind === 'company') {
			await page.getByRole('menuitemradio', { name: 'Run on all 2 rows', exact: true }).click();
		} else await page.getByRole('menuitemradio', { name: 'Run on this row', exact: true }).click();
		if (kind === 'company') await page.getByRole('button', { name: /^Run on all 2 rows,/ }).click();
		else await page.getByRole('button', { name: /^Run on this row,/ }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.getByRole('columnheader', { name: new RegExp(`What is this ${kind} known for`) })).toBeVisible();
		if (connected) {
			await expect.poll(() => requests.filter((entry) => entry.op.kind === 'ai').length).toBe(kind === 'company' ? 2 : 3);
			const op = requests.filter((entry) => entry.op.kind === 'ai').at(-1)?.op;
			expect(op?.prompt).toContain(kind === 'company' ? '{{Company}}' : '{{Name}}');
			expect(op?.prompt).toContain(`What is this ${kind} known for?`);
			expect(op?.research).toBe('web');
		}
	}
	if (connected) {
		const headers = await page.getByRole('columnheader').allTextContents();
		const column = headers.findIndex((text) => text.includes('What is this person known for?')) - 1;
		const width = headers.length - 1; // Exclude the row-number header.
		const source = page.getByRole('gridcell').nth(column);
		const below = page.getByRole('gridcell').nth(width + column);
		await expect(source).toHaveText('Custom answer');
		await expect(below).toBeEmpty();
		await source.click();
		const handle = page.getByRole('button', { name: 'Drag to run enrichment', exact: true });
		await handle.scrollIntoViewIfNeeded();
		let start = await handle.boundingBox();
		const nextColumn = await page.getByRole('gridcell').nth(column - 1).boundingBox();
		if (!start || !nextColumn) throw new Error('Missing fill handle');
		await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
		await page.mouse.down();
		await page.mouse.move(nextColumn.x + nextColumn.width / 2, nextColumn.y + nextColumn.height / 2, { steps: 5 });
		await page.mouse.up();
		expect(requests.filter((entry) => entry.op.kind === 'ai')).toHaveLength(3);
		await source.click();
		await handle.scrollIntoViewIfNeeded();
		start = await handle.boundingBox();
		const end = await below.boundingBox();
		if (!start || !end) throw new Error('Missing destination');
		await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
		await page.mouse.down();
		await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 5 });
		await page.mouse.up();
		await expect(below).toHaveText('Custom answer');
		const custom = requests.filter((entry) => entry.op.kind === 'ai');
		expect(custom).toHaveLength(4);
		expect(custom.at(-1)?.row.Name).toBe('John Smith');
	}
	await page.getByRole('button', { name: 'Add person field column', exact: true }).last().click();
	await expect(page.getByRole('button', { name: 'Choose which rows to run', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.reload();
	await expect(page.getByRole('columnheader', { name: /City/ })).toBeVisible();
	await expect(page.getByRole('columnheader', { name: /Job title/ })).toBeVisible();
	expect(await page.pageErrors()).toEqual([]);
});

test('run scopes offer 10, 100 and all remaining cells and execute only the chosen count', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', loootKey: 'test-looot' })));
	await page.route('**/api/keys/verify', (route) => route.fulfill({ json: { openai: false, looot: false, typesafe: false, passwordRequired: false } }));
	const companies: string[] = [];
	await page.route('**/api/enrich', async (route) => {
		companies.push(route.request().postDataJSON().row.Company);
		await route.fulfill({ json: { value: 'Answer' } });
	});
	await page.goto('/app');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Run scopes');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Domain\n' + Array.from({ length: 102 }, (_, i) => `Company ${i + 1},company${i + 1}.com`).join('\n'));
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.setViewportSize({ width: 1360, height: 500 });
	await page.getByRole('button', { name: 'Add company field column', exact: true }).first().click();
	await page.getByRole('textbox', { name: 'Custom query', exact: true }).fill('What does this company do?');
	await page.getByRole('button', { name: 'Choose which rows to run', exact: true }).click();
	await expect(page.getByRole('button', { name: /^Run on this row,/ })).toBeVisible();
	await expect(page.getByRole('menuitemradio', { name: 'Run on this row', exact: true })).toBeVisible();
	const scopeBox = await page.getByRole('menu', { name: 'Run scope', exact: true }).boundingBox();
	const triggerBox = await page.getByRole('button', { name: 'Choose which rows to run', exact: true }).boundingBox();
	expect(scopeBox).not.toBeNull();
	expect(triggerBox).not.toBeNull();
	expect(scopeBox!.y).toBeGreaterThanOrEqual(8);
	expect(scopeBox!.y + scopeBox!.height).toBeLessThanOrEqual(triggerBox!.y);
	await expect(page.getByRole('menuitemradio', { name: 'Run on 100 rows', exact: true })).toBeVisible();
	await expect(page.getByRole('menuitemradio', { name: 'Run on all 102 rows', exact: true })).toBeVisible();
	await page.getByRole('menuitemradio', { name: 'Run on 10 rows', exact: true }).click();
	await page.getByRole('button', { name: /^Run on 10 rows,/ }).click();
	await expect.poll(() => companies.length, { timeout: 30_000 }).toBe(10);
	expect(companies).toEqual(Array.from({ length: 10 }, (_, i) => `Company ${i + 1}`));
	await expect(page.getByRole('gridcell').filter({ hasText: /^Answer$/ })).toHaveCount(10, { timeout: 30_000 });
	await page.setViewportSize({ width: 1360, height: 900 });
	await page.reload();
	await page.getByRole('button', { name: 'Add company field column', exact: true }).first().click();
	await expect(page.getByRole('button', { name: /^Run on 10 rows,/ })).toBeVisible();
	await page.getByRole('button', { name: 'Choose which rows to run', exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Run on 100 rows', exact: true }).click();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Add company field column', exact: true }).nth(3).click();
	await expect(page.getByRole('button', { name: /^Run on 99 rows,/ })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Add company field column', exact: true }).first().click();
	await expect(page.getByRole('button', { name: /^Run on 100 rows,/ })).toBeVisible();
	await page.getByRole('button', { name: 'Choose which rows to run', exact: true }).click();
	await page.getByRole('menuitemradio', { name: 'Run on all 102 rows', exact: true }).click();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Add company field column', exact: true }).nth(1).click();
	await expect(page.getByRole('button', { name: /^Run on all 102 rows,/ })).toBeVisible();
	await page.getByRole('textbox', { name: 'Custom query', exact: true }).fill('Describe the whole column');
	companies.length = 0;
	await page.getByRole('button', { name: /^Run on all 102 rows,/ }).click();
	await expect.poll(() => companies.length, { timeout: 180_000 }).toBe(102);
	expect(companies).toContain('Company 1');
	expect(companies).toContain('Company 102');
});
