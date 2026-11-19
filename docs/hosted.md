# Official-site operations

This guide is for maintainers of the official Enrichable service, including its internal local OAuth development. Context.dev sign-in is reserved for the official service and is not supported for third-party deployments. Self-hosters must use their own API keys as described in the [README](../README.md). Production sign-in is restricted by `src/lib/server/deployment.ts` to `enrichable.io` and `www.enrichable.io`.

Before deploying, apply migrations using a dedicated environment database, configure a stable `ENRICHABLE_MCP_ENCRYPTION_SECRET` of at least 32 random characters, and back it up securely. Every server sharing the database must use the same encryption root. Changing it without re-encrypting existing records makes saved provider credentials and recoverable MCP keys unreadable.

## Sign-in

This section applies only to the official Enrichable site (or local OAuth development), not self-hosted deployments.

Set `ENRICHABLE_APP_URL`, `ENRICHABLE_SESSION_SECRET`, `CONTEXT_IDENTITY_ISSUER`, `CONTEXT_OAUTH_CLIENT_ID`, and `CONTEXT_OAUTH_CLIENT_SECRET` for the official service. Generate independent random secrets of at least 32 characters for the session and OAuth client. Never use a `NEXT_PUBLIC_` variable for either secret.

The Context.dev webapp must include the sign-in and encrypted API credential OAuth routes. Configure it with the matching `ENRICHABLE_OAUTH_CLIENT_ID` and `ENRICHABLE_OAUTH_CLIENT_SECRET`, and set `ENRICHABLE_OAUTH_REDIRECT_URI` to the exact `${ENRICHABLE_APP_URL}/api/auth/callback`. Use a separate client secret and callback for each environment. HTTPS is required outside local development. The existing client secret also derives the app-specific HKDF-derived AES-GCM credential encryption key; never share Context.dev’s general MCP token encryption secret with Enrichable. Consent grants data execution and log reading, using the existing delegated-key provisioning and revocation path.

The login uses a five-minute authorization code, PKCE S256, and a browser-bound state cookie. Enrichable establishes a 14-day signed HttpOnly session. All app pages and APIs require sign-in; API requests also carry the active account and session identifiers to reject stale tabs. Other tabs recheck the session on account-change notifications, focus, and every 15 seconds. Logout clears the browser session; a copied session cookie remains valid until its expiry, so rotate the session secret to invalidate all sessions if needed. Context.dev membership is rechecked at each sign-in, not continuously during an Enrichable session.

Browser sheet caches are separated by account. Signed-in organization settings are stored in Neon, and provider secrets use authenticated encryption with the shared server encryption root; clients receive only status and masked prefixes. Existing account-local settings can be explicitly imported without overwriting existing organization configuration. Sheets and settings sync across devices through Neon. Production sign-in requires Context.dev; API keys authorize enrichment only. Local development can explicitly enable the developer session described below.

Official-site sign-in configuration (not for self-hosted deployments):

```dotenv
ENRICHABLE_APP_URL=https://www.enrichable.io
ENRICHABLE_SESSION_SECRET=
CONTEXT_IDENTITY_ISSUER=https://www.context.dev
CONTEXT_OAUTH_CLIENT_ID=enrichable
CONTEXT_OAUTH_CLIENT_SECRET=
```

## Sponsored organization AI trial

Set `ENRICHABLE_OPENAI_TRIAL_ENABLED=true` and a fresh server-only `OPENAI_API_KEY`, then run `npm run db:migrate`. Each verified organization receives **$1 in one-time OpenAI credit**, shared by all its members. Existing organizations receive the same allowance on first use; signing in again or adding members does not reset it. Identity issuer and organization ID determine the balance. The sidebar shows remaining credit, including reservations for active requests. Context.dev credits remain separate. When trial credit runs out, the app explains that an OpenAI API key is required for future AI requests and opens the required key field. The placeholder `REPLACE_WITH_OPENAI_API_KEY` keeps the trial inactive; replace it with a real key and redeploy to activate it.

Sponsored requests use `gpt-6-luna` on the official OpenAI endpoint, ignoring client model and base URL overrides. Text input and output are bounded; every model call, tool step, retry, fallback decision and inference connection test is metered. The server atomically reserves a conservative text-token cost bound before each call and settles against reported usage, including reasoning output and cached input. Unused reservations are refunded. Timeouts, provider errors or missing usage retain the reservation because billing is uncertain. Interrupted processes leave their holds intact for manual reconciliation; holds never expire automatically.

The deployment-wide **lifetime cap starts at $1,000**, stored in `enrichable.credit_limits` under `openai`. This cap includes pending reservations and prevents unlimited new organizations from spending unlimited credit. Per organization, the server allows eight active model calls and 120 attempts per minute. Raising the global cap does not reset organization balances. Requests fail closed when budget storage is unavailable or a reservation cannot be funded. Budget data is stored in `enrichable.openai_budgets` and `enrichable.openai_reservations`; never delete those tables to redeploy or sign users out.

Users can add their own OpenAI key to continue after trial credit is exhausted; those calls use their selected model and do not debit the trial. Sponsored OpenAI access requires a valid signed-in session and does not require the private-deployment password. Other server keys retain the password controls below. Configure a separate hard spend limit in the OpenAI project as an additional account-level cap.

## Sponsored organization TypeSafe trial

Set `ENRICHABLE_TYPESAFE_TRIAL_ENABLED=true` and a server-only `TYPESAFE_API_KEY`, then apply migration 011. Each verified organization receives **$1 in one-time TypeSafe credit** for decision columns (check, classify, score), shared by all its members, on a ledger separate from the AI trial. Settings shows TypeSafe as an included trial and the sidebar shows its remaining credit. Each decision reserves its request size as input tokens at TypeSafe's published rate ($42 per billion input tokens; output is free) and settles against the input tokens TypeSafe reports. Refused (429) or unsent requests are refunded; other failures and missing usage retain the reservation. When the credit runs out, decisions fall back to OpenAI (the AI trial or the organization's own key), or the cell asks for a TypeSafe key when no OpenAI access is available. A member's own TypeSafe key replaces the trial and is never debited.

The deployment-wide cap starts at **$100**, stored in `enrichable.credit_limits` under `typesafe`, with the same per-organization request limits as the AI trial. Budget data is stored in `enrichable.typesafe_budgets` and `enrichable.typesafe_reservations`. Like the AI trial, it is browser-only: MCP callers never use the deployment's TypeSafe key.

Official-service funding configuration (not for self-hosting):

```dotenv
ENRICHABLE_OPENAI_TRIAL_ENABLED=true
OPENAI_API_KEY=
ENRICHABLE_TYPESAFE_TRIAL_ENABLED=true
TYPESAFE_API_KEY=
ENRICHMENT_API_KEY=
ENRICHMENT_API_URL=
```

## Email enrichment allowance

The hosted email waterfall uses a server-only gateway and a separate allowance ledger. Configure `ENRICHMENT_API_KEY` and `ENRICHMENT_API_URL`; apply migrations 009 and 012. Provider selection and own-key setup are described in [email enrichment](email-enrichment.md); hosted reservation and reconciliation details follow below. These allowances are unavailable to anonymous self-hosted workspaces.

## Legacy MCP key backfill

Legacy hash-only MCP keys require a hash-verified operator backfill using the existing secret; they cannot be recovered from a hash. Run `node --conditions=react-server --import tsx scripts/backfill-mcp-key.ts /private/path/client-config.json` with a private MCP client configuration, then securely remove that temporary file. Backfill preserves the active key and version.

## Related operations

- [MCP keys and rotation](mcp.md)
- [Realtime configuration](realtime.md)
- [Company context and migrations](company-context.md)

Never copy production `.env` files, database contents, browser profiles, traces, or provider credentials into releases or issue attachments.


## Local developer sign-in

For official-site maintainers testing signed sessions locally without OAuth, set these in `.env.local`:

```dotenv
ENRICHABLE_APP_URL=http://localhost:3000
ENRICHABLE_DEV_AUTH=true
ENRICHABLE_SESSION_SECRET=replace-with-a-random-secret-of-at-least-32-characters
```

Run `npm run dev -- --hostname localhost`, open `/login`, and click **Sign in as developer**. OAuth client credentials are optional for this mode. The button creates a normal 14-day signed HttpOnly session for a fixed developer account in a separate **Local development** workspace. Logout, account partitioning, and API session checks still apply. Sign-in clears any previous automatic Context.dev credential; add Context.dev and OpenAI keys in Configuration to test enrichment.

Use a dedicated development database or Neon development branch for `DATABASE_URL`, and run `npm run db:migrate`. The development identity isolates its sheets from real organizations, but does not create a separate database for you. Disabling the flag immediately rejects developer sessions. Both the button and sign-in endpoint require a loopback app URL and development mode; production and test mode reject developer sessions even if the flag is set. Keep real OAuth enabled when testing consent and automatic API connections.


## Hosted Logo Link connection

LogoLink can connect automatically through Context.dev sign-in. Enrichable requests the separate `logolink.read` permission and uses the signed-in workspace's existing public client ID for logos. Existing accounts sign in again and approve that permission; a manually entered LogoLink ID remains an optional override. Automatic IDs stay with the account session, rather than being saved as manual keys. Context.dev's OAuth update must be released before deploying this consumer change. After consent, it adds the configured Enrichable callback hostname to that workspace's existing LogoLink allowed domains, preserving other domains; unrestricted keys stay unrestricted. No LogoLink service change is required. Logo requests continue to consume the workspace's normal logo quota.


## Hosted email allowance execution and reconciliation

Included calls use the server-only `ENRICHMENT_API_KEY` and `ENRICHMENT_API_URL` HTTP gateway. The key needs only `runs:create` and `runs:get`. No SDK or browser-side gateway credential is used. Configure both variables locally and in the deployment, then apply migration 009. Environments sharing a database share the same allowance ledger.

Each verified organization has one non-resetting $1 allowance. The deployment has a separate non-resetting cap starting at $1,000, stored in `enrichable.credit_limits` under `enrichment`. Transactions reserve each provider call's bounded cost under a global row lock before HTTP starts, preventing concurrent overspending. Final run cost settles the reservation once. Failed or rejected calls with confirmed zero cost refund their reservation. Unknown billing retains the reservation; it must not be automatically released. Upstream recurring budgets are independent of this ledger and must be configured in the upstream account.

The gateway receives only server-selected provider endpoints and inputs. Every billable POST has an idempotency key; asynchronous runs are polled rather than resubmitted. Raw provider errors, payloads, and gateway credentials are never returned to clients. Cell metadata records ordered attempts, direct-key versus included-credit usage, and settled included cost. The credit balance is available at `/api/enrichment/usage` for the authenticated organization.

Current configured bounds: QuickEnrich $0.0072; Hunter find $0.0245; Apollo $0.026 without add-ons; Prospeo $0.066 without mobile; ContactOut $0.12 including one work-email result. Review these bounds against the gateway catalog when provider pricing changes. `maxCost` guards estimated cost; actual billed cost is still reconciled from the completed run.

## Organization credit report

Set the server-only `ENRICHABLE_CREDITS_REPORT_SECRET` to a dedicated random secret of at least 32 characters in the deployment environment, then redeploy. For example, generate it with `openssl rand -hex 32`. Do not reuse a session secret, provider key, or deployment password. Leave the variable unset to disable report access. In Vercel, configure it only for the environments whose credit ledgers you intend to inspect; avoid sharing production database credentials with previews.

Query the report with a bearer token in the header:

```sh
curl --fail-with-body https://www.enrichable.io/api/admin/credits \
  -H "Authorization: Bearer $ENRICHABLE_CREDITS_REPORT_SECRET"
```

The response contains `deployment.openai` and `deployment.enrichment` lifetime caps, debited amounts and remaining dollars, plus an `organizations` array. Each organization includes its workspace ID, organization ID, name and issuer when known, and separate `openai` and `enrichment` balances. Each balance shows `grantedUsd`, `spentUsd`, `remainingUsd`, `usedPercent`, `settledUsd`, `heldUsd`, `uncertainUsd`, `activeRequests` and `lastRequestAt`. Dollar amounts retain their precision; a negative available balance is displayed as zero, while spending and usage percentage can exceed the grant after a larger final charge.

`spentUsd` includes pending reservations and uncertain billing, matching the allowance enforcement ledger. `settledUsd` is confirmed billing; `heldUsd` is still pending; `uncertainUsd` requires reconciliation. The shared deployment balance can run out before an organization uses its own grant. These are Enrichable's included AI and email allowances; Context.dev subscription credits and calls paid with users' own provider keys are outside this report.

The report includes persisted workspaces with no usage and budget records without a workspace (identity fields are null for those records). Organizations that have never reached Enrichable's storage are not discoverable from this database. Names reflect saved workspace metadata. Reading the report never creates a workspace or budget.

Apply migration 010 with `npm run db:migrate` before deploying this endpoint and signup tracking. Successful persisted OAuth sign-ins record each identity's first and latest Enrichable sign-in and organization membership. Repeat sign-ins preserve the first timestamp. Global user counts deduplicate the same user across organizations using issuer and user ID; per-organization counts represent users observed signing into that organization. Local developer sign-in and anonymous self-hosted sessions are excluded. No extra email addresses, names, or provider secrets are stored for these counts.

The `users` object includes `totalObserved`, `firstSeenLast24Hours`, `firstSeenLast7Days`, `firstSeenLast30Days`, `trackingStartedAt`, and `firstSeenByDayUtc` for the current UTC day plus the preceding 29 days (days without sign-ins are omitted). Each organization also has a `users` count object. Rolling periods use database time and daily buckets use UTC. These are first-observed Enrichable sign-ins, not Context.dev account creation dates: previous signup dates were not recorded, and an existing user returning after tracking starts will be counted as newly observed. There is no historical signup backfill. No user identifiers are exposed in the report.

This endpoint accepts GET (and Next.js's automatic HEAD/OPTIONS); mutation methods receive 405 after authorization. It has no operation for adding, removing, resetting or transferring credit. Both the proxy and route validate the dedicated bearer token. Browser sessions and the deployment password do not authorize access, and query-string tokens are ignored. Responses are private and uncached, database errors are redacted, and the database transaction is read-only. Anyone holding this secret can read all organizations' balances, so keep it in server or operator tooling and rotate it by changing the variable and redeploying.

## Change deployment credit caps

Migration 012 creates `enrichable.credit_limits` with $1,000 each for `openai` and `enrichment`, and $100 for `typesafe`. Caps are lifetime totals, including existing spend and in-flight reservations. Each organization still receives a separate $1 allowance in each ledger.

After the migration and application change are deployed, an authorized database operator can change a cap without a PR, environment-variable update, restart, or redeploy. For example, to set AI and enrichment to $1,000 each:

```sql
UPDATE enrichable.credit_limits
SET cap_nano = 1000::bigint * 1000000000
WHERE kind IN ('openai', 'enrichment')
RETURNING kind, cap_nano / 1000000000.0 AS cap_usd;
```

The server reads the cap inside each budget transaction, without caching. Cap updates serialize with active budget checks. Lowering a cap below existing spending blocks new reservations but preserves balances and lets existing calls settle. Missing cap rows fail closed. Values must be positive integer nanodollars within JavaScript's safe integer range ($9,007,199.254740991 maximum); this is a numeric storage limit, not a spending recommendation.

Redeploying does not overwrite edited caps. The legacy `ENRICHABLE_OPENAI_TOTAL_BUDGET_USD`, `ENRICHABLE_ENRICHMENT_TOTAL_BUDGET_USD`, and `ENRICHABLE_TYPESAFE_TOTAL_BUDGET_USD` variables are ignored by the new code and may be removed after rollout. Never edit `spent_nano` or delete reservations to change a cap. Record the operator, reason, old value, and new value in your database change log.
