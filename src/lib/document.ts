import { columnRole, type RoleColumn } from './column-roles';

export function isDocumentColumn(column: RoleColumn): boolean {
	return columnRole(column) === 'document';
}

export function documentTitle(markdown: string, fallback = 'Document'): string {
	const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1];
	return heading?.replace(/[*_`]/g, '').trim() || fallback;
}

export function documentFilename(title: string): string {
	return (title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\.+$/g, '').trim().slice(0, 120) || 'Document') + '.pdf';
}
