import type ContextDev from 'context.dev';
import type { CompanySuggestion } from '../company-search';
import { logoDomain } from '../organization-logo';

export async function searchCompanySuggestions(client: ContextDev, query: string, signal?: AbortSignal): Promise<CompanySuggestion[]> {
	const response = await client.brand.search(
		{ query: query.trim(), autocomplete: true, queryBy: ['name', 'domain'] },
		{ signal, timeout: 8_000, maxRetries: 0 },
	);
	const seen = new Set<string>();
	return response.results.flatMap((result) => {
		const domain = logoDomain(result.domain);
		if (!domain || seen.has(domain)) return [];
		seen.add(domain);
		return [{ name: result.name.trim() || domain, domain }];
	}).slice(0, 10);
}
