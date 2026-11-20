import { roleColumn } from './column-roles';
import type { CellValue, Column, ColumnOp, NextStep, Row } from './types';

/* Next-step ghost columns. After a hit, looot suggests up to 3 priced follow-up jobs per run. The sheet gathers them per
   job, across the settled cells, as faint columns at its right edge. A click turns one into a real column; nothing
   runs until the user runs it. */

export interface GhostColumn {
	job: string;
	title: string;
	/** The median suggested price per row, or null when looot priced none. */
	priceUsd: number | null;
	/** How many rows suggested it. */
	rows: number;
	/** The column whose answers suggested it. */
	source: Column;
	/** One suggestion and its row, to map the job's inputs back to columns. */
	sample: { row: Row; step: NextStep };
}

const JOB_OF: Partial<Record<ColumnOp['kind'], string>> = { 'email-enrichment': 'people.email.find', 'email-verify': 'people.email.verify', 'phone-find': 'people.phone.find', company: 'company.enrich' };

/** The job a column already runs, so a suggestion for it is not offered again. */
export function columnJob(column: Column): string | null {
	const op = column.op;
	if (!op) return null;
	if (op.kind === 'looot') return op.endpointId.startsWith('job:') ? op.endpointId.slice(4) : null;
	if (op.kind === 'email-enrichment' && op.verify) return 'people.email.find+verify';
	return JOB_OF[op.kind] ?? null;
}

/** Up to `limit` ghost columns, most suggested first. */
export function ghostColumns(columns: readonly Column[], rows: readonly Row[], limit = 3): GhostColumn[] {
	const present = new Set(columns.flatMap((column) => { const job = columnJob(column); return job === 'people.email.find+verify' ? ['people.email.find', 'people.email.verify'] : job ? [job] : []; }));
	const byJob = new Map<string, { title: string; prices: number[]; rows: number; source: Column; sample: GhostColumn['sample'] }>();
	for (const column of columns) {
		if (column.type !== 'enriched' || column.hidden) continue;
		for (const row of rows) {
			const cell = row.cells[column.id];
			if (cell?.s !== 'done') continue;
			for (const call of cell.m?.looot ?? []) for (const step of call.nextSteps ?? []) {
				if (present.has(step.job)) continue;
				const entry = byJob.get(step.job) ?? { title: step.title, prices: [], rows: 0, source: column, sample: { row, step } };
				entry.rows++;
				if (step.priceUsd !== null) entry.prices.push(step.priceUsd);
				byJob.set(step.job, entry);
			}
		}
	}
	return [...byJob].map(([job, entry]) => {
		const prices = [...entry.prices].sort((a, b) => a - b);
		return { job, title: entry.title, priceUsd: prices.length ? prices[Math.floor(prices.length / 2)] : null, rows: entry.rows, source: entry.source, sample: entry.sample };
	}).sort((a, b) => b.rows - a.rows).slice(0, limit);
}

const ref = (column: Column | undefined) => column ? `{{${column.name}}}` : '';
const same = (a: CellValue | undefined, b: unknown) => a !== null && a !== undefined && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** The column a ghost becomes. Known jobs use their own column kind; any other job becomes a looot job column whose
    inputs point at the columns holding the suggested values. */
export function ghostColumnOp(ghost: GhostColumn, columns: readonly Column[]): { name: string; op: ColumnOp } {
	const source = ghost.source.op;
	const identity = source && (source.kind === 'email-enrichment' || source.kind === 'phone-find') ? { name: source.name, company: source.company, domain: source.domain, profileUrl: source.profileUrl } : { name: ref(roleColumn(columns, 'person')), company: ref(roleColumn(columns, 'company')), domain: ref(roleColumn(columns, 'website')), profileUrl: ref(roleColumn(columns, 'profile')) };
	switch (ghost.job) {
		case 'people.email.verify': return { name: 'Email status', op: { kind: 'email-verify', email: ref(ghost.source), prefer: 'balanced' } };
		case 'people.phone.find': return { name: 'Phone', op: { kind: 'phone-find', ...identity, prefer: 'balanced' } };
		case 'company.enrich': return { name: 'Company info', op: { kind: 'company', domain: identity.domain || ref(roleColumn(columns, 'website')), field: 'description' } };
	}
	const inputs = Object.fromEntries(Object.entries(ghost.sample.step.input).map(([key, value]) => {
		const column = columns.find((entry) => same(ghost.sample.row.cells[entry.id]?.v, value));
		return [key, column ? ref(column) : String(value)];
	}));
	return { name: ghost.title, op: { kind: 'looot', endpointId: `job:${ghost.job}`, inputs, inputTypes: {}, unitCostUsd: ghost.priceUsd, path: '', prefer: 'balanced' } };
}
