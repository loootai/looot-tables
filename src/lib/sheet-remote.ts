import type { Row, Sheet } from './types';

/** A whole sheet as the workspace stored it at one revision (`sheet.revision`). */
export type SheetSnapshot = { sheet: Sheet; rows: Row[] };

/** A change made against `revision`: the sheet's new metadata, the rows it wrote and the IDs of rows it removed. */
export type SheetPatch = { revision: number; sheet: Sheet; rows: Row[]; deleted: string[] };

/**
 * The workspace's copy of its sheets, which db.ts caches in IndexedDB and commits every change to. Each write names the
 * revision it was made against; a sheet that has moved on refuses it, and the writer reads the sheet again and redoes
 * its change. Written values pass Admission again, whoever wrote them. Other refusals throw a CloudError with the
 * workspace API's status: 400 invalid, 404 gone (writes only), 413 too large, 422 over a quota or a value its column
 * cannot hold, 503 unavailable.
 *
 * Adapters: `cloudSheets` (sheet-cloud.ts, /api/sheets) in the browser; an in-memory workspace in tests.
 */
export interface SheetRemote {
	/** Every sheet's metadata at its current revision. */
	list(): Promise<Sheet[]>;
	/** The whole sheet at one revision, or null once the workspace no longer has it. */
	read(sheetId: string): Promise<SheetSnapshot | null>;
	/** Stores a new sheet with its rows and returns it as stored, at revision 1. */
	create(sheet: Sheet, rows: Row[]): Promise<Sheet>;
	/** Applies the change if the sheet is still at `patch.revision`; null when it has moved on. */
	patch(patch: SheetPatch): Promise<{ revision: number; updatedAt: number } | null>;
	/** Deletes the sheet if it is still at `revision`. Null once it is gone; otherwise the newer revision it kept. */
	remove(sheetId: string, revision: number): Promise<number | null>;
}

export class CloudError extends Error {
	constructor(message: string, public status: number) { super(message); }
}

export const refused = (error: unknown, status: number): error is CloudError => error instanceof CloudError && error.status === status;
