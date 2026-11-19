import { z } from 'zod';
import { invalidCell, redefinedColumns } from '../../src/lib/cell-admission';
import { CloudError, type SheetPatch, type SheetRemote, type SheetSnapshot } from '../../src/lib/sheet-remote';
import { createSheetSchema, MAX_ROWS, MAX_SHEETS, patchSheetSchema } from '../../src/lib/workspace';
import type { Row, Sheet } from '../../src/lib/types';

export type RemoteCall =
	| { method: 'list' }
	| { method: 'read'; sheetId: string }
	| { method: 'create'; sheet: Sheet; rows: Row[] }
	| { method: 'patch'; patch: SheetPatch }
	| { method: 'remove'; sheetId: string; revision: number };

/** Input crosses JSON as it would over HTTP, and a schema failure is the API's 400 with the first issue. */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(JSON.parse(JSON.stringify(input)));
	if (!result.success) throw new CloudError(result.error.issues[0]?.message || 'Invalid sheet data.', 400);
	return result.data;
}

const byPosition = (a: Row, b: Row) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function checkRows(sheet: Sheet, rows: Row[]) {
	const columns = new Set(sheet.columns.map((column) => column.id));
	if (columns.size !== sheet.columns.length || new Set(rows.map((row) => row.id)).size !== rows.length) throw new CloudError('Duplicate row or column IDs.', 400);
	if (rows.some((row) => row.sheetId !== sheet.id || Object.keys(row.cells).some((id) => !columns.has(id)))) throw new CloudError('Rows must belong to the sheet and its columns.', 400);
}

/** Written cells that changed, and every cell of a column whose format changed, must fit their column. */
function admissionProblem(stored: SheetSnapshot, patch: { sheet: Sheet; rows: Row[]; deleted: string[] }) {
	const redefined = redefinedColumns(stored.sheet.columns, patch.sheet.columns).size > 0;
	if (!redefined && !patch.rows.length) return null;
	const written = new Set(patch.rows.map((row) => row.id)), deleted = new Set(patch.deleted);
	const before = redefined ? stored.rows : stored.rows.filter((row) => written.has(row.id));
	const rows = redefined ? [...before.filter((row) => !written.has(row.id) && !deleted.has(row.id)), ...patch.rows] : patch.rows;
	return invalidCell({ columns: stored.sheet.columns, rows: before }, { columns: patch.sheet.columns, rows });
}

/**
 * A workspace in memory behind the SheetRemote seam, with the rules of WorkspaceStore behind /api/sheets: revisions,
 * the sheet and row quotas, rows owned by one sheet, and Admission of written values. It stores what the server would:
 * input parsed by the server's schemas. tests/server/sheet-remote-contract.test.ts holds it to WorkspaceStore.
 */
export class MemoryRemote implements SheetRemote {
	private sheets = new Map<string, SheetSnapshot>();
	/** Every call across the seam, in order, including refused ones. */
	readonly calls: RemoteCall[] = [];
	/** Runs before each call is applied: a test can make a teammate's change, hold the call, or throw to fail it. */
	before?: (call: RemoteCall) => void | Promise<void>;

	private async receive(call: RemoteCall) {
		this.calls.push(call);
		await this.before?.(call);
	}
	private owners() {
		return new Map([...this.sheets.values()].flatMap(({ sheet, rows }) => rows.map((row) => [row.id, sheet.id] as const)));
	}

	async list() {
		await this.receive({ method: 'list' });
		return [...this.sheets.keys()].sort().map((id) => structuredClone(this.sheets.get(id)!.sheet));
	}
	async read(sheetId: string) {
		await this.receive({ method: 'read', sheetId });
		return this.snapshot(sheetId) ?? null;
	}
	async create(sheet: Sheet, rows: Row[]) {
		await this.receive({ method: 'create', sheet, rows });
		const input = parse(createSheetSchema, { sheet, rows });
		checkRows(input.sheet, input.rows);
		if (this.sheets.size >= MAX_SHEETS) throw new CloudError(`This workspace can have up to ${MAX_SHEETS} sheets. Delete a sheet to create another.`, 422);
		if (this.sheets.has(input.sheet.id)) throw new CloudError('This sheet already exists.', 409);
		const owners = this.owners();
		if (input.rows.some((row) => owners.has(row.id))) throw new CloudError('A row ID is already used by another sheet.', 409);
		const created = { ...input.sheet, revision: 1 };
		this.sheets.set(created.id, { sheet: created, rows: input.rows.sort(byPosition) });
		return structuredClone(created);
	}
	async patch(patch: SheetPatch) {
		await this.receive({ method: 'patch', patch });
		const input = parse(patchSheetSchema, patch);
		checkRows(input.sheet, input.rows);
		const stored = this.sheets.get(input.sheet.id);
		if (!stored) throw new CloudError('Sheet not found in this workspace.', 404);
		if (stored.sheet.revision !== input.revision) return null;
		const problem = admissionProblem(stored, input);
		if (problem) throw new CloudError(problem, 422);
		// The server refuses a row ID another sheet owns with a 409, which /api/sheets cannot tell from a conflict.
		const owners = this.owners();
		if (input.rows.some((row) => (owners.get(row.id) ?? stored.sheet.id) !== stored.sheet.id)) return null;
		const written = new Set(input.rows.map((row) => row.id)), deleted = new Set(input.deleted);
		const rows = [...stored.rows.filter((row) => !written.has(row.id) && !deleted.has(row.id)), ...input.rows].sort(byPosition);
		if (rows.length > MAX_ROWS) throw new CloudError(`Each sheet can have up to ${MAX_ROWS.toLocaleString()} rows.`, 422);
		const sheet = { ...input.sheet, revision: stored.sheet.revision! + 1, updatedAt: Date.now() };
		this.sheets.set(sheet.id, { sheet, rows });
		return { revision: sheet.revision, updatedAt: sheet.updatedAt };
	}
	async remove(sheetId: string, revision: number) {
		await this.receive({ method: 'remove', sheetId, revision });
		parse(z.coerce.number().int().positive(), revision);
		const stored = this.sheets.get(sheetId);
		if (!stored) return null;
		if (stored.sheet.revision !== revision) return stored.sheet.revision!;
		this.sheets.delete(sheetId);
		return null;
	}

	/** A copy of the stored sheet; undefined once it is gone. */
	snapshot(sheetId: string): SheetSnapshot | undefined {
		const stored = this.sheets.get(sheetId);
		return stored && structuredClone(stored);
	}
	/** Another writer's change (a teammate, an agent, an older client), stored as is at the sheet's next revision. */
	edit(sheetId: string, change: (grid: SheetSnapshot) => void) {
		const stored = this.snapshot(sheetId);
		if (!stored) throw new Error(`No sheet ${sheetId} to edit.`);
		change(stored);
		this.sheets.set(sheetId, { sheet: { ...stored.sheet, revision: this.sheets.get(sheetId)!.sheet.revision! + 1 }, rows: stored.rows.sort(byPosition) });
	}
	/** Another writer deletes the sheet. */
	drop(sheetId: string) { this.sheets.delete(sheetId); }
	/** What the realtime index query delivers for this workspace. */
	liveIndex() {
		return [...this.sheets.values()].map(({ sheet, rows }) => ({ id: sheet.id, revision: sheet.revision!, data: structuredClone(sheet), row_count: rows.length, preview_rows: structuredClone(rows.slice(0, 3)) }));
	}
}
