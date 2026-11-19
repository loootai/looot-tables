/* Mapping a table row onto a looot endpoint's inputs. Each input holds a template such as `{{Company website}}` or
   `https://{{Domain}}/about`. A template that is exactly one reference passes that cell's value as it is, so a list or
   a number keeps its type. Ported from the first looot-tables app, which keeps these rules in one small module. */

export type InputMap = Record<string, string>;
export type InputTypes = Record<string, string | undefined>;

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

function isEmpty(value: unknown): boolean {
	return value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
}

function asText(value: unknown): string {
	if (isEmpty(value)) return '';
	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Convert a mapped value to the JSON type the endpoint declares for that input. */
export function coerceValue(value: unknown, type: string | undefined): unknown {
	if (type === 'array' && value !== null && value !== undefined && !Array.isArray(value)) {
		return typeof value === 'string' ? (value.trim() === '' ? value : [value.trim()]) : [value];
	}
	if (typeof value !== 'string') return value;
	const text = value.trim();
	if (type === 'number' || type === 'integer') {
		const parsed = Number(text);
		return text !== '' && Number.isFinite(parsed) ? parsed : value;
	}
	if (type === 'boolean') {
		if (/^(true|yes|1)$/i.test(text)) return true;
		if (/^(false|no|0)$/i.test(text)) return false;
	}
	return value;
}

/** Column names a template refers to, in order, without repeats. */
export function placeholdersIn(template: string): string[] {
	const names: string[] = [];
	for (const match of template.matchAll(PLACEHOLDER)) if (!names.includes(match[1])) names.push(match[1]);
	return names;
}

/** Look a column up by name, ignoring case, the way `{{Column}}` references do everywhere else in the app. */
function cellOf(row: Record<string, unknown>, name: string): unknown {
	if (name in row) return row[name];
	const lower = name.toLowerCase();
	const key = Object.keys(row).find((candidate) => candidate.toLowerCase() === lower);
	return key === undefined ? undefined : row[key];
}

/** Build the endpoint input for one row. Inputs whose columns are all empty are left out and listed in `empty`. */
export function applyInputMap(map: InputMap | null | undefined, row: Record<string, unknown>, types: InputTypes = {}): { input: Record<string, unknown>; empty: string[] } {
	const input: Record<string, unknown> = {};
	const empty: string[] = [];
	for (const [name, template] of Object.entries(map ?? {})) {
		const whole = WHOLE_PLACEHOLDER.exec(template);
		const refs = placeholdersIn(template);
		let value: unknown;
		if (whole) value = cellOf(row, whole[1]);
		else if (refs.length === 0) value = template;
		else value = refs.every((ref) => isEmpty(cellOf(row, ref))) ? undefined : template.replace(PLACEHOLDER, (_all, ref: string) => asText(cellOf(row, ref)));
		if (isEmpty(value)) empty.push(name);
		else input[name] = coerceValue(value, types[name]);
	}
	return { input, empty };
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Suggest `{{Column}}` for every endpoint input whose name matches a column name, ignoring case and punctuation. */
export function suggestInputMap(inputNames: string[], columnNames: string[]): InputMap {
	const map: InputMap = {};
	for (const input of inputNames) {
		const match = columnNames.find((column) => norm(column) === norm(input));
		map[input] = match ? `{{${match}}}` : '';
	}
	return map;
}

/** Pick a value out of an answer with a dot path such as `data.0.email`. An empty path returns the whole value. */
export function getPath(value: unknown, path: string | null | undefined): unknown {
	const trimmed = (path ?? '').trim();
	if (!trimmed) return value;
	let current: unknown = value;
	for (const part of trimmed.split('.')) {
		if (current === null || typeof current !== 'object') return null;
		current = (current as Record<string, unknown>)[part];
		if (current === undefined) return null;
	}
	return current;
}

/** Cost of running one column over `rowCount` rows at a per-row price in USD, rounded to millionths of a dollar. */
export function estimateCost(unitCostUsd: number | null | undefined, rowCount: number): number | null {
	if (unitCostUsd === null || unitCostUsd === undefined || !Number.isFinite(unitCostUsd)) return null;
	return Math.round(unitCostUsd * rowCount * 1e6) / 1e6;
}

/** A USD amount with enough digits for sub-cent prices. */
export function formatUsd(amount: number | null | undefined): string {
	if (amount === null || amount === undefined) return 'price unknown';
	if (amount === 0) return '$0';
	if (amount < 0.01) return `$${amount.toFixed(4)}`;
	if (amount < 1) return `$${amount.toFixed(3).replace(/0$/, '')}`;
	return `$${amount.toFixed(2)}`;
}
