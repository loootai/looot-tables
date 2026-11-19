import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimTabOwner } from '../src/lib/tab-owner';

/** sessionStorage, which browsers copy into a duplicated tab. */
class Session {
	constructor(private values = new Map<string, string>()) {}
	getItem(key: string) { return this.values.get(key) ?? null; }
	setItem(key: string, value: string) { this.values.set(key, value); }
	duplicate() { return new Session(new Map(this.values)); }
}

/** Web Locks for one origin. A document's locks are released when it goes away (closed, reloaded). */
class Origin {
	private held = new Map<string, () => void>();
	private waiting: Array<() => void> = [];
	document() {
		const mine = new Set<string>();
		const locks = {
			request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => new Promise<unknown>((resolve, reject) => {
				const grant = () => {
					if (this.held.has(name)) return false;
					this.held.set(name, () => this.held.delete(name));
					mine.add(name);
					resolve(callback({ name, mode: 'exclusive' }));
					return true;
				};
				if (grant()) return;
				if (options.ifAvailable) { resolve(callback(null)); return; }
				const retry = () => { if (grant()) this.waiting = this.waiting.filter((entry) => entry !== retry); };
				this.waiting.push(retry);
				options.signal?.addEventListener('abort', () => { this.waiting = this.waiting.filter((entry) => entry !== retry); reject(options.signal!.reason); }, { once: true });
			}),
		} as Pick<LockManager, 'request'>;
		return { locks, close: () => { for (const name of mine) this.held.get(name)?.(); mine.clear(); for (const retry of [...this.waiting]) retry(); } };
	}
}

test('a duplicated tab runs as itself; a reloaded tab keeps its owner and recognizes the cells it left running', async () => {
	const origin = new Origin(), session = new Session();
	const tab = origin.document();
	const owner = await claimTabOwner(session, tab.locks);
	const duplicate = await claimTabOwner(session.duplicate(), origin.document().locks, 20);
	assert.notEqual(duplicate, owner, 'a duplicated tab never treats the original’s running cells as its own');
	tab.close();
	const reloaded = origin.document();
	assert.equal(await claimTabOwner(session, reloaded.locks), owner, 'after a reload');
	const next = origin.document();
	const claim = claimTabOwner(session, next.locks);
	reloaded.close();
	assert.equal(await claim, owner, 'a reload keeps its owner even when the previous document lets go a moment late');
});

test('without Web Locks each page load runs as a new owner', async () => {
	const session = new Session();
	const first = await claimTabOwner(session, undefined);
	assert.notEqual(await claimTabOwner(session, undefined), first);
	assert.match(first, /^tab-/);
});
