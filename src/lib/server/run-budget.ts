import 'server-only';

/** One call's spending limit, in USD. Before a paid cell starts it reserves its per-cell cap (the most it can cost);
    when it settles the cap is released and what looot charged is counted. A cell waits while cells in flight hold the
    room it needs, and does not start once spent plus its cap would pass the limit, so the limit holds with cells running
    in parallel. */
export class Budget {
	#spent = 0;
	#reserved = 0;
	#waiting: Array<() => void> = [];
	constructor(readonly limitUsd: number) {}

	get spentUsd() { return round(this.#spent); }

	/** Reserve `capUsd` for one cell; false when it does not fit. A free cell always fits. */
	reserve(capUsd: number): boolean {
		if (capUsd <= 0) return true;
		if (this.#spent + this.#reserved + capUsd > this.limitUsd + 1e-9) return false;
		this.#reserved += capUsd;
		return true;
	}

	/** Reserve `capUsd`, waiting for cells in flight to settle when it does not fit yet. False once nothing is in flight
	    and it still does not fit: the budget is spent. */
	async acquire(capUsd: number): Promise<boolean> {
		while (!this.reserve(capUsd)) {
			if (this.#reserved <= 0) return false;
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		}
		return true;
	}

	release(capUsd: number, chargedUsd: number) {
		if (capUsd > 0) this.#reserved = Math.max(0, this.#reserved - capUsd);
		this.#spent += Math.max(0, chargedUsd);
		for (const wake of this.#waiting.splice(0)) wake();
	}

	message(capUsd: number) {
		return `Not started: the budget of $${round(this.limitUsd)} is spent or reserved ($${round(this.#spent)} spent), and one more cell can cost up to $${round(capUsd)}.`;
	}
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
