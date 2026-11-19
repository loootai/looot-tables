import { z } from 'zod';
import { rowSchema, sheetSchema } from './workspace';

// Retain a hidden tab’s last selection for ten minutes without heartbeats.
export const PRESENCE_TTL_MS = 10 * 60_000;

export const presenceInputSchema = z.object({
	clientId: z.string().uuid(), sheetId: z.string().min(1).max(128),
	rowId: z.string().min(1).max(128).nullable().default(null),
	columnId: z.string().min(1).max(128).nullable().default(null),
});
export const peerSchema = z.object({ client_id: z.string(), user_id: z.string(), name: z.string().max(128), color: z.string().regex(/^#[a-f0-9]{6}$/i), row_id: z.string().nullable(), column_id: z.string().nullable(), updated_at: z.coerce.number().finite() });
export type Collaborator = z.infer<typeof peerSchema>;
export type CollaborationStatus = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline' | 'paused';
export const liveEntrySchema = z.object({ kind: z.enum(['sheet', 'row']), id: z.string(), revision: z.coerce.number().int().nonnegative(), data: z.unknown() });
export type LiveSheetEntry = z.infer<typeof liveEntrySchema>;

/** A single UNION query publishes the sheet revision and row changes atomically. */
export function decodeLiveSheet(entries: readonly LiveSheetEntry[], sheetId: string) {
	const header = entries.find((entry) => entry.kind === 'sheet' && entry.id === sheetId);
	if (!header) return null;
	const sheet = { ...sheetSchema.parse(header.data), revision: header.revision };
	if (sheet.id !== sheetId || header.revision < 1) throw new Error('Invalid live sheet.');
	const rows = entries.filter((entry) => entry.kind === 'row').map((entry) => rowSchema.parse(entry.data));
	if (rows.length > 1000 || new Set(rows.map((row) => row.id)).size !== rows.length || rows.some((row) => row.sheetId !== sheetId)) throw new Error('Invalid live rows.');
	return { sheet, rows };
}

export function currentCollaborators(peers: readonly Collaborator[], clientId: string, now = Date.now()) {
	return peers.filter((peer) => peer.client_id !== clientId && peer.updated_at > now - PRESENCE_TTL_MS && peer.updated_at < now + 60_000);
}
