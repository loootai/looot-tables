import 'server-only';
import { createRealtime, rawSql } from '@neon/realtime/server';
import type { Account } from '../auth-identity';
import type { Collaborator, LiveSheetEntry } from '../collaboration';
import { configuredUrl } from './deployment';
import { workspaceId } from './database';
import { collaboratorIdentity } from './workspace-store';

export const WORKSPACE_LIVE_SQL = `SELECT s.id, s.revision, s.data,
(SELECT count(*)::integer FROM enrichable.sheet_rows r WHERE r.workspace_id=s.workspace_id AND r.sheet_id=s.id) AS row_count,
COALESCE((SELECT jsonb_agg(p.data ORDER BY p.position,p.id) FROM (SELECT r.id,r.position,r.data FROM enrichable.sheet_rows r WHERE r.workspace_id=s.workspace_id AND r.sheet_id=s.id ORDER BY r.position,r.id LIMIT 3) p), '[]'::jsonb) AS preview_rows
FROM enrichable.sheets s WHERE s.workspace_id = $1 ORDER BY s.id`;
export const SHEET_LIVE_SQL = `SELECT 'sheet'::text AS kind, id, revision, data FROM enrichable.sheets WHERE workspace_id = $1 AND id = $2
UNION ALL SELECT 'row'::text AS kind, id, 0::integer AS revision, data FROM enrichable.sheet_rows WHERE workspace_id = $1 AND sheet_id = $2`;
export const PRESENCE_LIVE_SQL = 'SELECT client_id, user_id, name, color, row_id, column_id, updated_at FROM enrichable.sheet_presence WHERE workspace_id = $1 AND sheet_id = $2';

export function realtimeConfig() {
	if (process.env.ENRICHABLE_REALTIME_ENABLED === 'false' || !process.env.NEON_REALTIME_URL || !process.env.NEON_REALTIME_SECRET || !process.env.DATABASE_URL) return null;
	const endpoint = configuredUrl('NEON_REALTIME_URL', process.env.NEON_REALTIME_URL);
	if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
	if (endpoint.protocol !== 'wss:' && !(process.env.NODE_ENV !== 'production' && endpoint.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) throw new Error('Invalid realtime endpoint.');
	return { url: endpoint.toString(), secret: process.env.NEON_REALTIME_SECRET, db: decodeURIComponent(configuredUrl('DATABASE_URL', process.env.DATABASE_URL).pathname.slice(1)) };
}

/** Never accept SQL, workspace IDs, credentials, or user identity from the browser. */
export async function sealWorkspaceQueries(account: Account, sheetId?: string) {
	const config = realtimeConfig();
	if (!config) return { enabled: false as const };
	const server = createRealtime({ secret: config.secret, db: config.db });
	const workspace = workspaceId(account);
	const index = await server.seal({ query: rawSql<{ id: string; revision: number; data: unknown; row_count: number; preview_rows: unknown[] }>(WORKSPACE_LIVE_SQL, [workspace]) });
	const sheet = sheetId ? await server.seal({ query: rawSql<LiveSheetEntry>(SHEET_LIVE_SQL, [workspace, sheetId]) }) : undefined;
	const presence = sheetId ? await server.seal({ query: rawSql<Collaborator>(PRESENCE_LIVE_SQL, [workspace, sheetId]) }) : undefined;
	return { enabled: true as const, url: config.url, userId: collaboratorIdentity(account).userId, index, sheet, presence };
}
