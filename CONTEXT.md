# looot tables

A spreadsheet that fills itself in from the internet: rows come from a description, and each AI column answers one question about every row.

## Language

### Sheets and data

**Workspace**:
The container of sheets a person can see: one per browser cookie. Local development with LOOOT_TABLES_DEV_AUTH can also sign in test accounts.
_Avoid_: Organization (on self-hosted), account, project

**Sheet**:
A named grid of rows and columns, saved with a revision.

**View**:
A viewer's filters and sort for a sheet, kept in their browser; changing it never changes the sheet for anyone else (`src/lib/sheet-view.ts`).

**Source column**:
A column whose values people type, import or find; it has no operation.

**AI column**:
A column with an operation that computes each of its cells.
_Avoid_: Enriched column, rule column, compose column

**Operation**:
The declared work an AI column does per row (ask AI, check, classify, score, read a page, web search, company, person, find email, email draft, template); one record per kind lives in the operation catalog (`src/lib/operations.ts`).
_Avoid_: Op type, rule, action

**Cell**:
One value in a row and column, with a status (idle, queued, running, done, error), optional formula and metadata such as sources and confidence.

**Reference**:
A `{{Name}}` or `{{B1}}` placeholder in an operation that reads another column or cell; references decide dependencies and follow renames and moves (`src/lib/references.ts`).

**Column role**:
What a column means to the app (website, person, email, profile, company, document…), inferred from its format, operation and name (`src/lib/column-roles.ts`).

**Admission**:
The decision of how a value from a given source (edit, import, Find rows, enrichment, formula, agent) becomes a stored cell for a column, or why it's rejected (`src/lib/cell-admission.ts`).

### Running work

**Find rows**:
Discovering new rows from a description of the companies, people or websites wanted.
_Avoid_: Populate (in UI copy), add rows, generate

**Enrichment**:
Computing an AI column's cell by running its operation for one row.

**Outdated**:
A done cell whose result answers an older operation or older inputs than its row has now. A run's inputs are the cells its references read, plus, for an operation that reads its whole row (ask AI, check, classify, score, an AI email draft, research that references nothing), every non-empty source value of the row. Empty values are not inputs, and an AI answer or a formula result is one only when referenced: a whole-row run is still shown it, but changing it outdates nothing. Inputs are tracked by column, so renaming or moving a column outdates nothing either. An outdated cell keeps its value and shows a refresh icon until someone re-runs it explicitly (its refresh icon, **Re-run outdated cells**, or `enrich_cells` with `overwrite`); no automatic run selects a finished cell, outdated or not (`EnrichmentPlan.outdated`, `src/lib/enrichment-freshness.ts`).
_Avoid_: Stale (in UI copy)

**Run**:
A batch of cells queued for enrichment in one browser tab; bulk runs above the confirmation threshold ask first (`src/lib/run-cost.ts`). **Run unfinished cells** takes cells never run, failed or stopped, never a finished one. A running cell names its owner (a tab, or an agent's request) and is stamped on the server's clock; a cell running elsewhere is waited on, never run twice, and a queued cell finished elsewhere is not run again. A failed re-run keeps the previous value with its error.

**Halt**:
A paused run on a sheet after a failure no retry can fix (credits exhausted, a missing or rejected key, results that could not be saved), shown as one banner with a fix. A result already paid for is kept, and resuming saves it without asking the provider again, even after its running marker expired, unless its inputs changed.

**Failure**:
A structured reason an enrichment did not produce a value (`rate_limited`, `credits_exhausted`, `credential_missing`, `credential_invalid`, `timeout`, `provider_error`, `input_invalid`) with whether it is retryable; messages are presentation only. It is retryable only when no provider did work for it: the request never reached the provider (DNS failed or the connection was refused), the provider refused it before processing (429), or looot tables's own pre-flight refused it (the **Credit ledger**'s rate limit, or company research another cell is running or that just failed). Anything after a request was sent (a timeout, a server error, a dropped connection, a truncated answer), and any failure once its enrichment paid for anything, is never retried automatically: the provider may have billed the work. What an enrichment paid for is recorded once, where requests leave: each enrichment gets its own spend tracker, and the clients **Provider access** hands out record into it every request a provider may have billed (anything but a refusal, a request that never arrived or a shared-cache hit), with the looot cost shown on the cell, including company research done for it. A page lookup that finds no such page is an answer (a check is false); a refusal while looking is a **Failure**. Provider requests themselves are sent once, resent only when rate limited or never connected (`src/lib/server/enrich-failure.ts`).

### Providers and credit

**Connection**:
A provider credential a workspace can use: a pasted key or a deployment key.
_Avoid_: API keys (as a section name), providers (as a section name), edit keys

**Provider access**:
The resolved set of connections a request may use, chosen by a policy (browser or MCP) in a fixed precedence (`src/lib/server/provider-access.ts`).

**Credit ledger**:
The server record of included AI, TypeSafe and email credit reserved and settled per workspace (`src/lib/server/credit-ledger.ts`).

**Agent key**:
The single bearer key that lets an MCP client read, edit and enrich a workspace's sheets.
_Avoid_: Organization key, MCP token

## Relationships

- A **Workspace** holds up to 10 **Sheets**; a **Sheet** holds up to 1,000 rows.
- An **AI column** has exactly one **Operation**; a **Source column** has none.
- An **Operation**'s **References** determine which **Cells** an **Enrichment** waits on.
- Every write of a **Cell** passes **Admission** for its column and source.
- A **Run** that hits a non-retryable **Failure** becomes a **Halt** for its sheet.
- **Provider access** decides which **Connection** pays for each **Enrichment**; included credit is tracked by the **Credit ledger**.

## Example dialogue

> **Dev:** "If an agent writes `n/a` into a Website column, does the sheet break?"
> **Domain expert:** "No. The agent's write goes through **Admission** with source `agent`, which rejects it with a per-cell error. An **Enrichment** that returns `n/a` fails just that **Cell**; it never becomes a **Halt**."

## Flagged ambiguities

- "populate", "add rows" and "find rows" named the same flow. Resolved: **Find rows** in all UI copy; `populate` remains an internal module name.
- "enriched column", "Use AI" and "rule" named the same thing. Resolved: **AI column**.
