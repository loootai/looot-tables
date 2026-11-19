import type { Column, ColumnOp } from './types';
import { columnRole, roleColumn, type ColumnRole } from './column-roles';

type CompanyField = Extract<ColumnOp, { kind: 'company' }>['field'];
type PersonField = Extract<ColumnOp, { kind: 'person' }>['field'];
export type WebField = ({ kind: 'website' } | { kind: 'webpage' }) & { field: Extract<ColumnOp, { kind: 'scrape' }>['mode'] | 'pricing' | 'careers' | 'about' | 'contact' | 'docs'; label: string };
type FieldRun = { rowId: string; count: number; scope?: 'cell' | 'below' | 'column' };
export type EntityField = (WebField | { kind: 'company'; field: CompanyField; label: string } | { kind: 'person'; field: PersonField; label: string } | { kind: 'custom'; entity: 'company' | 'person' | 'website' | 'webpage'; query: string; label: string }) & { run?: FieldRun };
export interface EntityFieldGroup { label: string; fields: Exclude<EntityField, { kind: 'custom' }>[] }

function company(label: string, fields: [CompanyField, string][]): EntityFieldGroup {
	return { label, fields: fields.map(([field, label]) => ({ kind: 'company', field, label })) };
}
function person(label: string, fields: [PersonField, string][]): EntityFieldGroup {
	return { label, fields: fields.map(([field, label]) => ({ kind: 'person', field, label })) };
}
const webFields: WebField[] = [
	['extract', 'Extract data…'], ['markdown', 'Get Markdown'], ['links', 'Get links'],
	['title', 'Get page title'], ['html', 'Get HTML'], ['images', 'Get images'],
	['emails', 'Get email addresses'], ['phone-numbers', 'Get phone numbers'],
].map(([field, label]) => ({ kind: 'webpage', field: field as WebField['field'], label }));
export const ENTITY_FIELDS = {
	website: [
		{ label: 'Website actions', fields: [...webFields.map((field) => ({ ...field, kind: 'website' as const })), { kind: 'website' as const, field: 'map' as const, label: 'Discover site URLs' }] },
		{ label: 'Find a page', fields: ['pricing', 'careers', 'about', 'contact', 'docs'].map((field) => ({ kind: 'website' as const, field: field as WebField['field'], label: `Find ${field} page` })) },
	],
	webpage: [{ label: 'Webpage actions', fields: webFields }],
	company: [
		company('Overview', [['title', 'Name'], ['description', 'Description'], ['slogan', 'Slogan'], ['industry', 'Industry'], ['employees', 'Employees'], ['ticker', 'Stock ticker'], ['language', 'Primary language']]),
		company('Funding', [['funding_total', 'Total raised (USD)'], ['funding_stage', 'Current stage'], ['funding_latest_round', 'Latest round'], ['funding_latest_date', 'Latest round date'], ['funding_latest_amount', 'Latest round amount (USD)'], ['funding_round_count', 'Round count']]),
		company('Address', [['address', 'Full address'], ['city', 'City'], ['country', 'Country']]),
		company('Contact', [['email', 'Email'], ['phone', 'Phone']]),
		company('Social profiles', [['linkedin', 'LinkedIn URL'], ['twitter', 'X / Twitter URL']]),
		company('Links', [['pricing_url', 'Pricing page URL'], ['careers_url', 'Careers page URL'], ['blog_url', 'Blog URL'], ['contact_url', 'Contact page URL']]),
		company('Brand', [['logo_url', 'Logo URL'], ['primary_color', 'Primary color']]),
	],
	person: [
		person('Profile', [['full_name', 'Full name'], ['bio', 'Bio'], ['location', 'Location']]),
		person('Employment', [['title', 'Job title'], ['company', 'Company'], ['company_domain', 'Company website'], ['years_at_company', 'Years at company'], ['experience', 'Experience']]),
		person('Contact', [['email', 'Email'], ['linkedin', 'LinkedIn URL']]),
		person('Education', [['schools', 'Schools'], ['degrees', 'Degrees']]),
		person('Skills', [['skills', 'Skills']]),
	],
};

export function entityKind(column: Column): 'company' | 'person' | 'website' | 'webpage' | null {
	const role = columnRole(column);
	return role === 'company' || role === 'person' || role === 'website' || role === 'webpage' ? role : null;
}

/** Bind the new enrichment to columns, so every row uses its own entity. */
export function entityFieldOp(source: Column, columns: Column[], field: EntityField): ColumnOp {
	if (field.kind === 'website' || field.kind === 'webpage') {
		const page = { type: field.kind === 'website' ? 'homepage' as const : 'column' as const, column: source.name };
		if (['pricing', 'careers', 'about', 'contact', 'docs'].includes(field.field)) return { kind: 'scrape', page: { type: 'find', column: source.name, page: field.field }, mode: 'url', maxChars: 2000 };
		return { kind: 'scrape', page, mode: field.field as Extract<ColumnOp, { kind: 'scrape' }>['mode'], maxChars: 20000 };
	}
	if (field.kind === 'custom') return {
		kind: 'ai',
		prompt: `Answer this question about the ${field.entity} in {{${source.name}}}. Use the other fields in this row to identify the correct ${field.entity}. Return a concise answer for this row only.

Question: ${field.query}`,
		output: 'text',
		research: 'web',
		...(['website', 'webpage'].includes(field.entity) ? { page: { type: field.entity === 'website' ? 'homepage' as const : 'column' as const, column: source.name } } : {}),
	};
	const ref = (column: Column) => `{{${column.name}}}`;
	const find = (roles: ColumnRole | ColumnRole[]) => roleColumn(columns, roles, source.id);
	if (field.kind === 'company') {
		const domain = find('website');
		return { kind: 'company', field: field.field, domain: domain ? ref(domain) : source.op?.kind === 'company' ? source.op.domain : ref(source) };
	}
	const employer = find(['company', 'website']) ?? find('employer-hint');
	const email = find('email');
	const profile = find('profile');
	return { kind: 'person', field: field.field, name: ref(source), company: employer && ref(employer), email: email && ref(email), profileUrl: profile && ref(profile) };
}
