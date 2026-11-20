export const DATE_FORMATS = ['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MMM D, YYYY', 'D MMM YYYY'] as const;
export type DateFormat = typeof DATE_FORMATS[number];

/** Date-only values use local calendar parts, never a UTC conversion. */
export function parseDate(value: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
	if (!match) return undefined;
	const date = new Date(0);
	date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	date.setHours(0, 0, 0, 0);
	return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : undefined;
}

/** Change presentation only; preserve unrecognized values for manual correction. */
export function formatDate(value: string, format: DateFormat = 'YYYY-MM-DD'): string {
	const date = parseDate(value);
	if (!date) return value;
	const year = String(date.getFullYear()).padStart(4, '0');
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const shortMonth = date.toLocaleString('en-US', { month: 'short' });
	switch (format) {
		case 'MM/DD/YYYY': return `${month}/${day}/${year}`;
		case 'DD/MM/YYYY': return `${day}/${month}/${year}`;
		case 'DD.MM.YYYY': return `${day}.${month}.${year}`;
		case 'MMM D, YYYY': return `${shortMonth} ${date.getDate()}, ${year}`;
		case 'D MMM YYYY': return `${date.getDate()} ${shortMonth} ${year}`;
		default: return `${year}-${month}-${day}`;
	}
}
