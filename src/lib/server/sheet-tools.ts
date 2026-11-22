import 'server-only';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import type { Account } from '../auth-identity';
import { admittedCell } from '../cell-admission';
import { roleColumn } from '../column-roles';
import { foundRecords, foundRowColumns } from '../found-rows';
import { ghostColumnOp, ghostColumns } from '../next-steps';
import { sameName, uniqueName } from '../references';
import { ColumnOpSchema, type Cell, type Column, type ColumnOp, type EntityKind, type FoundRow, type Row, type Sheet } from '../types';
import { unpackColumns, unpackableFields } from '../unpack';
import { MAX_ROWS, parseInput, WorkspaceError } from '../workspace';
import { quoteColumnRun, runQuotedColumn, runStatus, type RunProgress } from './column-runs';
import type { Database } from './database';
import { runOp } from './enrich';
import { quoteFindRows, runFindRows } from './find-rows';
import { inspectSummary, parsePriceUsd } from './looot-catalog';
import type { McpStore } from './mcp-store';
import { McpOperations, type Snapshot } from './mcp-tools';
import { checkMoltSets } from './moltsets-plan';
import type { ProviderAccess } from './provider-access';
import { RunLedger } from './run-ledger';
import { dedupeRows, exportSheet, importRows, queryRows } from './sheet-io';
import { SpendGuard } from './spend-guard';
import { SHEET_TOOLS, type ToolName } from './tool-specs';
import type { WorkspaceStore } from './workspace-store';

/* One implementation behind two front doors. The MCP endpoint and the in-app agent both call `SheetTools.call(name,
   args)`; the original MCP tools come from McpOperations, the rest are here and in column-runs, find-rows and sheet-io.
   Every argument is parsed against the same schema the agent saw (tool-specs.ts). */

type Args<N extends ToolName> = z.infer<(typeof SHEET_TOOLS)[N]['schema']>;
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'column';
const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
const reference = (column: Column | undefined) => column ? `{{${column.name}}}` : '';

export interface SheetToolServices { sheets: WorkspaceStore; keys: McpStore; database: Database }

export class SheetTools extends McpOperations {
	readonly ledger: RunLedger;
	/** Progress of a run_column call in this request, for a streaming caller (the in-app agent's Run button). */
	onRunProgress?: (progress: RunProgress) => void;

	constructor(services: SheetToolServices, actor: Account, access: ProviderAccess, options: { execute?: typeof runOp; now?: () => number } = {}) {
		super(services.sheets, services.keys, actor, access, options.execute ?? runOp, options.now ?? Date.now, new SpendGuard(services.database, actor));
		this.ledger = new RunLedger(services.database, actor, options.now ?? Date.now);
	}

	get providerAccess() { return this.access; }
	get spendGuard() { return this.guard; }
	readSnapshot(sheetId: string) { return this.snapshot(sheetId); }
	editableSnapshot(sheetId: string, revision: number) { return this.editable(sheetId, revision); }
	assertRunnable(snapshot: Snapshot) { this.assertWritable(snapshot); }
	newRowId() { return `r_${randomBytes(9).toString('base64url')}`; }

	/** A new text column named after `name`, with a name and id no other column has. */
	newColumn(name: string, columns: readonly Column[], extra: Partial<Column> = {}): Column {
		const ids = new Set(columns.map((column) => column.id));
		let id = slug(name);
		for (let n = 2; ids.has(id); n++) id = `${slug(name)}_${n}`;
		return { id, name: uniqueName(name.trim() || 'Column', columns.map((column) => column.name)), type: 'source', width: 180, createdAt: Date.now(), ...extra };
	}

	/** Save new columns and rows (and delete some) against the snapshot's revision. */
	async saveGrid(snapshot: Snapshot, change: { columns?: Column[]; rows: Row[]; deleted?: string[] }) {
		const sheet: Sheet = change.columns ? { ...snapshot.sheet, columns: change.columns } : snapshot.sheet;
		if (change.columns) this.validateColumns(change.columns);
		return this.patch({ sheet, rows: snapshot.rows }, change.rows, change.deleted ?? []);
	}

	/** Found rows appended to a sheet: missing layout columns are added, people's photos land on their Name cells. */
	async appendFound(sheetId: string, entity: EntityKind, found: FoundRow[]): Promise<{ rows: number; columns: string[] }> {
		if (!found.length) return { rows: 0, columns: [] };
		for (let tries = 0; ; tries++) {
			const snapshot = await this.snapshot(sheetId);
			this.assertWritable(snapshot);
			const room = MAX_ROWS - snapshot.rows.length;
			if (room <= 0) throw new WorkspaceError(`This sheet already has ${MAX_ROWS} rows.`, 422);
			const columns = [...snapshot.sheet.columns];
			// Only the layout columns some found row fills: a search that returns no schools adds no Schools column.
			const filled = new Set(foundRecords(entity, found, columns).records.flatMap((record) => Object.entries(record).filter(([, value]) => value !== null && value !== '' && !(Array.isArray(value) && !value.length)).map(([name]) => name.toLowerCase())));
			const added = foundRowColumns(entity, columns).missing.filter((entry) => filled.has(entry.name.toLowerCase())).map((entry) => { const column = this.newColumn(entry.name, columns, { format: entry.format, width: entry.width ?? 180 }); columns.push(column); return column; });
			const { records, cellMeta } = foundRecords(entity, found.slice(0, room), columns);
			const now = Date.now();
			let order = Math.max(-1, ...snapshot.rows.map((row) => row.order));
			const rows: Row[] = records.map((record, index) => ({
				id: this.newRowId(), sheetId, order: ++order, createdAt: now,
				cells: Object.fromEntries(Object.entries(record).flatMap(([name, value]) => {
					const column = columns.find((entry) => sameName(entry.name, name));
					if (!column || value === null || value === undefined) return [];
					const meta = cellMeta[index][name];
					return [[column.id, admittedCell(column, { v: value, s: 'done', t: now, ...(meta ? { m: meta } : {}) }, 'find-rows')]];
				})),
			}));
			try {
				await this.saveGrid(snapshot, { columns, rows });
				return { rows: rows.length, columns: added.map((column) => column.name) };
			} catch (error) { if (!(error instanceof WorkspaceError && error.status === 409) || tries === 2) throw error; }
		}
	}

	/** Configure one column through configure_column, so new columns get every check an edited one gets. */
	private async configure(sheetId: string, revision: number, column: { id: string; name: string; type: 'enriched' | 'source'; op?: ColumnOp; format?: Column['format']; width?: number }) {
		return super.call('configure_column', { sheetId, revision, column }) as Promise<{ revision: number }>;
	}

	override async call(name: string, input: unknown): Promise<Record<string, unknown>> {
		if (!(name in SHEET_TOOLS)) throw new WorkspaceError(`Unknown tool ${name}.`, 404);
		const tool = name as ToolName;
		const parse = <N extends ToolName>(key: N): Args<N> => parseInput(SHEET_TOOLS[key].schema, input, 'Invalid arguments.') as Args<N>;
		switch (tool) {
			case 'delete_sheet': {
				const args = parse('delete_sheet');
				const { sheet } = await this.snapshot(args.sheetId);
				if (!sameName(sheet.name, args.confirm)) throw new WorkspaceError(`confirm must be the sheet’s name, “${sheet.name}”, after the user agreed to delete it.`, 400);
				return super.call('delete_sheet', { sheetId: args.sheetId, revision: args.revision });
			}
			case 'rename_sheet': {
				const args = parse('rename_sheet');
				const snapshot = await this.editable(args.sheetId, args.revision);
				return this.patch({ ...snapshot, sheet: { ...snapshot.sheet, name: args.name } }, []);
			}
			case 'duplicate_sheet': return this.duplicate(parse('duplicate_sheet'));
			case 'save_view': {
				const args = parse('save_view');
				const snapshot = await this.editable(args.sheetId, args.revision);
				for (const entry of [...args.filters, ...(args.sort ? [args.sort] : [])]) if (!snapshot.sheet.columns.some((column) => column.id === entry.columnId)) throw new WorkspaceError(`No column with id ${entry.columnId}.`, 404);
				return this.patch({ ...snapshot, sheet: { ...snapshot.sheet, filters: args.filters.map((filter, index) => ({ ...filter, id: `view${index}` })), sort: args.sort } }, []);
			}
			case 'query_rows': return queryRows(this, parse('query_rows'));
			case 'import_rows': return importRows(this, parse('import_rows'));
			case 'dedupe_rows': return dedupeRows(this, parse('dedupe_rows'));
			case 'export_sheet': return exportSheet(this, parse('export_sheet'));
			case 'add_looot_column': return this.addLoootColumn(parse('add_looot_column'));
			case 'add_contact_columns': return this.addContactColumns(parse('add_contact_columns'));
			case 'unpack_column': return this.unpack(parse('unpack_column'));
			case 'set_column_routing': return this.routing(parse('set_column_routing'));
			case 'get_next_steps': {
				const { sheet, rows } = await this.snapshot(parse('get_next_steps').sheetId);
				return { suggestions: ghostColumns(sheet.columns, rows).map((ghost) => { const { name: title, op } = ghostColumnOp(ghost, sheet.columns); return { job: ghost.job, title: ghost.title, priceUsdPerRow: ghost.priceUsd, suggestedByRows: ghost.rows, from: ghost.source.name, column: { id: slug(title), name: title, type: 'enriched', op } }; }) };
			}
			case 'quote_run': return quoteColumnRun(this, parse('quote_run'));
			case 'run_column': return runQuotedColumn(this, parse('run_column'), this.onRunProgress);
			case 'get_run_status': return runStatus(this, parse('get_run_status'));
			case 'cancel_run': {
				const run = await this.ledger.cancel(parse('cancel_run').runId);
				return { runId: run.id, status: run.status, cancelRequested: true, message: run.status === 'running' ? 'No more cells will start. Cells already started finish and are saved.' : `This run is already ${run.status}.` };
			}
			case 'quote_find_rows': return quoteFindRows(this, parse('quote_find_rows'));
			case 'find_rows': return runFindRows(this, parse('find_rows'));
			case 'search_catalog': {
				const args = parse('search_catalog');
				const { endpoints, total } = await this.access.looot().search(args.query, args.limit, args.capability ? { capability: args.capability } : {});
				return { total: total ?? endpoints.length, endpoints: endpoints.slice(0, args.limit).map((hit) => ({ endpointId: hit.endpointId, provider: hit.provider ?? null, name: hit.name ?? null, job: hit.job?.id ?? hit.capability ?? null, priceUsd: parsePriceUsd(hit.estimatedPrice), costPerHitUsd: hit.costPerSuccessUsd ?? null, successRate: hit.works?.rate ?? null, p50Ms: hit.works?.p50Ms ?? null, runsNow: hit.access === undefined || hit.access === 'runs_now' })) };
			}
			case 'inspect_endpoint': {
				const { endpointId } = parse('inspect_endpoint');
				return { ...inspectSummary(endpointId, await this.access.looot().inspect(endpointId)) };
			}
			case 'get_spend': {
				const { sheetId } = parse('get_spend');
				const balance = this.access.key('looot') ? await this.access.looot().balance().catch(() => null) : null;
				return { loootBalanceUsd: balance ? round(balance.available) : null, reservedUsd: balance ? round(balance.reserved) : null, topUpUrl: balance?.topUpUrl ?? 'https://looot.ai/usage', sheet: sheetId ? await this.guard!.state(sheetId) : null };
			}
			case 'update_spend_guard': {
				const args = parse('update_spend_guard');
				if (args.resumeColumnId) await this.guard!.resumeColumn(args.sheetId, args.resumeColumnId);
				return { ...(args.capUsd !== undefined ? await this.guard!.setCap(args.sheetId, args.capUsd) : await this.guard!.state(args.sheetId)) };
			}
			case 'moltsets_plan': {
				parse('moltsets_plan');
				if (!this.access.key('moltsets')) return { connected: false, message: 'No MoltSets key in this workspace. Contact columns use looot only.' };
				return { connected: true, ...(await checkMoltSets(this.access.moltsets())) };
			}
			default: return super.call(tool, input);
		}
	}

	private async duplicate(args: Args<'duplicate_sheet'>) {
		const { sheet, rows } = await this.snapshot(args.sheetId);
		const now = Date.now();
		const id = args.newSheetId ?? `${slug(sheet.name).replace(/_/g, '-')}-${randomBytes(3).toString('hex')}`;
		const copy: Sheet = { ...sheet, id, name: args.name ?? `${sheet.name} (copy)`, revision: undefined, columns: sheet.columns.map((column) => ({ ...column, createdAt: now })), createdAt: now, updatedAt: now };
		delete copy.revision;
		const source = new Set(sheet.columns.filter((column) => column.type === 'source').map((column) => column.id));
		const copied: Row[] = args.rows === 'none' ? [] : rows.map((row) => ({ ...row, id: this.newRowId(), sheetId: id, cells: Object.fromEntries(Object.entries(row.cells).filter(([columnId, cell]) => (args.keepResults || source.has(columnId)) && cell.s !== 'running' && cell.s !== 'queued').map(([columnId, cell]) => [columnId, { ...cell, owner: undefined } as Cell])) }));
		await this.sheets.create(this.actor, { sheet: copy, rows: copied });
		return { sheetId: id, name: copy.name, rows: copied.length, url: `/app/sheets/${encodeURIComponent(id)}` };
	}

	private async addLoootColumn(args: Args<'add_looot_column'>) {
		const snapshot = await this.editable(args.sheetId, args.revision);
		const inspected = inspectSummary(args.endpointId, await this.access.looot().inspect(args.endpointId));
		const unknown = Object.keys(args.inputs).filter((input) => inspected.inputs.length && !inspected.inputs.some((entry) => entry.name === input));
		if (unknown.length) throw new WorkspaceError(`${args.endpointId} has no input ${unknown.join(', ')}. Its inputs: ${inspected.inputs.map((entry) => `${entry.name}${entry.required ? ' (required)' : ''}`).join(', ')}.`, 400);
		const op = ColumnOpSchema.parse({ kind: 'looot', endpointId: args.endpointId, inputs: args.inputs, inputTypes: Object.fromEntries(inspected.inputs.map((entry) => [entry.name, entry.type])), unitCostUsd: inspected.priceUsd, path: args.path, prefer: args.prefer });
		const column = this.newColumn(args.name, snapshot.sheet.columns);
		const saved = await this.configure(args.sheetId, args.revision, { id: args.columnId ?? column.id, name: column.name, type: 'enriched', op });
		return { columnId: args.columnId ?? column.id, name: column.name, revision: saved.revision, priceUsdPerRow: inspected.priceUsd, next: 'Call quote_run for this column, show the price, then run_column.' };
	}

	private async addContactColumns(args: Args<'add_contact_columns'>) {
		const snapshot = await this.editable(args.sheetId, args.revision);
		const columns = snapshot.sheet.columns;
		const named = (name: string | undefined) => name ? columns.find((column) => sameName(column.name, name) || column.id === name) : undefined;
		const person = named(args.nameColumn) ?? roleColumn(columns, 'person');
		const company = named(args.companyColumn) ?? roleColumn(columns, 'company');
		const website = named(args.websiteColumn) ?? roleColumn(columns, 'website');
		const linkedin = named(args.linkedinColumn) ?? roleColumn(columns, 'profile');
		if (!person && !linkedin) throw new WorkspaceError('Contact columns need a person: a Name column, or a LinkedIn column. Name them in nameColumn or linkedinColumn.', 400);
		const identity = { name: reference(person), company: reference(company), domain: reference(website) || reference(company), profileUrl: reference(linkedin) };
		const added: Array<{ columnId: string; name: string }> = [];
		let revision = args.revision, taken = [...columns];
		if (args.email) {
			if (!identity.name || !identity.domain) throw new WorkspaceError('Finding an email needs a name and a company website or company column.', 400);
			const column = this.newColumn('Work email', taken, { width: 250 });
			const op = ColumnOpSchema.parse({ kind: 'email-enrichment', ...identity, prefer: args.prefer, verify: args.verify, ...(args.source ? { source: args.source } : {}) });
			({ revision } = await this.configure(args.sheetId, revision, { id: column.id, name: column.name, type: 'enriched', op, width: column.width }));
			taken = [...taken, column];
			added.push({ columnId: column.id, name: column.name });
		}
		if (args.phone) {
			const column = this.newColumn('Phone', taken);
			const op = ColumnOpSchema.parse({ kind: 'phone-find', ...identity, prefer: args.prefer, ...(args.source ? { source: args.source } : {}) });
			({ revision } = await this.configure(args.sheetId, revision, { id: column.id, name: column.name, type: 'enriched', op }));
			added.push({ columnId: column.id, name: column.name });
		}
		return { added, revision, inputs: identity, next: 'Quote each new column with quote_run and run 5 rows first.' };
	}

	private async unpack(args: Args<'unpack_column'>) {
		const snapshot = await this.editable(args.sheetId, args.revision);
		const column = snapshot.sheet.columns.find((entry) => entry.id === args.columnId);
		if (!column) throw new WorkspaceError(`No column with id ${args.columnId}.`, 404);
		const available = unpackableFields(column, snapshot.rows);
		const fields = args.fields ? available.filter((field) => args.fields!.some((name) => sameName(name, field.name))) : available;
		if (!fields.length) throw new WorkspaceError(`Nothing to unpack from “${column.name}”${available.length ? `: pick from ${available.map((field) => field.name).join(', ')}` : ': run it first, its answers hold the fields'}.`, 422);
		const columns = [...snapshot.sheet.columns];
		const { columns: made, cells } = unpackColumns(column, snapshot.rows, fields, (field) => { const next = this.newColumn(field.name, columns, field.format ? { format: field.format } : {}); columns.push(next); return next; });
		const byRow = new Map<string, Row>();
		for (const { rowId, columnId, cell } of cells) {
			const row = byRow.get(rowId) ?? snapshot.rows.find((entry) => entry.id === rowId)!;
			const target = made.find((entry) => entry.id === columnId)!;
			byRow.set(rowId, { ...row, cells: { ...row.cells, [columnId]: admittedCell(target, cell, 'import') } });
		}
		const saved = await this.saveGrid(snapshot, { columns, rows: [...byRow.values()] });
		return { added: made.map((entry) => ({ columnId: entry.id, name: entry.name })), cellsFilled: cells.length, revision: saved.revision, costUsd: 0 };
	}

	private async routing(args: Args<'set_column_routing'>) {
		const snapshot = await this.editable(args.sheetId, args.revision);
		const column = snapshot.sheet.columns.find((entry) => entry.id === args.columnId);
		if (!column?.op) throw new WorkspaceError(`No enriched column with id ${args.columnId}.`, 404);
		const op = { ...column.op } as Record<string, unknown>;
		const set = (field: 'prefer' | 'exclude' | 'source', value: unknown) => {
			if (value === undefined) return;
			if (!(field in ColumnOpSchema.options.find((option) => option.shape.kind.value === column.op!.kind)!.shape)) throw new WorkspaceError(`A ${column.op!.kind} column has no ${field} setting.`, 400);
			op[field] = value;
		};
		set('prefer', args.prefer); set('exclude', args.exclude); set('source', args.source);
		const saved = await this.configure(args.sheetId, args.revision, { id: column.id, name: column.name, type: 'enriched', op: ColumnOpSchema.parse(op), ...(column.format ? { format: column.format } : {}) });
		return { columnId: column.id, revision: saved.revision, routing: { prefer: op.prefer ?? null, exclude: op.exclude ?? [], source: op.source ?? null } };
	}
}

/** The tools the in-app agent may call by itself: everything that reads or writes for free. Paid and destructive tools
    are left to the user's click and to MCP clients. */
export const AGENT_TOOL_NAMES = (Object.keys(SHEET_TOOLS) as ToolName[]).filter((name) => SHEET_TOOLS[name].kind === 'read' || SHEET_TOOLS[name].kind === 'write');
