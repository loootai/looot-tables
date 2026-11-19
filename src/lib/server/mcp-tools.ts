import 'server-only';
import { z } from 'zod';
import type { Account } from '../auth-identity';
import { ENTITY_COLUMNS, ENTITY_KINDS, ColumnOpSchema, type Cell, type Column, type EnrichFailure, type Row, type Sheet } from '../types';
import { parseInput, SHEET_DATA_VERSION, WorkspaceError, sheetSchema } from '../workspace';
import { assertNoEnrichmentCycles } from '../enrichment-dependencies';
import { BUSY_MESSAGE, failureCell, planCell, renameColumn, resultCell, settleCell, startCell, upgradeLegacyResults, type CommitOutcome, type EnrichmentPlan, type Grid } from '../enrichment-plan';
import { upgradeGrid } from '../sheet-upgrade';
import { danglingReferences, nameKey, nameTaken, sameName } from '../references';
import { definitionIssue, operationSummaries } from '../operations';
import { runOp } from './enrich';
import { admitCell } from '../cell-admission';
import { canonicalJson } from '../cell-content';
import { cellTransition } from '../cell-lifecycle';
import type { ProviderAccess } from './provider-access';
import { hashMcpSecret, type McpStore } from './mcp-store';
import { logWorkspaceError } from './workspace-logging';
import { randomUUID } from 'node:crypto';
import type { WorkspaceStore } from './workspace-store';

const id = z.string().min(1).max(128);
const revision = z.number().int().positive();
const value = z.union([z.string().max(100_000), z.number().finite(), z.boolean(), z.null(), z.array(z.string().max(10_000)).max(1000)]);
const column = sheetSchema.shape.columns.element;
// Derive the transport shape separately: Zod disallows omit/extend on refined objects.
// Delegate back to the complete shared schema so current and future refinements remain enforced.
const columnInputShape = z.object(column.shape).omit({ createdAt: true, width: true }).extend({ name: z.string().min(1).max(300), width: z.number().min(40).max(2000).default(180) });
function validateColumnInput(value: z.infer<typeof columnInputShape>, context: z.RefinementCtx) {
	const parsed = column.safeParse({ ...value, createdAt: 0 });
	if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
}
const columnInput = columnInputShape.superRefine(validateColumnInput);
const enrichedColumnInput = columnInputShape.extend({ type: z.literal('enriched').default('enriched'), op: ColumnOpSchema }).superRefine(validateColumnInput);
export const operationGuidance = 'For requests about my/our company, keep that wording in AI, decision, or email instructions: execution resolves the saved workspace brand and researches it on demand, with a 30-day cache. Prefer Enrichable built-in operations over implementing scraping, provider calls, or research yourself. If additional research is needed beyond those operations, prefer the Context.dev MCP when available: use people search and people enrichment to resolve identities, web search to find supporting sources, and web scrape or web answers to verify details. Use confirmed profile URLs or company websites to improve the sheet inputs, then rerun affected Enrichable operations to persist results and provenance. Do not guess missing identities or profile URLs. If Context.dev MCP is unavailable, use Enrichable search/scrape/answer operations before falling back to another web research tool. For people lists, keep Name as the first source column and call enrich_cells on it to resolve the person and attach the profile photo in place; do not add a duplicate Profile or photo column. Use template for deterministic text (free), company/person for supported facts, email-enrichment for verified work email waterfalls, hunter/prospeo for explicit provider contact data, scrape/search for web data, check/classify/score for decisions, and email-draft for emails. Use ai only when a specialized operation cannot answer the request; reserve answer for deep research. Run these operations with enrich_cells to persist results and provenance. Organization provider connections and settings are used automatically; optional request overrides are headers, never tool arguments. Editing source values or an operation keeps saved results but makes the affected ones outdated; enrich_cells skips finished cells, reporting outdated ones as skipped with outdated=true. To refresh them, rerun affected prerequisites, then their dependents, with overwrite=true and fresh idempotency keys.';
const edit = z.object({ rowId: id, columnId: id, value });
const TYPED_VALUES = 'Columns with a typed format (website, webpage, currency, percent, unit, checkbox, category) store values normalized to it, such as example.com or 1200; a value that does not fit refuses the whole call, naming each cell.';
const sheetId = { sheetId: id };
const mutation = { ...sheetId, revision };

export const mcpTools = {
	list_sheets: { description: 'List compact sheet summaries, column names/IDs, revisions, row counts, and app links. Pass includeDefinitions=true for full definitions, or get_sheet for one sheet.', schema: z.object({ includeDefinitions: z.boolean().default(false) }) },
	get_sheet: { description: 'Read columns, revision, and up to 100 rows. Pass revision on subsequent pages for a consistent snapshot. nextOffset is null at the end.', schema: z.object({ ...sheetId, offset: z.number().int().min(0).max(1000).default(0), revision: revision.optional() }) },
	create_sheet: { description: `Create a spreadsheet with the app's built-in blank (Name, Website)/companies/people/websites layout, or supply custom columns. Prefer this tool for spreadsheet creation. Name a company's website column Website (a source column named Domain or Site also works), and reference it as {{Website}}. Add built-in operations through enrichments (matching preset column names replace those source columns). No provider calls run at creation. Read returned column IDs, import rows with upsert_rows, then enrich_cells. ${operationGuidance} Supply a stable unique sheetId for safe matching-definition retries.`, schema: z.object({ ...sheetId, name: z.string().min(1).max(300), template: z.enum(['blank', ...ENTITY_KINDS]).default('blank'), columns: z.array(columnInput).min(1).max(200).optional().describe('Optional complete custom base layout; omit to use the selected built-in template.'), enrichments: z.array(enrichedColumnInput).max(200).default([]).describe('Built-in enrichment columns. Match a base column name to replace it, or use a new name to append. Prefer specialized operations to ai or external custom code.') }) },
	upsert_rows: { description: `Insert or partially update up to 100 rows by stable row id. cells maps column IDs to literal values, including strings beginning with =. Existing unspecified cells are preserved. ${TYPED_VALUES} Requires the current revision.`, schema: z.object({ ...mutation, rows: z.array(z.object({ id, cells: z.record(id, value) })).min(1).max(100) }) },
	update_cells: { description: `Edit up to 100 literal cell values. ${TYPED_VALUES} Requires the current revision; conflicts require rereading the sheet.`, schema: z.object({ ...mutation, cells: z.array(edit).min(1).max(100) }) },
	configure_column: { description: 'Add or replace a column configuration. Enriched columns require an op; references use {{Column name}}. No-cost example: op={kind:"template",template:"Hello {{Company}}"}. Prefer specialized built-in operations over generic ai or custom external code. Column definitions and dependencies are validated. Changing an operation keeps saved values but makes them outdated; rerun them with enrich_cells overwrite=true. Requires the current revision.', schema: z.object({ ...mutation, column: columnInput }) },
	delete_rows: { description: 'Permanently delete rows from a sheet. Requires the current revision.', schema: z.object({ ...mutation, rowIds: z.array(id).min(1).max(100) }) },
	delete_sheet: { description: 'Permanently delete a sheet and all its rows. Requires the current revision.', schema: z.object(mutation) },
	get_cell_details: { description: 'Read a cell value, status, sources, confidence, reasoning, and errors.', schema: z.object({ ...sheetId, rowId: id, columnId: id }) },
	enrich_cells: { description: 'Synchronously execute up to 5 cells in one column and persist results. A source person-name column (Name, Full name, Person, or Contact) is enriched in place with a matched profile photo using the row company, email, and LinkedIn clues. Source names are preserved; no duplicate Profile column is needed. The caller coordinates dependencies, subsequent batches, and retries. Only one MCP batch runs per organization at a time. Repeat identical arguments with the same idempotencyKey to retrieve the recorded outcome without rerunning. Finished cells are skipped unless overwrite=true, each reported as skipped with outdated=true when its operation or the values it reads changed since it ran. To refresh outdated cells, rerun prerequisites, then dependents, with overwrite=true and fresh keys. Interrupted outcomes may be uncertain; a new key may spend credits again. Uses organization provider connections automatically; optional overrides must be HTTP headers.', schema: z.object({ ...sheetId, columnId: id, rowIds: z.array(id).min(1).max(5), idempotencyKey: id, overwrite: z.boolean().default(false) }) },
} as const;

type Snapshot = { sheet: Sheet; rows: Row[] };
/** `outdated` (with `skipped`): the finished result's operation or inputs changed since it ran. */
type CellOutcome = { rowId: string; status: string; error?: string; failure?: EnrichFailure; cell?: Cell; outdated?: boolean };

/* A row starts only if its slowest plausible run still ends before the 300 s function limit. A killed request
   strands its attempt as running until MCP_ATTEMPT_LEASE_MS expires and blocks every enrich_cells call meanwhile; its
   cell stays running until the shared expiry rule (STALLED_ENRICHMENT_MS) lets the next call run it again. */
const ROW_DEADLINE_MS = 280_000;
const CONFLICT_MESSAGE = 'Inputs or cell changed during enrichment. Result was not saved.';

export class McpOperations {
	/** Saved in the cells this request runs, so browser tabs and other requests wait for them (see `startCell`). */
	private readonly owner = `mcp-${randomUUID()}`;
	constructor(private sheets: WorkspaceStore, private keys: McpStore, private actor: Account, private access: ProviderAccess, private execute: typeof runOp = runOp, private now: () => number = Date.now) {}
	private async snapshot(sheetId: string): Promise<Snapshot> { return this.upgrade(await this.sheets.snapshot(this.actor, sheetId)); }
	/** A sheet saved by an older version, upgraded as the browser upgrades one it loads (see `upgradeGrid`), so agents and
	    the browser read the same columns. Stamped even when nothing changes, so it is read whole only once. A sheet with
	    formulas waits for the browser, which recalculates them. */
	private async upgrade(snapshot: Snapshot): Promise<Snapshot> {
		if ((snapshot.sheet.dataVersion ?? 0) >= SHEET_DATA_VERSION || snapshot.rows.some((row) => Object.values(row.cells).some((cell) => cell.f))) return snapshot;
		const next = upgradeGrid(snapshot) ?? snapshot;
		try { await this.sheets.patch(this.actor, snapshot.sheet.id, { revision: snapshot.sheet.revision, sheet: next.sheet, rows: next.rows.filter((row, index) => row !== snapshot.rows[index]), deleted: [] }); }
		catch (error) {
			if (!(error instanceof WorkspaceError)) throw error;
			// Someone else wrote first: read their version. Any other refusal leaves the sheet as it was, still readable.
			if (error.status !== 409) return snapshot;
		}
		return this.sheets.snapshot(this.actor, snapshot.sheet.id);
	}
	/** Every sheet, each upgraded first (see `upgrade`). */
	private async list() {
		const entries = await this.sheets.list(this.actor);
		return Promise.all(entries.map(async (entry) => (entry.sheet.dataVersion ?? 0) >= SHEET_DATA_VERSION ? entry : { ...entry, sheet: (await this.snapshot(entry.sheet.id)).sheet }));
	}
	private assertWritable(snapshot: Snapshot) {
		if (snapshot.rows.some((row) => Object.values(row.cells).some((cell) => cell.f))) throw new WorkspaceError('MCP edits to sheets containing formulas are not supported yet. Formula recalculation requires the browser.', 422);
	}
	private async editable(sheetId: string, expected: number) {
		const snapshot = await this.snapshot(sheetId);
		if (snapshot.sheet.revision !== expected) throw new WorkspaceError('Sheet changed. Read the current revision and retry your edit.', 409);
		this.assertWritable(snapshot);
		return snapshot;
	}
	private async patch(snapshot: Snapshot, rows: Row[], deleted: string[] = []) {
		const merged = new Map(snapshot.rows.map((row) => [row.id, row]));
		for (const row of rows) merged.set(row.id, row);
		for (const rowId of deleted) merged.delete(rowId);
		try { assertNoEnrichmentCycles(snapshot.sheet.columns, [...merged.values()]); } catch (error) { throw new WorkspaceError(error instanceof Error ? error.message : 'Circular enrichment dependency.'); }
		return this.sheets.patch(this.actor, snapshot.sheet.id, { revision: snapshot.sheet.revision, sheet: snapshot.sheet, rows, deleted });
	}
	/** An agent's value as its column stores it, normalized to the column's format. A value the format cannot hold is
	    added to `refused`; see `refuse`. */
	private cell(column: Column, rowId: string, value: z.infer<typeof edit>['value'], refused: string[]): Cell {
		const admission = admitCell(column, { v: value, s: 'done', t: Date.now() }, 'agent');
		if (admission.ok) return admission.cell;
		refused.push(`Row “${rowId}”, column “${column.name}”: ${admission.error}`);
		return { v: null, s: 'idle', t: 0 };
	}
	/** One refused value fails the whole call, naming every refused cell, so the agent can fix them and retry. */
	private refuse(refused: string[]) {
		if (refused.length) throw new WorkspaceError(`Nothing was written: ${refused.length === 1 ? 'a value does' : `${refused.length} values do`} not fit the column format. ${refused.slice(0, 10).join(' ')}${refused.length > 10 ? ` …and ${refused.length - 10} more.` : ''}`, 422);
	}
	/** Checks only the columns being written (all by default), so a reference left dangling elsewhere, say by a
	    column deleted in the browser, never blocks configuring the rest of the sheet. */
	private validateColumns(columns: Column[], changed?: string) {
		for (const c of changed === undefined ? columns : columns.filter((entry) => entry.id === changed)) {
			if (nameTaken(c.name, columns, c.id)) throw new WorkspaceError('Column names must be unique.');
			if ((c.type === 'enriched') !== Boolean(c.op)) throw new WorkspaceError('Enriched columns require an operation; source columns cannot have one.');
			if (!c.op) continue;
			const issue = definitionIssue(c.op);
			if (issue) throw new WorkspaceError(issue.message);
			const [dangling] = danglingReferences(c.op, columns);
			if (dangling) throw new WorkspaceError(`Unresolved column reference: ${dangling}`);
		}
	}
	async call(name: string, input: unknown): Promise<Record<string, unknown>> {
		switch (name) {
			case 'list_sheets': {
				const args = parseInput(mcpTools.list_sheets.schema, input, 'Invalid arguments.');
				const entries = await this.list();
				return { sheets: args.includeDefinitions ? entries : entries.map(({ sheet, rowCount }) => ({ id: sheet.id, name: sheet.name, revision: sheet.revision, rowCount, columns: sheet.columns.map(({ id, name, type }) => ({ id, name, type })), url: `/app/sheets/${encodeURIComponent(sheet.id)}` })) };
			}
			case 'get_sheet': {
				const args = parseInput(mcpTools.get_sheet.schema, input, 'Invalid arguments.');
				let result = await this.sheets.get(this.actor, args.sheetId, args.offset, args.revision);
				// Only a first read upgrades: later pages are pinned to its revision.
				if (!args.offset && args.revision === undefined && (result.sheet.dataVersion ?? 0) < SHEET_DATA_VERSION && (await this.snapshot(args.sheetId)).sheet.revision !== result.sheet.revision) result = await this.sheets.get(this.actor, args.sheetId);
				return { sheet: result.sheet, rows: result.rows, nextOffset: result.next, url: `/app/sheets/${encodeURIComponent(args.sheetId)}` };
			}
			case 'create_sheet': {
				const args = parseInput(mcpTools.create_sheet.schema, input, 'Invalid arguments.');
				const now = Date.now();
				const presets = args.template === 'blank' ? [{ name: 'Name', width: 180 }, { name: 'Website', format: 'url' as const, width: 180 }] : ENTITY_COLUMNS[args.template];
				let columns = args.columns ?? presets.map((c, index) => ({ ...c, id: `source_${index + 1}`, type: 'source' as const, width: c.width ?? 180 }));
				if (new Set(args.enrichments.map((c) => nameKey(c.name))).size !== args.enrichments.length || new Set(args.enrichments.map((c) => c.id)).size !== args.enrichments.length) throw new WorkspaceError('Enrichment column names and IDs must be unique.');
				for (const enrichment of args.enrichments) {
					const index = columns.findIndex((c) => sameName(c.name, enrichment.name));
					if (index < 0) columns = [...columns, enrichment];
					else columns = columns.map((c, i) => i === index ? { ...c, ...enrichment } : c);
				}
				const sheet: Sheet = { id: args.sheetId, name: args.name, columns: columns.map((c) => ({ ...c, createdAt: now })), filters: [], sort: null, dataVersion: SHEET_DATA_VERSION, createdAt: now, updatedAt: now };
				this.validateColumns(sheet.columns);
				try { assertNoEnrichmentCycles(sheet.columns, []); } catch (error) { throw new WorkspaceError(error instanceof Error ? error.message : 'Circular enrichment dependency.'); }
				const existing = (await this.list()).find((entry) => entry.sheet.id === sheet.id);
				if (existing) {
					const shape = (s: Sheet) => canonicalJson([s.name, s.columns.map((c) => ({ ...c, createdAt: 0 }))]);
					if (shape(existing.sheet) !== shape(sheet)) throw new WorkspaceError('This sheetId already exists with a different configuration.', 409);
					return { sheet: existing.sheet, existing: true, url: `/app/sheets/${encodeURIComponent(sheet.id)}`, operationGuidance, availableOperations: operationSummaries };
				}
				return { sheet: await this.sheets.create(this.actor, { sheet, rows: [] }), url: `/app/sheets/${encodeURIComponent(sheet.id)}`, operationGuidance, availableOperations: operationSummaries };
			}
			case 'upsert_rows': {
				const args = parseInput(mcpTools.upsert_rows.schema, input, 'Invalid arguments.');
				const snapshot = await this.editable(args.sheetId, args.revision);
				const columns = new Map(snapshot.sheet.columns.map((c) => [c.id, c]));
				const refused: string[] = [];
				let order = Math.max(-1, ...snapshot.rows.map((r) => r.order));
				const rows = args.rows.map((entry) => {
					if (Object.keys(entry.cells).some((id) => !columns.has(id))) throw new WorkspaceError('Unknown column ID.');
					const old = snapshot.rows.find((r) => r.id === entry.id);
					return { id: entry.id, sheetId: args.sheetId, order: old?.order ?? ++order, createdAt: old?.createdAt ?? Date.now(), cells: { ...old?.cells, ...Object.fromEntries(Object.entries(entry.cells).map(([id, v]) => [id, this.cell(columns.get(id)!, entry.id, v, refused)])) } };
				});
				this.refuse(refused);
				return this.patch(snapshot, rows);
			}
			case 'update_cells': {
				const args = parseInput(mcpTools.update_cells.schema, input, 'Invalid arguments.');
				const snapshot = await this.editable(args.sheetId, args.revision);
				const changed = new Map<string, Row>();
				const refused: string[] = [];
				const rows = new Map(snapshot.rows.map((row) => [row.id, row]));
				const columns = new Map(snapshot.sheet.columns.map((column) => [column.id, column]));
				for (const edit of args.cells) {
					const row = changed.get(edit.rowId) ?? rows.get(edit.rowId);
					const column = columns.get(edit.columnId);
					if (!row || !column) throw new WorkspaceError('Unknown row or column ID.');
					changed.set(row.id, { ...row, cells: { ...row.cells, [edit.columnId]: this.cell(column, row.id, edit.value, refused) } });
				}
				this.refuse(refused);
				return this.patch(snapshot, [...changed.values()]);
			}
			case 'configure_column': {
				const args = parseInput(mcpTools.configure_column.schema, input, 'Invalid arguments.');
				const snapshot = await this.editable(args.sheetId, args.revision);
				const previous = snapshot.sheet.columns.find((c) => c.id === args.column.id);
				const next = { ...args.column, createdAt: previous?.createdAt ?? Date.now() };
				// As in the browser: a rename keeps the results it leaves current, and a changed operation keeps saved values
				// but makes them outdated. Results fingerprinted by column name are restamped first, as they cannot follow.
				const current = { sheet: snapshot.sheet, rows: upgradeLegacyResults(snapshot) };
				const { sheet, rows } = previous ? renameColumn(current, previous.id, next.name) : current;
				const columns = previous ? sheet.columns.map((c) => c.id === next.id ? next : c) : [...sheet.columns, next];
				this.validateColumns(columns, next.id);
				return this.patch({ sheet: { ...sheet, columns }, rows }, rows.filter((row, index) => row !== snapshot.rows[index]));
			}
			case 'delete_rows': {
				const args = parseInput(mcpTools.delete_rows.schema, input, 'Invalid arguments.');
				const snapshot = await this.editable(args.sheetId, args.revision);
				return this.patch(snapshot, [], args.rowIds);
			}
			case 'delete_sheet': {
				const args = parseInput(mcpTools.delete_sheet.schema, input, 'Invalid arguments.');
				await this.sheets.remove(this.actor, args.sheetId, args.revision);
				return { deleted: true };
			}
			case 'get_cell_details': {
				const args = parseInput(mcpTools.get_cell_details.schema, input, 'Invalid arguments.');
				const { sheet, rows } = await this.snapshot(args.sheetId);
				const row = rows.find((r) => r.id === args.rowId);
				if (!row || !sheet.columns.some((c) => c.id === args.columnId)) throw new WorkspaceError('Unknown row or column ID.', 404);
				return { cell: row.cells[args.columnId] ?? null, revision: sheet.revision };
			}
			case 'enrich_cells': return this.enrich(parseInput(mcpTools.enrich_cells.schema, input, 'Invalid arguments.'));
			default: throw new WorkspaceError('Unknown MCP tool.');
		}
	}
	/** Plan a requested cell. Source person-name columns are enriched in place; see `EnrichmentPlan.inPlace`. */
	private plan(snapshot: Snapshot, rowId: string, columnId: string): EnrichmentPlan {
		this.assertWritable(snapshot);
		const plan = planCell(snapshot, { rowId, columnId }, { now: this.now(), owner: this.owner });
		if (!plan) throw new WorkspaceError('Unknown row or enrichment column.');
		return plan;
	}
	private write(snapshot: Snapshot, row: Row, columnId: string, cell: Cell) {
		return this.patch(snapshot, [{ ...row, cells: { ...row.cells, [columnId]: cell } }]);
	}
	/** Mark one cell running (so browser tabs show the agent's progress), run it, and store what the plan makes of the
	    result. Finished cells are skipped unless overwritten. Cells that cannot run are failed as the browser fails them,
	    except a saved result, which is never replaced by that reason; cells waiting on others are left alone. */
	/** One row at a time: each row commits to the same sheet revision, and the deadline budget assumes sequential rows.
	    A row is started only if its worst case still fits before the request deadline. */
	private async *enrichRows(sheetId: string, rowIds: string[], columnId: string, overwrite: boolean, worstCase: number): AsyncGenerator<CellOutcome> {
		const started = this.now();
		for (const rowId of rowIds) {
			if (this.now() - started + worstCase > ROW_DEADLINE_MS) yield { rowId, status: 'not_started' };
			else yield this.enrichCell(sheetId, rowId, columnId, overwrite);
		}
	}

	private async enrichCell(sheetId: string, rowId: string, columnId: string, overwrite: boolean): Promise<CellOutcome> {
		for (let tries = 0; tries < 3; tries++) {
			const snapshot = await this.snapshot(sheetId);
			const plan = this.plan(snapshot, rowId, columnId);
			if (plan.finished && !overwrite) return { rowId, status: 'skipped', outdated: plan.outdated };
			if (plan.busy) return { rowId, status: 'blocked', error: BUSY_MESSAGE };
			const { readiness } = plan;
			if (readiness.kind === 'waiting' || readiness.kind !== 'ready' && plan.cell?.s === 'done') return { rowId, status: 'blocked', error: readiness.message };
			const cell = readiness.kind === 'ready' ? startCell(plan, this.owner) : failureCell(plan, readiness.message);
			try { await this.write(snapshot, plan.row, columnId, cell); }
			catch (error) { if (error instanceof WorkspaceError && error.status === 409) continue; throw error; }
			if (readiness.kind !== 'ready') return { rowId, status: cell.s, error: readiness.message, cell };
			return this.run(sheetId, plan, cell);
		}
		return { rowId, status: 'conflict', error: 'The sheet kept changing. Read it again and retry.' };
	}
	private async run(sheetId: string, plan: EnrichmentPlan, marker: Cell): Promise<CellOutcome> {
		let settled = false;
		try {
			const result = await this.execute(this.access, plan.op, plan.record);
			const next = result.error ? failureCell(plan, result.error, result.meta, undefined, marker) : resultCell(plan, result.value, result.meta);
			const saved = await this.settle(sheetId, plan, marker, (grid) => settleCell(plan, grid, next, marker));
			settled = saved !== null;
			const failure = result.error && result.failure ? { failure: result.failure } : {};
			return saved?.outcome === 'applied' ? { rowId: plan.row.id, status: saved.cell.s, cell: saved.cell, ...failure } : { rowId: plan.row.id, status: 'conflict', error: CONFLICT_MESSAGE, ...failure };
		} finally {
			// A failed request or save must not leave the cell running until it expires.
			if (!settled) await this.settle(sheetId, plan, marker, () => ({ outcome: 'superseded', cell: cellTransition(marker, { type: 'cancel' }) })).catch(() => null);
		}
	}
	/** Compare-and-set on the running marker, in one transaction under the workspace's lock (see
	    `WorkspaceStore.changeCell`), so a write elsewhere in the sheet never loses a paid result: write what `build` makes
	    of the current grid while the cell still holds `marker`. Null when someone else changed the cell; their change is
	    kept. */
	private async settle(sheetId: string, plan: EnrichmentPlan, marker: Cell, build: (grid: Grid) => { outcome: CommitOutcome; cell: Cell }) {
		let settled = null as { outcome: CommitOutcome; cell: Cell } | null;
		await this.sheets.changeCell(this.actor, sheetId, plan.target, (grid) => {
			const row = grid.rows.find((r) => r.id === plan.row.id);
			if (canonicalJson(row?.cells[plan.column.id]) !== canonicalJson(marker)) return undefined;
			return (settled = build(grid)).cell;
		});
		return settled;
	}
	private async enrich(args: z.infer<typeof mcpTools.enrich_cells.schema>): Promise<Record<string, unknown>> {
		if (new Set(args.rowIds).size !== args.rowIds.length) throw new WorkspaceError('Duplicate row IDs.');
		await this.access.checkEndpoint();
		// Validate all requested targets before executing any cell.
		// Replays use the saved outcome even if the sheet was subsequently changed/deleted.
		const claim = await this.keys.claim(this.actor, args.idempotencyKey, hashMcpSecret(JSON.stringify(args)));
		if (!claim.claimed && claim.result && typeof claim.result.error === 'string') throw new WorkspaceError(claim.result.error, Number(claim.result.status));
		if (!claim.claimed) return claim.result ?? { status: claim.status, retryAfterSeconds: claim.status === 'uncertain' ? null : 5, message: claim.status === 'uncertain' ? 'Interrupted request: provider spending or saved cells may be uncertain. Inspect the sheet before explicitly retrying with a new idempotency key.' : 'Poll by repeating these arguments and idempotency key.' };
		let worstCase: number;
		try {
			const snapshot = await this.snapshot(args.sheetId);
			worstCase = Math.max(...args.rowIds.map((rowId) => this.plan(snapshot, rowId, args.columnId).worstCaseMs));
		} catch (error) {
			const result = { error: error instanceof WorkspaceError ? error.message : 'Invalid enrichment targets.', status: error instanceof WorkspaceError ? error.status : 400 };
			await this.keys.finish(this.actor, args.idempotencyKey, result);
			throw error;
		}
		const outcomes: CellOutcome[] = [];
		try {
			for await (const outcome of this.enrichRows(args.sheetId, args.rowIds, args.columnId, args.overwrite, worstCase)) outcomes.push(outcome);
			const result = { status: 'finished', outcomes, revision: (await this.sheets.get(this.actor, args.sheetId)).sheet.revision };
			await this.keys.finish(this.actor, args.idempotencyKey, result);
			return result;
		} catch (error) {
			// A provider may have completed before storage failed. Record uncertainty and do not automatically rerun.
			if (!(error instanceof WorkspaceError)) logWorkspaceError(error, { requestId: randomUUID(), operation: 'mcp.enrich_cells', phase: 'batch', durationMs: 0 });
			const result = { status: 'uncertain', outcomes, message: error instanceof WorkspaceError ? error.message : 'The batch was interrupted. Inspect saved cells before explicitly retrying with a new key.' };
			await this.keys.finish(this.actor, args.idempotencyKey, result);
			return result;
		}
	}
}
