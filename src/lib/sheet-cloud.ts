'use client';

import { accountHeaders } from './account-storage';
import { observeServerDate } from './server-clock';
import { CloudError, refused, type SheetRemote, type SheetSnapshot } from './sheet-remote';
import type { Row, Sheet } from './types';

type Page = { sheet: Sheet; rows: Row[]; next: number | null };

async function request<T>(path = '', init: RequestInit = {}): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const sent = Date.now();
		const response = await fetch(`/api/sheets${path}`, { ...init, cache: 'no-store', headers: { 'content-type': 'application/json', ...accountHeaders(), ...init.headers } });
		observeServerDate(response.headers.get('date'), sent);
		const data = await response.json();
		// Reads can safely reconnect after a cold database or transient connection failure.
		// Never retry writes automatically: their transaction may already have committed.
		if (response.status === 503 && (!init.method || init.method === 'GET') && attempt === 0) continue;
		if (!response.ok) throw new CloudError(data.error || 'Could not access the shared workspace.', response.status);
		return data as T;
	}
}

const sheetPath = (sheetId: string) => `/${encodeURIComponent(sheetId)}`;

/** Pages of up to 100 rows, each after the first pinned to the first page's revision. */
async function readPages(sheetId: string): Promise<SheetSnapshot> {
	let offset: number | null = 0, sheet: Sheet | undefined;
	const rows: Row[] = [];
	while (offset !== null) {
		const page: Page = await request(`${sheetPath(sheetId)}?offset=${offset}${sheet?.revision ? `&revision=${sheet.revision}` : ''}`);
		sheet = page.sheet; rows.push(...page.rows); offset = page.next;
	}
	return { sheet: sheet!, rows };
}

/** The workspace's sheets through /api/sheets. */
export const cloudSheets: SheetRemote = {
	async list() { return (await request<Array<{ sheet: Sheet }>>()).map((entry) => entry.sheet); },
	async read(sheetId) {
		// A write landing between pages fails the pinned page (409): read the sheet again, up to three times.
		for (let attempt = 0; ; attempt++) {
			try { return await readPages(sheetId); }
			catch (error) {
				if (refused(error, 404)) return null;
				if (!refused(error, 409) || attempt === 2) throw error;
			}
		}
	},
	create: (sheet, rows) => request('', { method: 'POST', body: JSON.stringify({ sheet, rows }) }),
	async patch(patch) {
		try { return await request(sheetPath(patch.sheet.id), { method: 'PATCH', body: JSON.stringify(patch) }); }
		catch (error) { if (refused(error, 409)) return null; throw error; }
	},
	async remove(sheetId, revision) {
		try { await request(`${sheetPath(sheetId)}?revision=${revision}`, { method: 'DELETE' }); return null; }
		catch (error) { if (!refused(error, 409)) throw error; }
		// The server refuses a newer revision and a missing sheet alike; its first page tells them apart.
		try { return (await request<Page>(`${sheetPath(sheetId)}?offset=0`)).sheet.revision ?? null; }
		catch (error) { if (refused(error, 404)) return null; throw error; }
	},
};
