import type { Column, ColumnFormat, ColumnOp, ColumnType, EntityKind } from './types';

/* Which part a column plays in a row: the company's website, the person's name, their email… Every caller that needs
   "the website column" asks here, so a column counts the same way for entity fields, Find email defaults, company
   previews, logos and documents.

   A column has at most one role. Its format decides first; then what its operation declares it returns (an operation
   that returns some other fact plays no role, whatever its header); then its header. A header names a web role only
   while the column has no format, or the URL format: any other format says it is not a web address. */

export type ColumnRole =
	| 'website' | 'webpage' | 'school-website'
	| 'company' | 'school' | 'employer-hint'
	| 'person' | 'first-name' | 'last-name' | 'email' | 'profile' | 'photo' | 'logo'
	| 'document' | 'email-draft';

export type RoleColumn = Pick<Column, 'format' | 'op'> & Partial<Pick<Column, 'id' | 'name'>>;

const HEADERS: Record<Exclude<ColumnRole, 'document' | 'email-draft'>, string[]> = {
	website: ['domain', 'website', 'site', 'company domain', 'company website'],
	webpage: ['url', 'webpage', 'web page', 'page url'],
	'school-website': ['school domain', 'university domain', 'school website'],
	company: ['company', 'companies', 'company name', 'employer', 'organization', 'organisation'],
	school: ['school', 'schools', 'university', 'universities', 'college', 'colleges', 'institution', 'institutions'],
	// Company clues supplied to a people search; they identify the employer only when nothing better does.
	'employer-hint': ['company hint', 'supplied company', 'supplied company domain'],
	person: ['name', 'full name', 'person', 'person name', 'people', 'contact', 'contact name'],
	'first-name': ['first name'],
	'last-name': ['last name'],
	email: ['email', 'e-mail', 'email address', 'work email'],
	profile: ['linkedin', 'linkedin url', 'profile url', 'profile hint'],
	photo: ['profile photo', 'profile photo url', 'avatar_url'],
	logo: ['logo', 'logo url', 'company logo', 'logo_url'],
};
const BY_HEADER = new Map(Object.entries(HEADERS).flatMap(([role, names]) => names.map((name) => [name, role as ColumnRole])));
const BY_FORMAT: Partial<Record<ColumnFormat, ColumnRole>> = { website: 'website', webpage: 'webpage', email: 'email', document: 'document', 'email-draft': 'email-draft' };
const BY_FIELD: Record<string, ColumnRole> = { full_name: 'person', company: 'company', schools: 'school', company_domain: 'website', linkedin: 'profile', email: 'email' };
const WEB: ReadonlySet<ColumnRole> = new Set(['website', 'webpage', 'school-website']);

const headerRole = (name: string | undefined) => (name === undefined ? null : BY_HEADER.get(name.trim().toLowerCase()) ?? null);

/** null: the operation returns a fact that plays no role. undefined: it declares nothing, so the header decides. */
function declaredRole(op: ColumnOp | undefined): ColumnRole | null | undefined {
	switch (op?.kind) {
		case 'email-draft': return 'email-draft';
		case 'ai': case 'answer': return op.output === 'document' ? 'document' : undefined;
		case 'company': return op.field === 'title' ? 'company' : null;
		case 'person': return BY_FIELD[op.field] ?? null;
		case 'email-enrichment': return 'email';
		case 'email-verify': return null;
		case 'scrape': return op.mode === 'url' ? 'webpage' : undefined;
		default: return undefined;
	}
}

export function columnRole(column: RoleColumn): ColumnRole | null {
	const formatted = column.format && BY_FORMAT[column.format];
	if (formatted) return formatted;
	const declared = declaredRole(column.op);
	const role = declared === undefined ? headerRole(column.name) : declared;
	return role && WEB.has(role) && column.format && column.format !== 'url' ? null : role;
}

/** The first column, in sheet order, playing any of `roles`; `except` skips one column by ID. */
export function roleColumn<T extends RoleColumn>(columns: readonly T[], roles: ColumnRole | readonly ColumnRole[], except?: string): T | undefined {
	return columns.find((column) => (except === undefined || column.id !== except) && plays(column, roles));
}

export function roleColumns<T extends RoleColumn>(columns: readonly T[], roles: ColumnRole | readonly ColumnRole[]): T[] {
	return columns.filter((column) => plays(column, roles));
}

function plays(column: RoleColumn, roles: ColumnRole | readonly ColumnRole[]) {
	const role = columnRole(column);
	return role !== null && (typeof roles === 'string' ? role === roles : roles.includes(role));
}

/** What a sheet's columns say it lists: profiles mean people, websites companies, and pages websites. */
export function columnsEntity(columns: readonly RoleColumn[]): EntityKind | undefined {
	const roles = new Set(columns.map(columnRole));
	return roles.has('profile') ? 'people' : roles.has('website') ? 'companies' : roles.has('webpage') ? 'websites' : undefined;
}

/** The strict format a new column starts with. A source column's header may name a web column; an enrichment's format
    comes only from what its operation declares it returns, never from its header, so an AI column called "Website"
    stays free text and an answer like "N/A" is not rejected. */
export function inferredFormat(column: { name: string; type: ColumnType; op?: ColumnOp }): 'website' | 'webpage' | undefined {
	const role = column.type === 'source' ? headerRole(column.name) : declaredRole(column.op);
	return role === 'website' || role === 'webpage' ? role : undefined;
}
