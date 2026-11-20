import { test, expect, type Page } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { ColumnOp, Row, Sheet } from '../../src/lib/types';

async function mockSheet(page: Page) {
	const state: { sheet: Sheet; enriched: number } = { sheet: { id: 'lists', name: 'Accounts', revision: 1, columns: [{ id: 'company', name: 'Company', type: 'source', width: 220, createdAt: 1 }], filters: [], sort: null, createdAt: 1, updatedAt: 1 }, enriched: 0 };
	const rows: Row[] = Array.from({ length: 15 }, (_, order) => ({ id: `row-${order}`, sheetId: 'lists', order, createdAt: 1, cells: { company: { v: `Company ${order + 1}`, s: 'done' as const, t: 1 } } }));
	await page.route('**/api/organization-settings', (route) => route.fulfill({ json: { local: true } }));
	await page.route('**/api/looot/balance*', (route) => route.fulfill({ json: { available: 5, reserved: 0 } }));
	await page.route('**/api/openai/usage*', (route) => route.fulfill({ json: { enabled: false } }));
	await page.route('**/api/keys/verify*', (route) => route.fulfill({ json: { openai: true, context: true, typesafe: false, passwordRequired: false } }));
	await page.route('**/api/enrich', (route) => { state.enriched += 1; return route.fulfill({ json: { value: 'Answer' } }); });
	await page.route('**/api/sheets**', async (route) => {
		if (route.request().method() === 'PATCH') {
			state.sheet = { ...route.request().postDataJSON().sheet, revision: state.sheet.revision! + 1 };
			return route.fulfill({ json: { revision: state.sheet.revision, updatedAt: Date.now() } });
		}
		await route.fulfill({ json: new URL(route.request().url()).pathname === '/api/sheets' ? [{ sheet: state.sheet, rowCount: rows.length }] : { sheet: state.sheet, rows, next: null } });
	});
	return state;
}

async function openSetup(page: Page) {
	await page.getByRole('button', { name: 'Add column', exact: true }).click();
	await page.getByRole('menuitem', { name: 'AI column', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Add AI column', exact: true });
	await dialog.getByRole('button', { name: 'Configure manually', exact: true }).click();
	return dialog;
}

test.beforeEach(async ({ context, baseURL }) => {
	await context.addCookies([{ name: 'looot-tables-session', value: memberCookie('column-lists'), url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
});

test('option, level, domain and number inputs keep what is typed', async ({ page }) => {
	const state = await mockSheet(page);
	const saved = (name: string) => state.sheet.columns.find((column) => column.name === name)?.op as ColumnOp | undefined;
	await page.goto('/app/sheets/lists');

	let dialog = await openSetup(page);
	await dialog.getByRole('radio', { name: 'Classify', exact: true }).click();
	await dialog.getByRole('radio', { name: 'Category', exact: true }).click();
	await dialog.getByRole('textbox', { name: 'Question', exact: true }).fill('How well does {{Company}} fit?');
	const first = dialog.getByLabel('Option 1', { exact: true });
	await first.pressSequentially('Strong fit:');
	await expect(first).toHaveValue('Strong fit:');
	await first.press('Backspace');
	await dialog.getByLabel('Option 1 description', { exact: true }).pressSequentially('B2B SaaS, 50-500 employees');
	await first.press('Enter');
	await expect(dialog.getByLabel('Option 2', { exact: true })).toBeFocused();
	await page.keyboard.type('Weak fit');
	await page.keyboard.press('Enter');
	await expect(dialog.getByLabel('Option 3', { exact: true })).toBeFocused();
	await page.keyboard.type('Unknown');
	await dialog.getByLabel('Column name', { exact: true }).fill('Fit');
	await dialog.getByRole('button', { name: 'Add without running', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(saved('Fit')).toMatchObject({ kind: 'classify', options: [{ label: 'Strong fit', description: 'B2B SaaS, 50-500 employees' }, { label: 'Weak fit' }, { label: 'Unknown' }] });

	dialog = await openSetup(page);
	await dialog.getByRole('radio', { name: 'Classify', exact: true }).click();
	await dialog.getByRole('radio', { name: 'Score', exact: true }).click();
	await dialog.getByRole('textbox', { name: 'Question', exact: true }).fill('How mature is {{Company}}?');
	await dialog.getByRole('button', { name: 'Add level', exact: true }).click();
	await expect(dialog.getByLabel('Level 4', { exact: true })).toBeFocused();
	await page.keyboard.type('Leader');
	await expect(dialog.getByLabel('Column name', { exact: true })).toHaveValue('Score');
	await dialog.getByRole('button', { name: 'Add without running', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(saved('Score')).toMatchObject({ kind: 'score', levels: ['Low', 'Medium', 'High', 'Leader'] });

	dialog = await openSetup(page);
	await dialog.getByRole('radio', { name: 'Web page', exact: true }).click();
	await dialog.getByRole('radio', { name: 'Web search', exact: true }).click();
	await dialog.getByRole('textbox', { name: 'Search query', exact: true }).fill('{{Company}} funding');
	const domains = dialog.getByLabel('Only these domains', { exact: true });
	await domains.pressSequentially('linkedin.com, crunchbase.com');
	await expect(domains).toHaveValue('linkedin.com, crunchbase.com');
	const results = dialog.getByLabel('Results', { exact: true });
	await results.fill('');
	await expect(results).toHaveValue('');
	await results.press('Tab');
	await expect(results).toHaveValue('3');
	await results.fill('25');
	await results.press('Tab');
	await expect(results).toHaveValue('10');
	await dialog.getByRole('button', { name: 'Add without running', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(saved('Search result')).toMatchObject({ kind: 'search', includeDomains: ['linkedin.com', 'crunchbase.com'], numResults: 10 });
	expect(state.enriched).toBe(0);
	expect(await page.pageErrors()).toEqual([]);
});

test('a big run states its cost and waits for confirmation', async ({ page }) => {
	const state = await mockSheet(page);
	await page.goto('/app/sheets/lists');
	const dialog = await openSetup(page);
	await dialog.getByRole('radio', { name: 'Deep research', exact: true }).click();
	await dialog.getByRole('textbox', { name: 'Research task', exact: true }).fill('Latest funding round for {{Company}}');
	await dialog.getByRole('combobox', { name: 'Depth', exact: true }).click();
	await page.getByRole('option', { name: /^Ultra/ }).click();
	await dialog.getByRole('button', { name: 'Choose which rows to run' }).click();
	await page.getByRole('menuitemradio', { name: 'Run on all 15 rows', exact: true }).click();
	await dialog.getByRole('button', { name: 'Run on all 15 rows', exact: true }).click();
	await expect(dialog.getByRole('status').filter({ hasText: 'Run 15 cells?' })).toContainText('~15 cells × ~100 credits ≈ 1,500 credits');
	await dialog.getByRole('button', { name: 'Back', exact: true }).click();
	await expect(dialog.getByRole('button', { name: 'Run on all 15 rows', exact: true })).toBeVisible();
	expect(state.enriched).toBe(0);
	await dialog.getByRole('button', { name: 'Run on all 15 rows', exact: true }).click();
	await dialog.getByRole('button', { name: 'Run 15 cells', exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect.poll(() => state.enriched).toBe(15);
});
