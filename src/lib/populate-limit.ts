import type { EntityKind } from './types';

export const DEFAULT_POPULATE_LIMIT = 20;
export const MAX_POPULATE_LIMIT = 100;

export function promptResultCount(query: string): number | undefined {
	const match = query.match(/\b(?:find|show|get|give|return|list|search\s+for)(?:\s+me)?(?:\s+(?:the|top|first|exactly|up\s+to))*\s+(\d[\d,]*)(?![\d,.])\b/i);
	return match ? Number(match[1].replaceAll(',', '')) : undefined;
}

export function populateLimitError(limit: number): string | null {
	if (limit > MAX_POPULATE_LIMIT) return 'Only 100 at a time. Ask for 100 or fewer.';
	if (!Number.isInteger(limit) || limit < 1) return 'Choose a limit between 1 and 100.';
	return null;
}

const LEAD = /^(?:please\s+)?(?:find|show|get|give|return|list|discover|look\s+for|search(?:\s+for)?)(?:\s+me)?\s+/i;
const QUANTITY = /^(?:(?:the|top|first|exactly|up\s+to|about|around|roughly|some|all|every|each|any|a\s+list\s+of|list\s+of|of)\s+|\d[\d,]*\+?\s+)+/i;
const CLAUSE = /\s+(?:that|who|which|where|whose)\s+|[,;:()]|[.!?](?:\s|$)|\s[-–—]\s/i;
const TRAILING = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const QUALIFIER = new Set(['with', 'without', 'in', 'for', 'at', 'from', 'near', 'across', 'using', 'based', 'located', 'by']);

/** "Find 50 solar installers in Texas that offer financing" → "Solar installers in Texas". Empty when nothing is left. */
export function sheetNameFromPrompt(query: string, max = 56): string {
	let words = (query.trim().split('\n')[0] ?? '').replace(LEAD, '').replace(QUANTITY, '').split(CLAUSE)[0].trim().split(/\s+/).filter(Boolean);
	const fits = (count: number) => words.slice(0, count).join(' ').length <= max;
	if (!fits(words.length)) {
		// Prefer ending before a qualifier ("… startups in Europe with 20–200 employees" → "… startups in Europe").
		let count = words.length - 1;
		while (count > 1 && !(fits(count) && QUALIFIER.has(words[count].toLowerCase()))) count--;
		if (count <= 1) for (count = words.length; count > 1 && !fits(count); count--);
		words = words.slice(0, count);
	}
	while (words.length > 1 && TRAILING.has(words.at(-1)!.toLowerCase())) words.pop();
	const name = words.join(' ');
	return /\p{L}/u.test(name) ? name[0].toUpperCase() + name.slice(1) : '';
}

const ENTITY_WORDS: Array<[EntityKind, RegExp]> = [
	['people', /\b(?:people|persons?|founders?|co-?founders?|ceos?|ctos?|cfos?|cmos?|coos?|vps?|vice presidents?|heads? of|engineers?|developers?|designers?|managers?|directors?|executives?|marketers?|recruiters?|investors?|partners at|professors?|researchers?|decision[- ]makers?)\b/i],
	['websites', /\b(?:websites?|web ?pages?|pages?|sites?|blogs?|blog posts?|articles?|posts?|docs|urls?)\b/i],
	['companies', /\b(?:compan(?:y|ies)|startups?|businesses|firms?|brands?|agencies|organizations?|nonprofits?|vendors?|manufacturers?|retailers?)\b/i],
];

/** What a Find rows prompt asks for, by whichever kind of noun comes first ("Founders of YC companies" → people). */
export function promptEntity(query: string): EntityKind | null {
	let best: { entity: EntityKind; at: number } | null = null;
	for (const [entity, words] of ENTITY_WORDS) {
		const at = query.search(words);
		if (at >= 0 && (!best || at < best.at)) best = { entity, at };
	}
	return best?.entity ?? null;
}
