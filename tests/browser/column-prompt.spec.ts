import { expect } from '@playwright/test';
import { test } from './authenticated-test';

test('inserts searchable column pills, edits atomically, and preserves templates through compose and save', async ({ page }) => {
	await page.route('**/api/keys/verify', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.addInitScript(() => localStorage.setItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', loootKey: 'test-looot' })));
	await page.goto('/app');
	await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
	await page.getByLabel('Sheet name', { exact: true }).fill('Column references');
	await page.getByLabel('Or paste CSV', { exact: true }).fill('Company,Company domain,A1 notes\nAcme,acme.com,First\nExample,example.com,Second');
	await page.getByRole('button', { name: 'Import', exact: true }).click();
	await page.getByRole('gridcell').first().waitFor();
	await page.getByRole('button', { name: 'Add column', exact: true }).click();
	await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
	await expect(page.getByRole('dialog')).not.toContainText('TypeSafe');
	await expect(page.getByRole('button', { name: 'Add blank column', exact: true })).toHaveCount(0);
	const ask = page.getByRole('textbox', { name: 'Describe the column', exact: true });
	await ask.fill('Research /domain');
	await expect(page.getByRole('option')).toHaveCount(1);
	await expect(page.getByRole('option')).toContainText('Company domain');
	await ask.press('Enter');
	await expect(ask.locator('.column-prompt-pill')).toHaveText('Company domain');
	await ask.press('Backspace'); // Inserted trailing space.
	await ask.press('Backspace'); // Entire reference.
	await expect(ask.locator('.column-prompt-pill')).toHaveCount(0);
	await page.keyboard.type('/company');
	await expect(page.getByRole('option')).toHaveCount(2);
	const before = await page.locator('[role=option][aria-selected=true] .cm-completionLabel').textContent();
	await ask.press('ArrowDown');
	await expect(page.locator('[role=option][aria-selected=true] .cm-completionLabel')).not.toHaveText(before!);
	const chosen = await page.locator('[role=option][aria-selected=true] .cm-completionLabel').textContent();
	await ask.press('Enter');
	await expect(ask.locator('.column-prompt-pill')).toHaveText(chosen!);
	await page.keyboard.type('and /company');
	await page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: /^Company domain$/ }) }).click();
	await expect(ask.locator('.column-prompt-pill')).toHaveCount(2);
	await page.keyboard.type('/a1');
	await expect(page.getByRole('option')).toHaveCount(3);
	await expect(page.locator('[role=option][aria-selected=true] .cm-completionLabel')).toHaveText('A1 notes');
	await page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: /^A1$/ }) }).click();
	for (const [input, reference] of [['A1', '$A$1'], ['$A1', '$A1'], ['A$1', 'A$1'], ['A1:B2', 'A1:B2']]) {
		await page.keyboard.type(`/${input}`);
		if (input === 'A1:B2') await expect(page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: /^\$A\$1:\$B\$2$/ }) })).toBeVisible();
		await page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: new RegExp(`^${reference.replaceAll('$', '\\$')}$`) }) }).click();
	}
	await expect(ask.locator('.column-prompt-pill')).toHaveCount(7);
	await page.keyboard.type('/');
	await expect(page.getByRole('listbox')).toBeVisible();
	await ask.press('Escape');
	await expect(page.getByRole('listbox')).toHaveCount(0);
	await expect(page.getByRole('dialog', { name: 'Add AI column', exact: true })).toBeVisible();
	await ask.press('Backspace');
	let submitted = '';
	await page.route('**/api/compose-column', async (route) => {
		submitted = route.request().postDataJSON().ask;
		await route.fulfill({ json: { name: 'Research', op: { kind: 'ai', prompt: submitted, output: 'text', research: 'none' } } });
	});
	await page.getByRole('button', { name: 'Create column', exact: true }).click();
	const question = page.getByRole('textbox', { name: 'Question', exact: true });
	await expect(question.locator('.column-prompt-pill')).toHaveCount(7);
	expect(submitted).toBe(`Research {{${chosen}}} and {{Company domain}} {{A1}} {{$A$1}} {{$A1}} {{A$1}} {{A1:B2}}`);
	await page.getByRole('button', { name: 'Add without running', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(page.getByRole('columnheader', { name: /Research/ })).toBeVisible();
	const requests: Array<{ row: Record<string, unknown> }> = [];
	await page.route('**/api/enrich', async (route) => {
		requests.push(route.request().postDataJSON());
		await route.fulfill({ json: { value: 'Researched' } });
	});
	await page.getByRole('columnheader').filter({ hasText: 'Research' }).getByRole('button', { name: /Column menu/ }).click();
	await page.getByRole('menuitem', { name: 'Run unfinished cells', exact: true }).click();
	await expect.poll(() => requests.length).toBe(2);
	const second = requests.find((request) => request.row.Company === 'Example')!.row;
	expect(second.A1).toBe('Example');
	expect(second['$A$1']).toBe('Acme');
	expect(second['$A1']).toBe('Example');
	expect(second['A$1']).toBe('Acme');
	expect(second['A1:B2']).toBe('Example\texample.com');
	await expect(page.getByRole('gridcell').filter({ hasText: /^Researched$/ })).toHaveCount(2);
	await page.getByRole('button', { name: 'Column menu for Company domain', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Insert column left', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Blank column', exact: true }).click();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	// A blank column opens for naming; Escape keeps the default name.
	await page.getByRole('textbox', { name: 'Rename column', exact: true }).press('Escape');
	await expect(page.getByRole('columnheader').filter({ hasText: 'New column' })).toHaveCount(1);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(page.getByRole('columnheader').filter({ hasText: 'New column' })).toHaveCount(0);
	await page.getByRole('button', { name: 'Redo', exact: true }).click();
	await expect(page.getByRole('columnheader').filter({ hasText: 'New column' })).toHaveCount(1);
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: 'AI column', exact: true })).toBeVisible();
	await page.getByRole('menuitem', { name: 'Blank column', exact: true }).click();
	await page.getByRole('textbox', { name: 'Rename column', exact: true }).press('Escape');
	await expect(page.getByRole('columnheader').filter({ hasText: /New column/ })).toHaveCount(2);

	expect(await page.pageErrors()).toEqual([]);
});


test('column composition errors stay inside the dialog with the prompt available for retry', async ({ page }) => {
 await page.addInitScript(() => localStorage.setItem('enrichable.settings.v1.account.d499e221f254a1ef943b3a3a600eef1fb9d03d0d55263b586a97d83e1e56f396', JSON.stringify({ openaiKey: 'test-openai', loootKey: 'test-looot' })));
 await page.route('**/api/keys/verify*', route => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
 await page.route('**/api/compose-column', route => route.fulfill({ status: 500, json: { error: 'Company research unavailable' } }));
 await page.goto('/app');
 await page.getByRole('button', { name: 'Import CSV', exact: true }).click();
 await page.getByLabel('Sheet name', { exact: true }).fill('Inline warnings');
 await page.getByLabel('Or paste CSV', { exact: true }).fill('Name\nNikhil');
 await page.getByRole('button', { name: 'Import', exact: true }).click();
 await page.getByRole('gridcell').first().waitFor();
 await page.getByRole('button', { name: 'Add column', exact: true }).click();
 await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
 const prompt = page.getByRole('textbox', { name: 'Describe the column', exact: true });
 await prompt.fill('Worth talking to for my company context.dev?');
 await page.getByRole('button', { name: 'Create column', exact: true }).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Company research unavailable');
 await expect(prompt).toContainText('Worth talking to for my company context.dev?');
 await expect(page.getByText('Company research unavailable', { exact: true })).toHaveCount(1);
 await expect(page.getByRole('button', { name: 'Create column', exact: true })).toBeEnabled();
});
