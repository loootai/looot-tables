import 'server-only';

import { batchJob, cellCapUsd, costPerCell, type RunQuote } from '../run-cost';
import type { CellValue, ColumnOp } from '../types';
import type { LoootClient } from './looot';
import { emailFindInput, phoneFindInput } from './looot-jobs';
import { emailIdentity, phoneIdentity, verifyAddress } from './enrich';
import { logoDomain } from '../organization-logo';
import { renderTemplate } from '../template';

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** A row's input for the batch quote, or null when the row cannot run. */
function quoteInput(op: ColumnOp, record: Record<string, CellValue>): Record<string, unknown> | null {
	try {
		switch (op.kind) {
			case 'email-enrichment': return emailFindInput(emailIdentity(op, record));
			case 'email-verify': return { email: verifyAddress(op, record) };
			case 'phone-find': return phoneFindInput(phoneIdentity(op, record));
			case 'company': { const domain = logoDomain(renderTemplate(op.domain, record).trim()); return domain ? { domain } : null; }
			default: return null;
		}
	} catch { return null; }
}

/** The most `cells` cells of `op` can cost. Batchable jobs ask looot (quoteOnly, free) for the rows given; everything
    else is the per-cell cap times the cells. Never above the per-cell cap the server enforces. */
export async function quoteRun(client: LoootClient | null, op: ColumnOp, cells: number, records: Array<Record<string, CellValue>>): Promise<RunQuote> {
	const perCellMaxUsd = cellCapUsd(op);
	const estimate: RunQuote = { cells, perCellMaxUsd, maxUsd: round(cells * perCellMaxUsd), typicalUsd: round(cells * costPerCell(op)), source: 'estimate' };
	const job = batchJob(op);
	if (!client || !job || !records.length || cells === 0) return estimate;
	const rows = records.map((record) => quoteInput(op, record)).filter((row): row is Record<string, unknown> => row !== null);
	if (!rows.length) return { ...estimate, maxUsd: 0, typicalUsd: 0 };
	const prefer = 'prefer' in op ? op.prefer : undefined;
	const quoted = await client.quote({ endpointId: `job:${job}`, rows, idempotencyKey: `lt-quote-${Date.now().toString(36)}`, fallback: { enabled: true, ...(prefer ? { prefer } : {}), maxCostUsd: op.kind === 'email-enrichment' ? cellCapUsd({ ...op, verify: false }) : perCellMaxUsd } });
	if (quoted === null) return estimate;
	// Rows looot did not see (beyond the sample) are priced at the per-row rate of those it did.
	const verify = op.kind === 'email-enrichment' && op.verify ? rows.length * cellCapUsd({ kind: 'email-verify', email: '', prefer: op.prefer }) : 0;
	const perRow = (quoted + verify) / rows.length;
	const maxUsd = round(Math.min(perRow, perCellMaxUsd) * cells * (rows.length / Math.max(1, records.length)));
	return { cells, perCellMaxUsd, maxUsd, typicalUsd: Math.min(estimate.typicalUsd, maxUsd), source: 'looot' };
}
