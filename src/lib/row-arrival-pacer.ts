/** A small presentation reservoir: data is saved before entering this queue. */
export class RowArrivalPacer {
	private pending: Array<{ id: string; receivedAt: number; revealAt: number }> = [];
	private lastBatchAt: number | null = null;
	private expectedGap = 8000;

	add(ids: string[], now: number): ReadonlyMap<string, number> {
		// Already due rows must never disappear again when the next chunk arrives.
		this.pending = this.pending.filter((row) => row.revealAt > now);
		if (!ids.length) return new Map(this.pending.map((row) => [row.id, row.revealAt]));
		if (this.lastBatchAt !== null) {
			const gap = Math.max(250, Math.min(10_000, now - this.lastBatchAt));
			this.expectedGap = this.expectedGap * .45 + gap * .55;
		}
		this.lastBatchAt = now;
		const nextAt = this.pending[0]?.revealAt ?? now;
		this.pending.push(...ids.map((id) => ({ id, receivedAt: now, revealAt: now })));
		// Preserve a readable beat for normal pages. Compress only a large backlog,
		// so its tail stays within eight seconds of the already-saved data.
		const preferredStep = Math.max(420, Math.min(560, this.expectedGap * .9 / Math.max(1, ids.length - 1)));
		const initialStep = Math.min(preferredStep, 8000 / Math.max(1, this.pending.length - 1));
		const start = Math.max(now, Math.min(nextAt, now + initialStep));
		// Seed each row's beat so it varies naturally without changing on reschedule.
		let total = 0;
		let originalTotal = 0;
		const beats = this.pending.map((row, i) => {
			let hash = 2166136261;
			for (const character of row.id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
			hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
			hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
			const noise = ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff;
			if (i) {
				originalTotal += preferredStep * (.72 + noise * .56);
				// Usually a quick follow-on row, occasionally a longer thinking pause.
				const burstWeight = noise < .68 ? .32 + noise * .45 : 1.7 + (noise - .68) * 1.9;
				total += preferredStep * burstWeight;
			}
			return total;
		});
		// Redistribute the gaps without changing this queue's total reveal time.
		const scale = total ? Math.min(originalTotal, 8000 - (start - now)) / total : 1;
		this.pending.forEach((row, i) => {
			row.revealAt = Math.max(now, Math.min(start + beats[i] * scale, row.receivedAt + 8000));
		});
		return new Map(this.pending.map((row) => [row.id, row.revealAt]));
	}

	finish(now: number): ReadonlyMap<string, number> {
		this.pending = this.pending.filter((row) => row.revealAt > now);
		// Finishing the network request must not turn the last page into a burst.
		return new Map(this.pending.map((row) => [row.id, row.revealAt]));
	}
}
