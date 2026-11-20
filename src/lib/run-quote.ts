'use client';

import { quoteRun } from './api';
import type { RunQuote } from './run-cost';
import type { RunPlan } from './sheet-commands';

/** The server's quote for a whole run plan: every column's most-it-can-cost added up, and the sheet's cap. */
export async function quotePlan(plan: Extract<RunPlan, { kind: 'run' }>, sheetId: string, signal?: AbortSignal): Promise<RunQuote> {
	const quotes = await Promise.all(plan.groups.map((group, index) => quoteRun({ op: group.op, cells: group.cells, records: group.records, ...(index === 0 ? { sheetId } : {}) }, signal)));
	const sum = (pick: (quote: RunQuote) => number) => Math.round(quotes.reduce((total, quote) => total + pick(quote), 0) * 1e6) / 1e6;
	return {
		cells: sum((quote) => quote.cells),
		perCellMaxUsd: Math.max(0, ...quotes.map((quote) => quote.perCellMaxUsd)),
		maxUsd: sum((quote) => quote.maxUsd),
		typicalUsd: sum((quote) => quote.typicalUsd),
		source: quotes.every((quote) => quote.source === 'looot') ? 'looot' : 'estimate',
		...(quotes[0]?.sheet ? { sheet: quotes[0].sheet } : {}),
	};
}
