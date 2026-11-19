import 'server-only';
import { loootApiUrl } from './looot';

export interface LoootCheck {
	ok: boolean;
	message?: string;
	balanceUsd?: number;
	issue?: 'key' | 'balance';
}

/** Checks a looot token by reading the balance, which is free. Never stores or logs the token. */
export async function verifyLoootToken(token: string, fetchImpl: typeof fetch = fetch): Promise<LoootCheck> {
	try {
		const response = await fetchImpl(`${loootApiUrl()}/v1/balance`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
		if (response.status === 401 || response.status === 403) return { ok: false, issue: 'key', message: 'looot rejected this token. Create a new one at looot.ai and paste it here.' };
		if (!response.ok) return { ok: false, message: `looot could not check this token (${response.status}). Try again.` };
		const data = await response.json().catch(() => null) as { available?: unknown } | null;
		const balanceUsd = typeof data?.available === 'number' ? data.available : undefined;
		if (balanceUsd !== undefined && balanceUsd <= 0) return { ok: true, balanceUsd, issue: 'balance', message: 'Token accepted, but the balance is $0. Top up at looot.ai/usage to run lookups.' };
		return { ok: true, balanceUsd, message: balanceUsd !== undefined ? `Token accepted. Balance $${balanceUsd.toFixed(2)}.` : 'Token accepted.' };
	} catch {
		return { ok: false, message: 'Could not reach looot before the check timed out. Try again.' };
	}
}
