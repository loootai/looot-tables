# Email, verify and phone columns

These columns ask [looot](https://looot.ai) for the answer. looot runs a job (`job:people.email.find`, `job:people.email.verify`, `job:people.phone.find`) and walks that job's providers for you: it tries one, and on a miss it tries the next. You do not pick providers or keep provider keys.

## Source: MoltSets first

With a MoltSets key connected, the work email, phone and person columns have a **Source** setting.

| Source | What runs |
| --- | --- |
| MoltSets then looot (default with a key) | Your MoltSets plan first, at $0 a row. looot answers a miss, a spent window or a failed call |
| looot only | The looot job, as before |
| MoltSets only | MoltSets alone. A miss is an empty cell, and a spent window is a retryable error. Needs no looot token |

Without a MoltSets key every column runs on looot, and the Source setting changes nothing.

- **Work email** uses `linkedin_to_business_email` when the row has a LinkedIn URL, else `search_business_email_by_name` with the name and company domain.
- **Phone** uses `linkedin_to_mobile_phone`. Without a LinkedIn URL, MoltSets finds the profile from a name and company first, and the app uses the match only when it is the one candidate or has the same name. Mobiles draw from MoltSets phone tokens, a separate subscription, so a spent token balance sends the row to looot.
- **Person** columns use `reverse_email_lookup` or `reverse_linkedin_lookup` for the name, title, company, company domain, location and LinkedIn URL, and `email_to_linkedin` for the LinkedIn URL of an email. Other fields come from looot.

A MoltSets hit never starts a looot run. A `not_found` is free, a hit draws from your plan's rolling 5 hour window, and a spent window (`fair_use_limit_exceeded` or `fair_use_requests_exceeded`) makes the table stop asking MoltSets until `retry_after` has passed. The email's `risk_score` (A to F, send safety) and `last_validated_at` are kept on the cell. The key is sent to the MoltSets API only, in the Authorization header, and a redirect is never followed.

## Work email

Add → Add column → Find email → Work email maps name, company domain and optional company and LinkedIn columns. The column's **Provider order** decides which provider looot tries first:

| Order | looot tries first |
| --- | --- |
| Balanced (default) | the providers with the best mix of price and track record |
| Cheapest | the lowest price |
| Most reliable | the best measured hit rate |

The run stops at the first email a provider returns. It is not verified: add a **Verify email** column to check it. The cell keeps the provider's own status (`valid`, `invalid`, `catch_all`, `risky`, `unknown`) when the provider reports one.

## Verify email

Maps one email column and returns the status above, from `job:people.email.verify`.

## Phone

Maps a LinkedIn URL, or a name and company, and returns a phone number from `job:people.phone.find`. Phone lookups cost more than email lookups.

## What a cell shows

Open a cell to see the MoltSets attempt first when the column asked MoltSets, then which provider answered, the cost in USD, how the run ended (`hit`, `weak`, `miss`, `error`) and every provider the route tried, with what each charged. A provider that bills a not-found is listed with its charge. A miss is an empty cell with a reason, not an error.

## Money

- Every run is billed to your own looot token. There is no shared token and no included credit.
- Before a large run the app shows an estimate in dollars and asks first. The real cost per cell is kept on the cell.
- Each cell attempt sends a fresh idempotency key to looot, and a resend of the same attempt reuses it, so a retry never pays twice.
- A failure after money was spent is never retried automatically.

Set the token in Configuration → Connections (it stays in your browser), or on the server as `LOOOT_TOKEN` for a private deployment. See the [README](../README.md#api-keys).
