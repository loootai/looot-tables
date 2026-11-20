'use client';

let account: { partition: string; sessionId: string } | null = null;

export function setStorageAccount(next: { partition: string; sessionId: string }) {
	if (account && (account.partition !== next.partition || account.sessionId !== next.sessionId)) throw new Error('Reload before switching accounts');
	account = next;
}

export function accountStorageKey(key: string) {
	if (!account && typeof window !== 'undefined') throw new Error('Sign in before accessing local data');
	return `${key}.account.${account?.partition ?? 'test'}`;
}

export function accountHeaders(): Record<string, string> {
	return account ? { 'x-looot-tables-account': account.partition, 'x-looot-tables-session': account.sessionId } : {};
}
