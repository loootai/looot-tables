import type { InspectResult } from './looot-api';

/** A USD price from a number or a string such as "$0.0064". Null when there is none. */
export function parsePriceUsd(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
	if (typeof value === 'string') {
		const match = /\d+(?:\.\d+)?/.exec(value);
		return match ? Number(match[0]) : null;
	}
	return null;
}

export interface InspectedEndpoint {
	endpointId: string;
	/** What one call can cost at most, in USD. */
	priceUsd: number | null;
	inputs: Array<{ name: string; type: string; description: string; required: boolean }>;
}

/** The input names, types and price of an inspected endpoint, in the shape the column editor uses. */
export function inspectSummary(endpointId: string, result: InspectResult): InspectedEndpoint {
	const schema = result.inputSchema as { properties?: Record<string, { type?: string | string[]; description?: string }>; required?: string[] } | undefined;
	const hints = result.usageHints as { requiredInputFields?: string[] } | undefined;
	const required = schema?.required ?? hints?.requiredInputFields ?? [];
	const price = (result as { estimatedMaxCost?: unknown }).estimatedMaxCost ?? (result.endpoint as { estimatedPrice?: unknown } | undefined)?.estimatedPrice;
	return {
		endpointId,
		priceUsd: parsePriceUsd(price),
		inputs: Object.entries(schema?.properties ?? {}).map(([name, property]) => ({ name, type: Array.isArray(property.type) ? (property.type.find((type) => type !== 'null') ?? 'string') : (property.type ?? 'string'), description: property.description ?? '', required: required.includes(name) })),
	};
}
