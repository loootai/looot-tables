import { expect, test } from '@playwright/test';
import { memberCookie } from './authenticated-test';
import type { Row, Sheet } from '../../src/lib/types';

test('outdated results show refresh without hover and return to hover-only play after refreshing', async ({ page, context, baseURL }) => {
	const cookie = memberCookie('browser-user');
	const account = JSON.parse(Buffer.from(cookie.split('.')[0], 'base64url').toString()).value;
	await context.addCookies([{ name: 'looot-tables-session', value: cookie, url: baseURL!, httpOnly: true, sameSite: 'Lax' }]);
	let sheet: Sheet = { id: 'freshness-sheet', name: 'Freshness', revision: 1, columns: [
		{ id: 'input', name: 'Computed', type: 'source', width: 220, createdAt: 0 },
		{ id: 'output', name: 'Research', type: 'enriched', op: { kind: 'search', query: '{{Computed}}', pick: 'snippet', numResults: 1 }, width: 240, createdAt: 0 },
	], filters: [], sort: null, createdAt: 0, updatedAt: 0 };
	let rows: Row[] = [{ id: 'row', sheetId: sheet.id, order: 0, createdAt: 0, cells: { input: { v: 'new-tail', s: 'done', f: '="new-tail"', t: 20 }, output: { v: 'Old result', s: 'done', t: 10 } } }];
	await context.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: unknown = {};
		if (path === '/api/auth/session') data = account;
		else if (path === '/api/sheets') data = [{ sheet, rowCount: rows.length }];
		else if (path === `/api/sheets/${sheet.id}`) {
			if (route.request().method() === 'PATCH') {
				const patch = route.request().postDataJSON();
				sheet = { ...patch.sheet, revision: sheet.revision! + 1 };
				for (const row of patch.rows) rows = rows.map(current => current.id === row.id ? row : current);
				data = { revision: sheet.revision, updatedAt: sheet.updatedAt };
			} else data = { sheet, rows, next: null };
		} else if (path === '/api/organization-settings') data = { local: true };
		else if (path === '/api/keys/verify') data = { openai: true, context: true, typesafe: false, passwordRequired: false };
		else if (path === '/api/realtime' || path === '/api/enrichment/usage') data = { enabled: false };
		else if (path === '/api/context/usage') data = { credits: 100, used: 0 };
		else if (path === '/api/enrich') data = { value: 'Fresh result' };
		await route.fulfill({ json: data });
	});
	await page.goto(`/app/sheets/${sheet.id}`);
	await page.mouse.move(0, 0);
	const refresh = page.getByRole('button', { name: 'Refresh Research for row 1' });
	await expect(refresh).toBeVisible();
	await expect(refresh).toHaveCSS('opacity', '1');
	await expect(refresh).toHaveAttribute('title', 'Inputs changed. Refresh this cell.');
	await page.reload();
	await expect(refresh).toHaveCSS('opacity', '1');
	await refresh.click();
	await expect(page.getByRole('gridcell').filter({ hasText: 'Fresh result' })).toBeVisible();
	await expect(refresh).toHaveCount(0);
	await page.mouse.move(0, 0);
	await page.getByRole('button', { name: 'Run Research for row 1' }).evaluate(element => (element as HTMLElement).blur());
	await expect(page.getByRole('button', { name: 'Run Research for row 1' })).toHaveCSS('opacity', '0');
});
