import type { Column, ColumnOp } from './types';

export type Prefer = 'balanced' | 'cheapest' | 'reliable' | 'fastest';
export const PREFER_LABEL: Record<Prefer, string> = { balanced: 'Balanced', cheapest: 'Cheapest', reliable: 'Reliable', fastest: 'Fastest' };

/** The looot job a column runs with fallback, and its routing: what the header's pill and routing editor change. */
export function routedJob(op: ColumnOp | undefined): { job: string; prefer: Prefer; exclude: string[] } | null {
	switch (op?.kind) {
		case 'email-enrichment': return { job: 'people.email.find', prefer: op.prefer, exclude: op.exclude ?? [] };
		case 'email-verify': return { job: 'people.email.verify', prefer: op.prefer, exclude: op.exclude ?? [] };
		case 'phone-find': return { job: 'people.phone.find', prefer: op.prefer, exclude: op.exclude ?? [] };
		case 'company': return { job: 'company.enrich', prefer: op.prefer ?? 'balanced', exclude: op.exclude ?? [] };
		case 'looot': return op.endpointId.startsWith('job:') ? { job: op.endpointId.slice(4), prefer: op.prefer, exclude: op.exclude ?? [] } : null;
		default: return null;
	}
}

/** The column's op with a new routing. */
export function withRouting(column: Column, routing: { prefer: Prefer; exclude: string[] }): ColumnOp | undefined {
	const op = column.op;
	if (!op || !routedJob(op)) return op;
	const exclude = routing.exclude.length ? routing.exclude : undefined;
	return { ...op, prefer: routing.prefer, exclude } as ColumnOp;
}

/** "Edit column" for a looot lookup column (its job and routing), "Edit AI column" for a column an AI model writes. */
export function editColumnLabel(op: ColumnOp | undefined): string {
	return routedJob(op) ? 'Edit column' : 'Edit AI column';
}
