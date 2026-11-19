/** What a job column's header shows under its routing pill, from the looot catalog's measured numbers. */
export interface JobStats {
	job: string;
	prefer: 'balanced' | 'cheapest' | 'reliable' | 'fastest';
	/** Runnable providers in the order this routing tries them. */
	providers: Array<{ provider: string; priceUsd: number | null; costPerHitUsd: number | null; rate: number | null; p50Ms: number | null }>;
	/** The first provider's cost per useful answer, its answer rate and its median time. */
	costPerHitUsd: number | null;
	rate: number | null;
	p50Ms: number | null;
}
