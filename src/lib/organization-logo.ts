import { columnRole, type RoleColumn } from './column-roles';

export function organizationKind(column: RoleColumn): 'company' | 'school' | null {
	const role = columnRole(column);
	return role === 'company' || role === 'school' ? role : null;
}

export function logoDomain(value: string | undefined): string | null {
	if (!value?.trim()) return null;
	try {
		const text = value.trim();
		const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
		const host = url.hostname.toLowerCase().replace(/^www\./, '');
		return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(host) ? host : null;
	} catch {
		return null;
	}
}

export function logoLinkUrl(clientId: string, domain: string): string {
	return `https://logos.context.dev/?${new URLSearchParams({ publicClientId: clientId, domain, type: 'icon' })}`;
}
