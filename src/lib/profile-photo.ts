/** Accept remote HTTP(S) images and profile links, or a path on this deployment ("/demo/people/a.jpg"); never
    executable or embedded URLs. */
export function profileUrl(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	if (/^\/[A-Za-z0-9._~-][A-Za-z0-9._~/-]*$/.test(value.trim())) return value.trim();
	try {
		const url = new URL(value);
		return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch { return null; }
}
