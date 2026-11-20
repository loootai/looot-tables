import { columnRole } from './column-roles';
import { logoDomain } from './organization-logo';
import type { Row, Sheet } from './types';

export type DocumentBrand = { name: string; domain: string; accentColor?: string; logoUrl?: string; logoData?: string };
export type DocumentBranding = { primary?: DocumentBrand; secondary?: DocumentBrand };

export function brandAccent(value?: string): string {
	const color = value?.trim();
	return color && /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(color) ? color : '#64748b';
}

export function documentClientDomain(sheet: Pick<Sheet, 'columns'>, row: Row): string {
	const domains = new Set<string>();
	for (const column of sheet.columns) {
		const cell = row.cells[column.id];
		const organization = cell?.m?.organization;
		const intel = cell?.m?.companyIntel;
		const value = typeof cell?.v === 'string' ? cell.v : '';
		const domain = organization && organization.name === value ? logoDomain(organization.domain)
			: intel ? logoDomain(intel.domain)
			: ['company', 'website'].includes(columnRole(column) ?? '') ? logoDomain(value) : null;
		if (domain) domains.add(domain);
	}
	return domains.size === 1 ? [...domains][0] : '';
}

export function documentBrand(data: { domain?: string; title?: string; colors?: Array<{ hex?: string }>; logos?: Array<{ url?: string; mode?: string; type?: string }> }, domain: string): DocumentBrand {
	const logos = (data.logos ?? []).filter((logo) => logo.mode !== 'dark' && logo.url?.startsWith('https://'));
	return { name: data.title || domain, domain, accentColor: data.colors?.map((color) => color.hex).find((color) => color && /^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(color)), logoUrl: (logos.find((logo) => logo.type === 'logo') ?? logos[0])?.url };
}
