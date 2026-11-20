import 'server-only';

/** One call's spending limit, in USD. Before a paid cell starts it reserves its per-cell cap; when it settles the cap is
    released and what looot charged is counted. A cell that would take spent plus reserved past the limit does not start,
    so the limit holds with cells running in parallel. */
export class Budget {
	#spent = 0;
	#reserved = 0;
	constructor(readonly limitUsd: number) {}

	get spentUsd() { return round(this.#spent); }

	/** Reserve `capUsd` for one cell; false when it does not fit. A free cell always fits. */
	reserve(capUsd: number): boolean {
		if (capUsd <= 0) return true;
		if (this.#spent + this.#reserved + capUsd > this.limitUsd + 1e-9) return false;
		this.#reserved += capUsd;
		return true;
	}

	release(capUsd: number, chargedUsd: number) {
		if (capUsd > 0) this.#reserved = Math.max(0, this.#reserved - capUsd);
		this.#spent += Math.max(0, chargedUsd);
	}

	message(capUsd: number) {
		return `Not started: the budget of $${round(this.limitUsd)} is spent or reserved ($${round(this.#spent)} spent), and one more cell can cost up to $${round(capUsd)}.`;
	}
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
