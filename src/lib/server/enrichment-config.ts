import 'server-only';
import { SELF_HOSTED_ISSUER, type Account } from '../auth-identity';
import { contextSignInEnabled } from './deployment';
import { DEV_ISSUER, devAuthEnabled } from './auth';

export function enrichmentEnabled(account?: Account | null): boolean {
	if (!account || account.issuer === SELF_HOSTED_ISSUER || !account.user.email_verified || !account.organization.id) return false;
	if (![process.env.ENRICHMENT_API_KEY, process.env.ENRICHMENT_API_URL, process.env.DATABASE_URL].every((value) => value?.trim())) return false;
	// The signed local developer account uses the same metered ledger as hosted organizations.
	// devAuthEnabled requires development mode, an explicit opt-in, and a loopback app URL.
	if (account.issuer === DEV_ISSUER) return devAuthEnabled();
	if (!contextSignInEnabled()) return false;
	try {
		return account.issuer === new URL(process.env.CONTEXT_IDENTITY_ISSUER || 'https://www.context.dev').origin;
	} catch { return false; }
}
