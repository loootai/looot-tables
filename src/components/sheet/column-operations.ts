import { defaultEmailFind } from '@/lib/email-defaults';
import { columnsEntity, roleColumn } from '@/lib/column-roles';
import { instructionText, OPERATIONS } from '@/lib/operations';
import type { Column, ColumnOp, EntityKind, FormulaSuggestion, OpKind, Sheet } from '@/lib/types';

export type EditorKind = OpKind | 'formula';
export type EditorOp = ColumnOp | FormulaSuggestion;
export interface OperationChoice { kind: EditorKind; label: string; description: string; name: string }
export interface OperationGroup { id: 'ai' | 'decide' | 'web' | 'data' | 'email' | 'looot' | 'formula'; label: string; choices: OperationChoice[] }

/** A catalog operation as the picker shows it; `label` shortens the catalog label where the group already says what it is. */
const choice = (kind: OpKind, label = OPERATIONS[kind].label): OperationChoice => ({ kind, label, name: OPERATIONS[kind].columnName, description: OPERATIONS[kind].description });

/** Seven top-level choices; every operation kind stays reachable. */
export const OPERATION_GROUPS: OperationGroup[] = [
	{ id: 'ai', label: 'AI answer', choices: [choice('ai'), choice('answer'), choice('email-draft')] },
	{ id: 'decide', label: 'Classify', choices: [choice('check', 'True / false'), choice('classify', 'Category'), choice('score')] },
	{ id: 'web', label: 'Web page', choices: [choice('scrape'), choice('search')] },
	{ id: 'data', label: 'Company & person', choices: [choice('company', 'Company'), choice('person', 'Person')] },
	{ id: 'email', label: 'Find email', choices: [choice('email-enrichment', 'Work email'), choice('email-verify', 'Verify email'), choice('phone-find', 'Phone')] },
	{ id: 'looot', label: 'Any looot endpoint', choices: [choice('looot', 'Any looot endpoint')] },
	{ id: 'formula', label: 'Formula', choices: [
		{ kind: 'formula', label: 'Formula', name: 'Formula', description: 'Calculate or transform existing data locally, with a preview of up to 10 rows.' },
		choice('template'),
	] },
];

export function operationChoice(kind: EditorKind): OperationChoice {
	return OPERATION_GROUPS.flatMap((group) => group.choices).find((choice) => choice.kind === kind)!;
}

const columnRef = (name: string | undefined) => (name ? `{{${name}}}` : '');

export function guessDomainColumn(columns: Column[]): string | undefined {
	return (roleColumn(columns, ['website', 'webpage']) ?? columns.find((column) => column.format === 'url'))?.name;
}

function guessEmailColumn(columns: Column[]): string | undefined {
	return roleColumn(columns, 'email')?.name;
}

export function guessEntity(sheet: Sheet): EntityKind | undefined {
	return sheet.populate?.entity ?? columnsEntity(sheet.columns);
}

/** A starting point for each operation, pre-filled from the sheet's columns and the sentence already typed. */
export function defaultOp(kind: EditorKind, columns: Column[], jevAvailable: boolean, seed = ''): EditorOp {
	const decider = jevAvailable ? 'jev' : 'openai';
	const domainColumn = guessDomainColumn(columns);
	const domain = columnRef(domainColumn);
	switch (kind) {
		case 'formula':
			return { kind, request: seed };
		case 'email-enrichment': {
			const find = defaultEmailFind(columns);
			return { ...find, domain: find.domain || domain };
		}
		case 'email-verify':
			return { kind, email: columnRef(guessEmailColumn(columns)), prefer: 'balanced' };
		case 'phone-find': {
			const find = defaultEmailFind(columns);
			return { kind, name: find.name, company: find.company, domain: find.domain || domain, profileUrl: find.profileUrl, prefer: 'balanced' };
		}
		case 'looot':
			return { kind, endpointId: '', inputs: {}, inputTypes: {}, unitCostUsd: null, path: '', prefer: 'balanced' };
		case 'email-draft':
			return { kind, mode: 'ai', prompt: seed || 'Draft a personalized email using this row.', to: columnRef(guessEmailColumn(columns)), cc: '', bcc: '', subject: '', body: '' };
		case 'ai':
			return { kind, prompt: seed, output: 'text', research: 'web' };
		case 'check':
			return { kind, question: seed, decider, threshold: 0.5 };
		case 'classify':
			return { kind, question: seed, options: [], decider };
		case 'score':
			return { kind, question: seed, levels: ['Low', 'Medium', 'High'], decider };
		case 'scrape':
			return { kind, page: domainColumn ? { type: 'homepage', column: domainColumn } : { type: 'template', template: '' }, mode: 'highlights', maxChars: 2000 };
		case 'search':
			return { kind, query: '', pick: 'url', numResults: 3 };
		case 'company':
			return { kind, domain, field: 'description' };
		case 'person':
			return { kind, field: 'title' };
		case 'answer':
			return { kind, task: seed, output: 'text', mode: 'fast' };
		case 'template':
			return { kind, template: '' };
	}
}

/** The question already typed carries over when switching operations, so nothing written is lost. */
export function opSeed(op: EditorOp): string {
	return op.kind === 'formula' ? op.request : instructionText(op);
}
