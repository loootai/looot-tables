/** One queue per discovery run. Keep the budget check, fetch, dedupe and count update in the same operation. */
export function createPopulateSearchQueue(signal: AbortSignal) {
	let tail: Promise<void> = Promise.resolve();
	return <T>(search: () => Promise<T>): Promise<T> => {
		const result = tail.then(() => {
			signal.throwIfAborted();
			return search();
		});
		// A failed search must release the queue, while still rejecting its own caller.
		tail = result.then(() => undefined, () => undefined);
		return result;
	};
}
