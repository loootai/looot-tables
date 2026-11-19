import { referenceDependents } from '@/lib/references';
import type { Column } from '@/lib/types';

export const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
export const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' });

/** Deleting leaves references to the column dangling; say which AI columns read it so they can be fixed. */
export function deleteColumnNotice(columns: Column[], column: Column): string {
	const dependents = referenceDependents(columns, column.id).map((entry) => `“${entry.name}”`);
	if (!dependents.length) return 'The column and its values are removed from every row.';
	const one = dependents.length === 1;
	return `The column and its values are removed from every row. ${listFormat.format(dependents)} ${one ? 'reads' : 'read'} it, so ${one ? 'its' : 'their'} cells will fail until you edit ${one ? 'that column' : 'those columns'}.`;
}
