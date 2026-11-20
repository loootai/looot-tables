import { nanoid } from 'nanoid';

const KEY = 'looot-tables.tab';
/** How long a reloaded tab waits for its previous document to let go of its owner. */
const RELOAD_GRACE_MS = 1_000;
type Locks = Pick<LockManager, 'request'>;

/** Hold a Web Lock on `owner` for as long as this document lives. False when another document holds it past `waitMs`. */
function hold(locks: Locks, owner: string, waitMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), waitMs);
		locks.request(`${KEY}:${owner}`, waitMs ? { signal: deadline.signal } : { ifAvailable: true }, (lock) => {
			clearTimeout(timer);
			resolve(Boolean(lock));
			return lock ? new Promise<never>(() => {}) : undefined;
		}).catch(() => resolve(false));
	});
}

/** This tab's owner token. It lasts the tab's session, so after a reload the tab recognizes the cells it left running.
    Browsers copy sessionStorage into a duplicated tab, so the token is claimed with a Web Lock: a duplicate finds it
    held by the original and runs as a new owner. Without Web Locks every page load is a new owner. */
export async function claimTabOwner(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, locks: Locks | undefined, graceMs = RELOAD_GRACE_MS): Promise<string> {
	const saved = storage?.getItem(KEY);
	if (locks && saved && await hold(locks, saved, graceMs)) return saved;
	const owner = `tab-${nanoid()}`;
	if (!locks) return owner;
	storage?.setItem(KEY, owner);
	await hold(locks, owner, 0);
	return owner;
}
