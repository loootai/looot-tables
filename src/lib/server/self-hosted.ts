import 'server-only';
import { createHash } from 'node:crypto';
import { SELF_HOSTED_ISSUER, type Account } from '../auth-identity';

export const SELF_HOSTED_SECONDS = 365 * 24 * 60 * 60;

/** Re-issued on every page visit, so a workspace only expires after a year without use. */
export const selfHostedCookieOptions = (secure: boolean) => ({ httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: SELF_HOSTED_SECONDS });

// An unguessable bearer cookie identifies one browser workspace. Hash it before
// exposing an account identifier to the client or storing anything in Postgres.
// No OAuth credentials or deployment-wide signing secret are needed.
export function selfHostedAccount(token?: string): (Account & { sessionId: string }) | null {
	if (!token || !/^local\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const id = createHash('sha256').update(token).digest('hex');
	return {
		issuer: SELF_HOSTED_ISSUER,
		user: { id, email: 'local@example.com', email_verified: true, name: 'Your workspace' },
		organization: { id, name: 'Self-hosted' },
		partition: createHash('sha256').update(`self-hosted:${id}`).digest('hex'),
		sessionId: createHash('sha256').update(`session:${id}`).digest('hex'),
	};
}
