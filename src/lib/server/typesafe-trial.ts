import 'server-only';
import type { Questions, SystemOneRequest, SystemOneResult, Usage } from '@typesafe-ai/sdk';
import type { Account } from '../auth-identity';
import { meteredCall, typesafeLedger, type LedgerAccess } from './credit-ledger';
import { contextSignInEnabled } from './deployment';
import { unbilled } from './enrich-failure';

/* The included TypeSafe trial: signed-in organizations on the hosted app run decisions on the deployment's TypeSafe key,
   each request charged to their TypeSafe trial budget. */

// Nanodollars per input token; output tokens are free. https://docs.typesafe.ai/models
const INPUT_RATE = 42;
/** The per-request context limit without the long-context header; no request is billed for more. */
const MAX_INPUT_TOKENS = 65_536;

export const typesafeTrialEnabled = () => contextSignInEnabled() && process.env.ENRICHABLE_TYPESAFE_TRIAL_ENABLED === 'true' && Boolean(process.env.TYPESAFE_API_KEY?.trim());

/** What decisions need from a TypeSafe client. */
export interface Jev {
	systemOne<const Q extends Questions>(request: SystemOneRequest<Q>): Promise<SystemOneResult<Q>>;
}

/** An upper bound for a request: every token covers at least one byte of the JSON sent, and the API caps the context. */
export function typesafeReservation(request: SystemOneRequest) {
	return Math.min(Buffer.byteLength(JSON.stringify(request), 'utf8') + 1024, MAX_INPUT_TOKENS) * INPUT_RATE;
}

/** The charge for reported usage, or null when TypeSafe reported none: unknown usage is never free. */
export function typesafeCharge(usage: Usage | undefined): number | null {
	const tokens = usage?.input_tokens;
	return typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens * INPUT_RATE : null;
}

/** Reserves each request against the organization's TypeSafe trial before it is sent and settles it with the input tokens
    TypeSafe reports. A refused (429) or unsent request is refunded; any other failure keeps its reservation. */
export function typesafeTrial(client: Jev, account: Account, access: LedgerAccess = typesafeLedger): Jev {
	return {
		systemOne: <const Q extends Questions>(request: SystemOneRequest<Q>) => meteredCall(access, account, typesafeReservation(request), async (meter) => {
			try {
				const response = await client.systemOne(request);
				meter.charge = typesafeCharge(response.usage);
				return response;
			} catch (error) {
				if (unbilled(error)) meter.charge = 0;
				throw error;
			}
		}),
	};
}
