/** Translate API funding codes into spreadsheet labels without changing missing values. */
export function fundingLabel(value: string | null | undefined): string | null {
	if (!value) return null;
	if (value === 'pre_seed') return 'Pre-seed';
	if (value === 'no_funding_yet') return 'No funding yet';
	return value.split('_').map((word) => /^(ipo|usd)$/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
