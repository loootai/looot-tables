/** Maps with at most `limit` calls in flight and returns results in input order. */
export async function mapConcurrent<T, R>(items: readonly T[], limit: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		const index = next++;
		if (index >= items.length) return;
		results[index] = await map(items[index], index);
		return worker();
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
