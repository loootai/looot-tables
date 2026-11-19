import type { CatalogEndpoint, Prefer } from './looot-api';
import { parsePriceUsd } from './looot-catalog';
import type { JobStats } from '../job-stats';

/** A job's runnable providers in the order `prefer` tries them, and the numbers its column header shows: what a useful
    answer costs, how often one comes back, and the median time, for the provider tried first. */
export function jobStats(endpoints: CatalogEndpoint[], job: string, prefer: Prefer): JobStats {
	const providers = endpoints
		.filter((hit) => (hit.access === undefined || hit.access === 'runs_now') && (hit.job?.id ?? hit.capability) === job)
		.map((hit) => ({ provider: hit.provider ?? hit.endpointId, priceUsd: parsePriceUsd(hit.estimatedPrice), costPerHitUsd: typeof hit.costPerSuccessUsd === 'number' ? hit.costPerSuccessUsd : null, rate: typeof hit.works?.rate === 'number' ? hit.works.rate : null, p50Ms: typeof hit.works?.p50Ms === 'number' ? hit.works.p50Ms : null }));
	const value = (number: number | null, missing: number) => number ?? missing;
	if (prefer === 'cheapest') providers.sort((a, b) => value(a.costPerHitUsd, Infinity) - value(b.costPerHitUsd, Infinity));
	if (prefer === 'reliable') providers.sort((a, b) => value(b.rate, -1) - value(a.rate, -1));
	if (prefer === 'fastest') providers.sort((a, b) => value(a.p50Ms, Infinity) - value(b.p50Ms, Infinity));
	const first = providers[0];
	return { job, prefer, providers: providers.slice(0, 6), costPerHitUsd: first?.costPerHitUsd ?? null, rate: first?.rate ?? null, p50Ms: first?.p50Ms ?? null };
}
