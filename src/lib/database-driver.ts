/** Neon speaks to its own HTTP and WebSocket proxies. Any other Postgres (a local server, RDS, Supabase's direct port) is
    reached over its normal TCP protocol. Set DATABASE_DRIVER=neon or postgres to override the guess from the host.
    Kept apart from the server module so the migration script can share it. */
export function usesNeonDriver(url: string, driver = process.env.DATABASE_DRIVER): boolean {
	if (driver === 'neon') return true;
	if (driver === 'postgres') return false;
	try { return /(^|\.)neon\.(tech|build)$/.test(new URL(url).hostname); } catch { return false; }
}
