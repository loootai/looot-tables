/** Accept remote HTTP(S) images and profile links; never executable or embedded URLs. */
export function profileUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const url = new URL(value);
		return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch { return null; }
}
