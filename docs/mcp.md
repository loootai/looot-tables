# Enrichable MCP

Enrichable exposes a stateless Streamable HTTP MCP endpoint at `/mcp`. An external agent plans the workflow and requests successive batches. Enrichable validates operations, executes bounded calls, and persists results in the same workspace as the browser app. There is no background worker or durable job queue.

## Setup

1. Apply the database migrations with `npm run db:migrate`. Migration `003_mcp.sql` adds organization keys and request bookkeeping; `004_mcp_recoverable_keys.sql` adds encrypted key storage. Set `ENRICHABLE_MCP_ENCRYPTION_SECRET` to a stable random secret of at least 32 characters, identical on every server sharing the database, before creating or rotating keys. Keep a secure backup; changing it requires re-encrypting existing keys.
2. Open **Configuration → Agent access → Create agent key**.
3. Use **Copy MCP config** (the key is embedded) or **Show key** in Configuration at any time, including after reload and from another signed-in organization member’s account. The secret is encrypted at rest with AES-256-GCM, bound to the workspace and key version; authentication still uses its SHA-256 hash. Secrets are returned only by the authenticated reveal endpoint with `Cache-Control: no-store`, and are never saved to browser storage.
4. Paste the config into your MCP client. It uses your deployment's `/mcp` URL and an `Authorization: Bearer …` header. On self-hosted deployments, provider keys live only in your browser, so the config also carries the required `x-openai-key` and `x-context-key` headers.

For clients that accept an `mcpServers` configuration:

```json
{
  "mcpServers": {
    "enrichable": {
      "url": "https://www.enrichable.io/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_KEY",
        "x-openai-key": "YOUR_OPENAI_KEY",
        "x-context-key": "YOUR_CONTEXT_KEY"
      }
    }
  }
}
```

Exact client configuration varies. This endpoint requires a client that supports custom authorization headers. No OAuth setup is needed.

Each organization has exactly one active key, with full sheet and enrichment access and no scopes. Any signed-in member of that workspace can retrieve/copy the key, create the initial key, or rotate it. Rotation is atomic and immediately invalidates the previous key for new requests; requests already authenticated may finish. Concurrent creation and stale rotation attempts return a conflict. In self-hosted deployments, the key belongs to the current browser workspace.

The shared key grants access to Enrichable and its saved organization provider connections. Browser enrichment and MCP load the same organization vault and saved model/classifier defaults; additional provider headers are optional request-only overrides. Deployment provider keys and the sponsored OpenAI trial are not inherited by MCP. Sheet reads/writes and template columns require no provider credentials.

Migration `006_organization_settings.sql` adds organization preferences, encrypted provider records, and metadata-only audit events. Organization settings are keyed by verified identity issuer and organization ID. They are shared by every signed-in member and device, and can be managed in Configuration. Save new keys there; browsers receive only connection status and masked prefixes. Existing account-local keys/settings require explicit import, which refuses to overwrite existing organization configuration.

The current Context.dev Enrichable sign-in grant lasts 14 days and does not support refresh tokens. Sign-in persists its verified API key and expiration in the organization vault. Expired keys are not used; Settings offers reconnection. Healthy connections from another member and manually connected keys are preserved on ordinary sign-in. Explicit disconnect persists across later sign-ins until a member reconnects deliberately. A manually connected organization Context.dev API key supports unattended MCP use without the sign-in grant’s 14-day limit. Logging out only clears that browser session; it does not disconnect the organization provider.

Optional headers: `x-typesafe-key`, `x-hunter-key`, `x-prospeo-key`, `x-openai-model`, and `x-openai-base-url`. Base URL overrides use the same URL and DNS validation as browser enrichment. Overriding the saved OpenAI endpoint requires an explicit `x-openai-key`; a stored organization key is never forwarded to a different request-supplied endpoint.

## People lists

Use the people template, import the supplied names and identity clues, then call `enrich_cells` on the existing source **Name** column. This resolves the person and saves the matched photo in that cell's metadata while preserving the supplied spelling. Do not add a second Profile, Full name, or Profile photo column. Newly imported source names are eligible even though their text is already marked done; previously resolved names are skipped unless `overwrite` is true.

The browser's people-list flow uses the same lookup helper. Named lists enrich their supplied identities; unresolved names use people search and enrich a unique matching profile. Broad discovery searches first, then enriches accepted profiles for photos. Missing or ambiguous matches keep the supplied name and a placeholder. Both paths render the photo inside the first Name cell.

## Tools

| Tool | Behavior |
| --- | --- |
| `list_sheets` | Lists compact summaries with column names/IDs, revisions, row counts, and app links. Set `includeDefinitions: true` for full definitions. |
| `get_sheet` | Returns columns, revision, up to 100 rows, a relative app URL, and `nextOffset`. Pin subsequent pages to the first revision. |
| `create_sheet` | The single spreadsheet-creation tool: choose `template: "blank" | "companies" | "people" | "websites"` to reuse app layouts, or supply complete custom `columns`. Optional `enrichments` configure built-in operations immediately; matching preset column names are replaced, other names appended. Repeating a matching definition returns the existing sheet. Creation does not execute provider calls. |
| `upsert_rows` | Inserts or partially updates up to 100 rows using caller-supplied stable row IDs. Cell maps use column IDs. |
| `update_cells` | Changes up to 100 literal cell values. |
| `configure_column` | Adds or replaces a column definition using the existing typed operation schema; renamed references are updated and a rename alone keeps results current. A changed operation keeps saved values, as a browser edit does; they become outdated and are rerun only with `enrich_cells` and `overwrite: true`. |
| `delete_rows` | Deletes up to 100 rows. |
| `delete_sheet` | Deletes a sheet and its rows. |
| `get_cell_details` | Returns the saved cell, including status, sources, reasoning, confidence, timing, and errors when present. |
| `enrich_cells` | Runs up to five rows in one enrichment column, sequentially, and saves each result. Finished cells are skipped unless `overwrite: true`; each skipped outcome says `outdated: true` or `false`. |

Row/cell/column mutations and deletions require the current sheet revision. A conflict means the agent must reread the sheet and reconsider its edit. Caller-provided values are literals, including strings beginning with `=`. Existing workspace limits of 10 sheets and 1,000 rows per sheet apply.

A sheet saved by an older version is upgraded the first time an agent reads it, as the browser upgrades it when it opens: a website column still named Domain becomes Website, and references to it follow, so `{{Website}}` and repeated `create_sheet` calls match. The upgrade advances the revision once. Sheets with formulas are upgraded by the browser instead.

## Example workflow

Prefer Enrichable’s specialized operations over implementing providers, scraping, or research yourself. Use company/person fields for supported facts, Hunter/Prospeo for contact data, scrape/search for web data, check/classify/score for decisions, email-draft for emails, and no-cost template for deterministic text. Reserve generic ai and deep-research answer for work specialized operations cannot handle. All operations use the same validation and execution paths as the browser app.

For additional research beyond these operations, prefer the Context.dev MCP when available. Use people search and people enrichment to resolve identities, web search to find supporting sources, and web scrape or web answers to verify details. Write confirmed profile URLs or company domains back into the sheet, then rerun affected enrichments in dependency order to persist results and provenance. Never guess missing identities or URLs. If Context.dev MCP is unavailable, use Enrichable search/scrape/answer operations before another web research tool.

A single `create_sheet` call can create the app’s Companies layout with an existing column configured for enrichment:

```json
{
  "sheetId": "prospects",
  "name": "Prospects",
  "template": "companies",
  "enrichments": [
    {"id": "industry", "name": "Industry", "op": {"kind": "company", "domain": "{{Website}}", "field": "industry"}},
    {"id": "greeting", "name": "Greeting", "op": {"kind": "template", "template": "Hello {{Company}}"}}
  ]
}
```

Read the returned column IDs before importing rows (`source_1` is Company and `source_2` is Website for this preset), then call `enrich_cells`. Creation returns built-in operation guidance. No separate creation or operation-discovery tool is needed. Existing explicit-column requests still work:

1. `create_sheet` with `sheetId: "prospects"`, `name: "Prospects"`, and columns `[{"id":"website","name":"Website","type":"source"}]`.
2. `upsert_rows` with the returned revision and rows such as `{"id":"example","cells":{"website":"example.com"}}`.
3. `configure_column` with the current revision and `{"id":"description","name":"Description","type":"enriched","op":{"kind":"company","domain":"{{Website}}","field":"description"}}`.
4. `enrich_cells` with `sheetId`, `columnId: "description"`, `rowIds: ["example"]`, and a fresh `idempotencyKey`.
5. Inspect outcomes and repeat for the next rows. The agent supplies row discovery itself; automatic population is outside this version.

## Execution and retry semantics

Only one MCP enrichment batch runs per organization at a time. Additional calls return `busy` with retry guidance. Each batch accepts at most five cells and runs them sequentially. It stops starting additional cells after three minutes; remaining cells return `not_started`. The route has a five-minute hosting limit. Provider calls already in progress can be interrupted by that limit.

Readiness follows the same plan as the browser. Referenced enrichment cells must be `done`: while one is queued, running, or has never run, the outcome is `blocked` and the agent must enrich the prerequisites and submit a new request. The server does not recursively run dependencies. A failed prerequisite, a reference that matches no column, or a circular reference fails the cell with the browser's message (outcome `error`). Cells read `running` while an agent works on them, so open browser tabs show the progress; a cell left `running` for over ten minutes was abandoned and no longer blocks. That age is measured on the server's clock, which browser tabs also stamp their running cells with, so a machine whose clock is off neither expires a live run nor keeps an abandoned one. Finished cells are skipped unless `overwrite: true` is supplied: `done` cells, including completed null answers, whether current or outdated, as **Run unfinished cells** skips them in the browser. A result is outdated once the column's operation or the values it reads change (the browser shows a refresh icon); its skipped outcome carries `outdated: true`, and it keeps its value until it is rerun. After changing inputs or an operation, rerun affected prerequisites, then dependent columns, with `overwrite: true` and new idempotency keys, in dependency order. A failed rerun keeps the previous value and records the error. A finished cell that cannot run (a reference that matches no column, a circular reference, a failed prerequisite) is `blocked` without a write, even with `overwrite`. Each step reads the whole sheet at once. A result is saved in one transaction holding the workspace's write lock, so a browser tab saving elsewhere in the sheet meanwhile never loses it; marking a cell `running` before its provider call can still meet such a save, and is retried up to three times before the outcome is `conflict`, with nothing spent.

`idempotencyKey` identifies one batch within an organization. Repeat the same normalized arguments and key to retrieve its outcome without spending again. Reusing the key with different arguments returns a conflict. A deliberate rerun, including retrying previously blocked/failed/not-started cells, uses a new key. Attempt records currently remain in Postgres; they are not automatically expired.

Outcomes include `done`, `error`, `blocked`, `skipped` (with `outdated`), `conflict`, and `not_started`. A provider failure's outcome carries `failure`, decided by the same rule as browser runs. `failure.retryable` is true only when no provider did work for the cell: the request never reached the provider (DNS failed or the connection was refused), the provider refused it before processing (429), or Enrichable refused it first (the credit ledger's rate limit, or company research that is still running or just failed). It is false for anything after a request was sent (a timeout, a server error, a dropped connection, a truncated answer), and once the cell's enrichment paid for any provider request, company research included: the provider may have done and billed the work, so resubmitting can pay twice. Enrichable sends each provider request once, resending only one that was rate limited or never connected. A saved cell's `m` property contains available provenance and provider metadata. Structured content and a JSON text representation are both returned for MCP clients.

Results are committed against current inputs, column definitions, and the target cell. A concurrent edit produces `conflict` instead of overwriting newer work. Independent browser runs are not coordinated by the MCP batch lock and may still spend provider credits; avoid intentionally running the same cells from both interfaces at once.

If the process dies, the original request remains `running` until ten minutes after it started; the next enrichment call marks it `uncertain`. Repeating an uncertain request never automatically runs provider calls again. Inspect saved cells before deliberately submitting a new key: provider spending can have occurred without a saved result. Exactly-once billing cannot be guaranteed across provider/storage failures.

## Current limits

- Formula sheets can be read and deleted, but other MCP mutations/enrichment are rejected because formula calculation currently requires the browser worker.
- Enrichment runs only during an active HTTP request. The external agent must continue the workflow; there is no promise of completion after disconnects.
- Browser views refresh through the existing focus and polling behavior, rather than immediate push updates.
- No autonomous population, exports, MCP OAuth, permission scopes, or background jobs are added by this version.

## Verification

`node --conditions=react-server --test --import tsx tests/server/mcp.test.ts` runs the migration and operations against embedded Postgres, including key sharing/rotation, isolation, revision conflicts, dependencies, replay, concurrent edits, and a real MCP SDK client using stateless HTTP.
