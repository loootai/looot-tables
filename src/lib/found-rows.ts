import { roleColumn, type ColumnRole } from './column-roles';
import { profileUrl } from './profile-photo';
import { ENTITY_COLUMNS, type CellMeta, type CellValue, type Column, type EntityKind, type FoundRow } from './types';

/* Find rows' wire format, shared by the server that finds rows and the sheet that saves them. A found row maps field
   names to values; one field per entity kind is its key, and both sides dedupe on the key's identity. In a sheet the
   key lands in the source column playing the key's Column role, whatever it is called now, so a renamed Website column
   still receives domains and still tells the server which companies the sheet already lists. */

const KEYS: Record<EntityKind, { field: string; role: ColumnRole }> = {
	companies: { field: 'Domain', role: 'website' },
	people: { field: 'LinkedIn', role: 'profile' },
	websites: { field: 'URL', role: 'webpage' },
};
/** The key field's name for an entity kind, as the server's found rows spell it. */
export const foundRowKeyField = (entity: EntityKind) => KEYS[entity].field;

/** A person's photo shows on their Name cell rather than in a column. */
const PHOTO = 'Profile photo';

type SheetColumn = Pick<Column, 'name' | 'type' | 'format' | 'op'>;

/** What two key values share when they name the same company, person or page: case, scheme, `www.` and trailing
    slashes don't count. */
export function foundRowKey(value: CellValue | undefined): string {
	if (value === null || value === undefined) return '';
	return String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
}

// Wire fields (and columns from before the layouts were renamed) use older names for the layout's columns.
const LAYOUT_NAMES: Record<string, string> = { url: 'Webpage', domain: 'Website', 'company domain': 'Company website' };
const layoutName = (name: string) => LAYOUT_NAMES[name.trim().toLowerCase()] ?? name;
const label = (name: string) => layoutName(name).toLowerCase();

/** Where found rows of `entity` go among `columns`: the key by role (else by layout name), every other field by name. */
export function foundRowColumns<C extends SheetColumn>(entity: EntityKind, columns: readonly C[]) {
	const named = (name: string) => columns.find((column) => label(column.name) === label(name));
	const key = roleColumn(columns.filter((column) => column.type === 'source'), KEYS[entity].role) ?? named(KEYS[entity].field);
	/** The column a wire field or layout column fills. */
	const column = (name: string) => (label(name) === label(KEYS[entity].field) ? key : named(name));
	const layout = ENTITY_COLUMNS[entity];
	return {
		key,
		column,
		/** Layout columns the sheet lacks. */
		missing: layout.filter((entry) => !column(entry.name)),
		/** A column's place in the layout; columns outside it go last. */
		rank: (target: C) => { const index = layout.findIndex((entry) => column(entry.name) === target); return index < 0 ? layout.length : index; },
	};
}

/** Found rows as records keyed by the sheet's column names, with people's photos as Name cell metadata, and the column
    that identifies a row. A field with no column keeps its layout name, so appending creates it. */
export function foundRecords(entity: EntityKind, rows: readonly FoundRow[], columns: readonly SheetColumn[]) {
	const { column } = foundRowColumns(entity, columns);
	const name = (field: string) => column(field)?.name ?? layoutName(field);
	const people = entity === 'people';
	return {
		records: rows.map((row) => Object.fromEntries(Object.entries(row).flatMap(([field, value]) => people && field === PHOTO ? [] : [[name(field), value]]))),
		cellMeta: rows.map((row): Record<string, CellMeta> => people && typeof row.Name === 'string' ? { [name('Name')]: { person: { name: row.Name, avatarUrl: profileUrl(row[PHOTO]) } } } : {}),
		dedupeOn: name(KEYS[entity].field),
	};
}
