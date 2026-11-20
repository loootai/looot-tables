/* What each agent tool call reads as in the panel: one short line, past tense once it has an answer. */

type Data = Record<string, unknown>;
const count = (value: unknown, unit: string) => { const n = Number(value ?? 0); return `${n.toLocaleString('en-US')} ${unit}${n === 1 ? '' : 's'}`; };
const names = (value: unknown) => Array.isArray(value) ? value.map((entry) => typeof entry === 'string' ? entry : String((entry as Data)?.name ?? '')).filter(Boolean).join(', ') : '';

const OPERATION_LABELS: Record<string, string> = {
	'email-enrichment': 'people.email.find', 'email-verify': 'people.email.verify', 'phone-find': 'people.phone.find', company: 'company.enrich', person: 'people.enrich',
	ai: 'AI with web research', answer: 'deep research', scrape: 'web.scrape.markdown', search: 'web.search', check: 'true or false check', classify: 'classify', score: 'score', template: 'template', 'email-draft': 'email draft',
};

function operationLabel(op: unknown): string {
	const kind = String((op as Data)?.kind ?? '');
	if (kind === 'looot') return String((op as Data).endpointId ?? 'looot');
	if (kind === 'email-enrichment' && (op as Data).verify) return 'people.email.find + verify';
	return OPERATION_LABELS[kind] ?? kind;
}

/** [while running, once done] for a tool call. */
export function stepText(tool: string, input: Data = {}, output?: Data): string {
	const done = output !== undefined;
	switch (tool) {
		case 'list_sheets': return done ? `Read ${count((output.sheets as unknown[])?.length, 'sheet')}` : 'Reading sheets';
		case 'get_sheet': return done ? `Read ${String((output.sheet as Data)?.name ?? 'the sheet')}` : 'Reading the sheet';
		case 'query_rows': return done ? `Read ${count(output.matched, 'row')}` : 'Reading rows';
		case 'create_sheet': return done ? `Created sheet ${String((output.sheet as Data)?.name ?? input.name ?? '')}` : `Creating sheet ${String(input.name ?? '')}`;
		case 'rename_sheet': return `Renamed the sheet to ${String(input.name ?? '')}`;
		case 'duplicate_sheet': return done ? `Copied the sheet · ${count(output.rows, 'row')}` : 'Copying the sheet';
		case 'upsert_rows': return `Added ${count((input.rows as unknown[])?.length, 'row')}`;
		case 'update_cells': return `Edited ${count((input.cells as unknown[])?.length, 'cell')}`;
		case 'delete_rows': return `Deleted ${count((input.rowIds as unknown[])?.length, 'row')}`;
		case 'import_rows': return done ? `Imported ${count(output.imported, 'row')}` : 'Importing CSV';
		case 'dedupe_rows': return done ? (output.dryRun ? `Found ${count(output.duplicates, 'duplicate')}` : `Removed ${count(output.deleted, 'duplicate')}`) : 'Looking for duplicates';
		case 'export_sheet': return done ? `Exported ${count(output.rows, 'row')} as ${String(output.format ?? '').toUpperCase()}` : 'Exporting';
		case 'save_view': return 'Saved the view';
		case 'configure_column': { const column = input.column as Data | undefined; return `Added column ${String(column?.name ?? '')}${column?.op ? ` · ${operationLabel(column.op)}` : ''}`; }
		case 'add_looot_column': return `Added column ${String(input.name ?? '')} · ${String(input.endpointId ?? '')}`;
		case 'add_contact_columns': return done ? `Added column ${names(output.added) || 'Work email'} · ${input.verify === false ? 'people.email.find' : 'people.email.find + verify'}` : 'Adding email columns';
		case 'unpack_column': return done ? `Unpacked ${names(output.added)} · $0` : 'Unpacking fields';
		case 'set_column_routing': return 'Changed the column’s routing';
		case 'get_next_steps': return done ? `Found ${count((output.suggestions as unknown[])?.length, 'suggested column')}` : 'Looking for next steps';
		case 'quote_run': return done ? `Quote ${String(output.label ?? '').replace(/^Run /, 'for ')}` : 'Pricing the run';
		case 'quote_find_rows': return done ? `Quote ${String(output.label ?? '').replace(/^Find /, 'to find ')}` : 'Pricing the search';
		case 'get_run_status': return 'Checked progress';
		case 'cancel_run': return 'Stopped the run';
		case 'get_cell_details': return 'Read a cell’s receipt';
		case 'search_catalog': return done ? `Searched the catalog · ${count((output.endpoints as unknown[])?.length, 'endpoint')}` : 'Searching the catalog';
		case 'inspect_endpoint': return `Inspected ${String(input.endpointId ?? '')}`;
		case 'get_spend': return 'Checked balance and spend';
		case 'moltsets_plan': return 'Checked the MoltSets plan';
		default: return tool.replace(/_/g, ' ');
	}
}
