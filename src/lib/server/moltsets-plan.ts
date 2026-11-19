import 'server-only';

import type { MoltSetsClient } from './moltsets';

/** What the account shows about a MoltSets plan: how much of the current 5 hour window is left. */
export interface MoltSetsPlan {
	plan?: string;
	active: boolean;
	/** Enrichment records left in the rolling 5 hour window, and the window's size. */
	recordsLeft5h?: number;
	recordsLimit5h?: number;
	/** When the 5 hour window reopens. Null until the first request opens one. */
	resetsAt5h?: string | null;
	recordsLeft1w?: number;
	/** Phone tokens left. Mobiles draw from these, a separate monthly subscription. */
	phoneTokens?: number;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Reads `get_account` results. Absent fields stay absent: the app shows only what MoltSets reported. */
export function parsePlan(results: unknown): MoltSetsPlan {
	const account = object(results);
	const records = object(object(object(account.fair_use).enrich).records);
	const fiveHours = object(records['5h']), week = object(records['1w']);
	return {
		...(typeof account.plan === 'string' ? { plan: account.plan } : {}),
		active: account.status === 'active',
		...(count(fiveHours.remaining) !== undefined ? { recordsLeft5h: count(fiveHours.remaining) } : {}),
		...(count(fiveHours.limit) !== undefined ? { recordsLimit5h: count(fiveHours.limit) } : {}),
		...('resets_at' in fiveHours ? { resetsAt5h: typeof fiveHours.resets_at === 'string' ? fiveHours.resets_at : null } : {}),
		...(count(week.remaining) !== undefined ? { recordsLeft1w: count(week.remaining) } : {}),
		...(count(account.phone_token_balance) !== undefined ? { phoneTokens: count(account.phone_token_balance) } : {}),
	};
}

export interface MoltSetsCheck { ok: boolean; message?: string; issue?: 'key' | 'plan'; plan?: MoltSetsPlan }

/** Checks a MoltSets key with `get_account`, which is free. */
export async function checkMoltSets(client: MoltSetsClient): Promise<MoltSetsCheck> {
	const answer = await client.call('get_account');
	if (answer.outcome === 'hit') {
		const plan = parsePlan(answer.results);
		if (!plan.active) return { ok: false, issue: 'plan', plan, message: 'MoltSets accepted this key, but the account is not active. Subscribe at app.moltsets.com.' };
		return { ok: true, plan, message: plan.recordsLeft5h !== undefined ? `Key accepted. ${plan.recordsLeft5h.toLocaleString('en-US')} records left in this 5 hour window.` : 'Key accepted.' };
	}
	if (answer.code === 'unauthorized') return { ok: false, issue: 'key', message: 'MoltSets rejected this key. Create a new one under API keys at app.moltsets.com.' };
	if (answer.code === 'account_inactive') return { ok: false, issue: 'plan', message: 'The MoltSets account is not active. Subscribe at app.moltsets.com.' };
	return { ok: false, message: answer.code === 'unreachable' ? 'Could not reach MoltSets. Try again.' : `MoltSets could not check this key${answer.code ? ` (${answer.code})` : ''}. Try again.` };
}
