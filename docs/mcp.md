# looot tables MCP

looot tables exposes a stateless Streamable HTTP MCP endpoint at `/mcp`. An external agent plans the workflow and requests successive batches. looot tables validates operations, executes bounded calls, and persists results in the same workspace as the browser app. There is no background worker or durable job queue.

## Setup

1. Apply the database migrations with `npm run db:migrate`. Migration `003_mcp.sql` adds organization keys and request bookkeeping; `004_mcp_recoverable_keys.sql` adds encrypted key storage. Set `LOOOT_TABLES_MCP_ENCRYPTION_SECRET` to a stable random secret of at least 32 characters, identical on every server sharing the database, before creating or rotating keys. Keep a secure backup; changing it requires re-encrypting existing keys.
2. Open **Configuration → Agent access → Create agent key**.
3. Use **Copy MCP config** (the key is embedded) or **Show key** in Configuration at any time, including after reload and from another signed-in organization member’s account. The secret is encrypted at rest with AES-256-GCM, bound to the workspace and key version; authentication still uses its SHA-256 hash. Secrets are returned only by the authenticated reveal endpoint with `Cache-Control: no-store`, and are never saved to browser storage.
4. Paste the config into your MCP client. It uses your deployment's `/mcp` URL and an `Authorization: Bearer …` header. On self-hosted deployments, provider keys live only in your browser, so the config also carries the required `x-openai-key` and `x-looot-key` headers.

For clients that accept an `mcpServers` configuration:

```json
{
  "mcpServers": {
    "looot-tables": {
      "url": "https://your-deployment.example/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_KEY",
        "x-openai-key": "YOUR_OPENAI_KEY",
        "x-looot-key": "YOUR_LOOOT_TOKEN"
      }
    }
  }
}
```

Exact client configuration varies. This endpoint requires a client that supports custom authorization headers. No OAuth setup is needed.

Each organization has exactly one active key, with full sheet and enrichment access and no scopes. Any signed-in member of that workspace can retrieve/copy the key, create the initial key, or rotate it. Rotation is atomic and immediately invalidates the previous key for new requests; requests already authenticated may finish. Concurrent creation and stale rotation attempts return a conflict. In self-hosted deployments, the key belongs to the current browser workspace.

The shared key grants access to looot tables and its saved organization provider connections. Browser enrichment and MCP load the same organization vault and saved model/classifier defaults; additional provider headers are optional request-only overrides. Deployment provider keys and the sponsored OpenAI trial are not inherited by MCP. Sheet reads/writes and template columns require no provider credentials.

Migration `006_organization_settings.sql` adds organization preferences, encrypted provider records, and metadata-only audit events. Organization settings are keyed by verified identity issuer and organization ID. They are shared by every signed-in member and device, and can be managed in Configuration. Save new keys there; browsers receive only connection status and masked prefixes. Existing account-local keys/settings require explicit import, which refuses to overwrite existing organization configuration.

Optional headers: `x-looot-key`, `x-typesafe-key`, `x-openai-model`, and `x-openai-base-url`. Base URL overrides use the same URL and DNS validation as browser enrichment. Overriding the saved OpenAI endpoint requires an explicit `x-openai-key`; a stored organization key is never forwarded to a different request-supplied endpoint.

## People lists

Use the people template, import the supplied names and identity clues, then call `enrich_cells` on the existing source **Name** column. This resolves the person and saves the matched photo in that cell's metadata while preserving the supplied spelling. Do not add a second Profile, Full name, or Profile photo column. Newly imported source names are eligible even though their text is already marked done; previously resolved names are skipped unless `overwrite` is true.

The browser's people-list flow uses the same lookup helper. Named lists enrich their supplied identities; unresolved names use people search and enrich a unique matching profile. Broad discovery searches first, then enriches accepted profiles for photos. Missing or ambiguous matches keep the supplied name and a placeholder. Both paths render the photo inside the first Name cell.

## Connect a client

Every client needs the endpoint (`https://your-deployment.example/mcp`), the organization key as `Authorization: Bearer …`, and, on a self-hosted copy, your own `x-looot-key` (and `x-openai-key` for AI columns).

**Claude Code**

```bash
claude mcp add --transport http looot-tables https://your-deployment.example/mcp \
  --header "Authorization: Bearer YOUR_MCP_KEY" \
  --header "x-looot-key: YOUR_LOOOT_TOKEN" \
  --header "x-openai-key: YOUR_OPENAI_KEY"
```

**Cursor**: add the server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) with the `mcpServers` block above.

**ChatGPT**: ChatGPT's custom connectors accept OAuth or no authentication, and this endpoint needs a bearer key, so ChatGPT cannot connect to it directly yet. From the OpenAI Responses API, use the remote MCP tool, which sends headers:

```json
{
  "type": "mcp",
  "server_label": "looot-tables",
  "server_url": "https://your-deployment.example/mcp",
  "headers": { "Authorization": "Bearer YOUR_MCP_KEY", "x-looot-key": "YOUR_LOOOT_TOKEN" },
  "require_approval": { "always": { "tool_names": ["run_column", "find_rows", "enrich_cells", "delete_sheet", "delete_rows", "update_spend_guard"] } }
}
```

**eve**: `examples/eve-agent/` is an [eve](https://eve.dev) agent whose only connection is this server. Its connection file sends the key as headers and asks for approval before every paid or deleting tool:

```ts
// examples/eve-agent/agent/connections/looot-tables.ts
export default defineMcpClientConnection({
  url: process.env.LOOOT_TABLES_MCP_URL ?? "http://localhost:3000/mcp",
  description: "looot tables: lead-list spreadsheets …",
  headers: () => ({ Authorization: `Bearer ${process.env.LOOOT_TABLES_MCP_KEY}`, "x-looot-key": process.env.LOOOT_TOKEN ?? "" }),
  approval: ({ toolName }) => (ASK_FIRST.some((name) => toolName.endsWith(`__${name}`)) ? "user-approval" : "not-applicable"),
});
```

See [examples/eve-agent/README.md](../examples/eve-agent/README.md) to run it with `eve dev`.

## Money: quote, then run with a budget

Tools that spend looot credit never run on an agent's word alone:

1. `quote_run` (a column) or `quote_find_rows` (a search) is free. It returns a `quoteId`, a `label` such as "Run 50 rows · up to $0.21", `tryFirst` (the same run on 5 rows) and the sheet's cap and what is left.
2. Show the label to the user. Run only after they agree.
3. `run_column` or `find_rows` needs the `quoteId`, `maxUsd` (no more than the user approved) and an `idempotencyKey`. A call without them is refused.

On the server each paid cell is held against its per-cell cap (sent to looot as `fallback.maxCostUsd`), the run's `maxUsd`, and the sheet's spend cap (default $5) before it starts. A cell that does not fit does not start, and nothing is sent to looot. A column that changed after its quote is refused, and the client has to quote again. Repeating a quote with the same key returns the first run. `get_run_status` shows progress, fill rate and spend, and `cancel_run` stops a run from starting more cells. New columns: run `rows: 5` first.

## Tools

33 tools. **Kind** says what a tool may do: read (no change, no spend), write (changes the workspace, spends nothing), paid (spends looot credit, needs a quote and a budget), destructive (deletes or loosens a guard). Each tool's description ends with one example call.

| Tool | Kind | What it does |
| --- | --- | --- |
| `list_sheets` | read | Sheets with column names and ids, revisions, row counts and app links. |
| `get_sheet` | read | Columns, revision and up to 100 rows with full cells. Page with `offset`. |
| `query_rows` | read | Rows as plain values (column name → value), filtered, searched and sorted, 100 per page. Use it to look at data. |
| `get_cell_details` | read | One cell's value, status, sources, confidence and receipt: each looot run, the providers tried in order, outcome and cost. |
| `export_sheet` | read | The sheet as CSV or JSON text, optionally with confidence and sources, up to 1 MB. |
| `create_sheet` | write | A sheet from a template (blank, companies, people, websites) or custom columns, with optional enrichment columns. |
| `rename_sheet` | write | Rename a sheet. |
| `duplicate_sheet` | write | Copy a sheet, with or without its rows and results. |
| `save_view` | write | Save filters and a sort as the sheet's starting view. |
| `upsert_rows` | write | Insert or update up to 100 rows by id. |
| `update_cells` | write | Edit up to 100 cells. |
| `delete_rows` | write | Delete up to 100 rows. |
| `import_rows` | write | Append rows from CSV text or a public https CSV URL (2 MB at most). New headers become columns. |
| `dedupe_rows` | write | Find rows with the same key columns (dry run by default) and delete all but the first or last. |
| `configure_column` | write | Add or change any column: every operation (AI research with sources, company and person data, find and verify email, phone, scrape, search, check, classify, score, email draft, template, any looot endpoint). |
| `add_looot_column` | write | A column on any looot catalog endpoint or job, inputs mapped from `{{Column}}` templates. Inspects the endpoint for input types and price. |
| `add_contact_columns` | write | Work email (find, then verify in the same cell) and optionally Phone, with inputs taken from the sheet's Name, Company, website and LinkedIn columns. |
| `unpack_column` | write | Turn a company or looot column's stored answers into columns (Industry, Headcount, HQ, Funding, Stage, Founded). $0. |
| `set_column_routing` | write | A looot column's provider order (balanced, cheapest, reliable, fastest), providers to skip, and MoltSets source. |
| `get_next_steps` | read | Follow-up jobs looot suggested after hits (verify, phone, tech stack…), with a price per row and the column to add. |
| `quote_run` | read | Free. Cells a column run would fill and the most it can cost, the 5-row trial, and the sheet cap. |
| `run_column` | paid | Run a quote with `maxUsd` and an idempotency key, 4 cells at a time. `rows: 5` runs the trial. |
| `enrich_cells` | paid | Run up to 5 cells of a column. Paid columns need `maxUsd`. Prefer `quote_run` and `run_column`. |
| `get_run_status` | read | A run's progress and spend, and the column's fill rate, errors, cost and providers. |
| `cancel_run` | write | Stop a run from starting more cells. |
| `quote_find_rows` | read | Free. Price a search for companies (company.search with filters) or people (people.search by title at given domains, a column's domains, or companies found from a description). |
| `find_rows` | paid | Run a find-rows quote within `maxUsd`. Duplicates of rows already in the sheet are skipped. |
| `search_catalog` | read | Free. looot endpoints and jobs for a task, with price, success rate and latency. |
| `inspect_endpoint` | read | Free. An endpoint's inputs and price. |
| `get_spend` | read | looot balance, and a sheet's cap, spend, holds and halted columns. |
| `update_spend_guard` | destructive | Change a sheet's spend cap or resume a halted column. Only on the user's request. |
| `moltsets_plan` | read | Free. The MoltSets plan meter: records left in the 5-hour and weekly windows. |
| `delete_sheet` | destructive | Delete a sheet. `confirm` must be the sheet's name, after the user agreed. |

Row, cell and column changes need the current sheet revision. A conflict means the agent has to read the sheet again. Values are literals, including strings that start with `=`. Workspace limits are 10 sheets and 1,000 rows per sheet. Errors say what to do next, for example "Unknown quoteId. Call quote_run … first" or "maxUsd $0.01 is below one cell's cap ($0.069)".

## Resources and prompts

- **Resource** `looot-tables://sheets/{sheetId}.csv`: each sheet's visible columns as CSV, listed per sheet.
- **Prompts** (recipes): `find-people-verify-emails` (role, companies, count), `research-companies` (companies, question) and `enrich-my-csv` (CSV URL, what to add). Each one lists the tools in the order that keeps money behind a quote. The in-app agent offers the same three as starter prompts.

## Example workflow

Prefer looot tables’s specialized operations over implementing providers, scraping, or research yourself. Use company/person fields for supported facts, the email, verify and phone columns for contact data, scrape/search for web data, check/classify/score for decisions, email-draft for emails, and no-cost template for deterministic text. Reserve generic ai and deep-research answer for work specialized operations cannot handle. All operations use the same validation and execution paths as the browser app.

For additional research beyond these operations, prefer the looot MCP when available. Use people search and people enrichment to resolve identities, web search to find supporting sources, and web scrape or web answers to verify details. Write confirmed profile URLs or company domains back into the sheet, then rerun affected enrichments in dependency order to persist results and provenance. Never guess missing identities or URLs. If the looot MCP is unavailable, use looot tables search/scrape/answer operations before another web research tool.

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

Read the returned column IDs before importing rows (`source_1` is Company and `source_2` is Website for this preset), then run the columns (`quote_run`, then `run_column`). Creation returns built-in operation guidance. No separate creation or operation-discovery tool is needed. Existing explicit-column requests still work:

1. `create_sheet` with `sheetId: "prospects"`, `name: "Prospects"`, and columns `[{"id":"website","name":"Website","type":"source"}]`.
2. `upsert_rows` with the returned revision and rows such as `{"id":"example","cells":{"website":"example.com"}}`.
3. `configure_column` with the current revision and `{"id":"description","name":"Description","type":"enriched","op":{"kind":"company","domain":"{{Website}}","field":"description"}}`.
4. `quote_run` with `sheetId` and `columnId: "description"`. Show the user its `label`.
5. After they agree, `run_column` with the `quoteId`, `maxUsd` from the quote and a fresh `idempotencyKey`. Inspect the outcomes with `query_rows` or `get_cell_details`.
6. To add rows by search instead of by hand, `quote_find_rows`, then `find_rows`.

## Execution and retry semantics

Only one MCP enrichment batch runs per organization at a time. Additional calls return `busy` with retry guidance. Each batch accepts at most five cells and runs them sequentially. It stops starting additional cells after three minutes; remaining cells return `not_started`. The route has a five-minute hosting limit. Provider calls already in progress can be interrupted by that limit.

Readiness follows the same plan as the browser. Referenced enrichment cells must be `done`: while one is queued, running, or has never run, the outcome is `blocked` and the agent must enrich the prerequisites and submit a new request. The server does not recursively run dependencies. A failed prerequisite, a reference that matches no column, or a circular reference fails the cell with the browser's message (outcome `error`). Cells read `running` while an agent works on them, so open browser tabs show the progress; a cell left `running` for over ten minutes was abandoned and no longer blocks. That age is measured on the server's clock, which browser tabs also stamp their running cells with, so a machine whose clock is off neither expires a live run nor keeps an abandoned one. Finished cells are skipped unless `overwrite: true` is supplied: `done` cells, including completed null answers, whether current or outdated, as **Run unfinished cells** skips them in the browser. A result is outdated once the column's operation or the values it reads change (the browser shows a refresh icon); its skipped outcome carries `outdated: true`, and it keeps its value until it is rerun. After changing inputs or an operation, rerun affected prerequisites, then dependent columns, with `overwrite: true` and new idempotency keys, in dependency order. A failed rerun keeps the previous value and records the error. A finished cell that cannot run (a reference that matches no column, a circular reference, a failed prerequisite) is `blocked` without a write, even with `overwrite`. Each step reads the whole sheet at once. A result is saved in one transaction holding the workspace's write lock, so a browser tab saving elsewhere in the sheet meanwhile never loses it; marking a cell `running` before its provider call can still meet such a save, and is retried up to three times before the outcome is `conflict`, with nothing spent.

`idempotencyKey` identifies one batch within an organization. Repeat the same normalized arguments and key to retrieve its outcome without spending again. Reusing the key with different arguments returns a conflict. A deliberate rerun, including retrying previously blocked/failed/not-started cells, uses a new key. Attempt records currently remain in Postgres; they are not automatically expired.

Outcomes include `done`, `error`, `blocked`, `skipped` (with `outdated`), `conflict`, and `not_started`. A provider failure's outcome carries `failure`, decided by the same rule as browser runs. `failure.retryable` is true only when no provider did work for the cell: the request never reached the provider (DNS failed or the connection was refused), the provider refused it before processing (429), or looot tables refused it first (the credit ledger's rate limit, or company research that is still running or just failed). It is false for anything after a request was sent (a timeout, a server error, a dropped connection, a truncated answer), and once the cell's enrichment paid for any provider request, company research included: the provider may have done and billed the work, so resubmitting can pay twice. looot tables sends each provider request once, resending only one that was rate limited or never connected. A saved cell's `m` property contains available provenance and provider metadata. Structured content and a JSON text representation are both returned for MCP clients.

Results are committed against current inputs, column definitions, and the target cell. A concurrent edit produces `conflict` instead of overwriting newer work. Independent browser runs are not coordinated by the MCP batch lock and may still spend provider credits; avoid intentionally running the same cells from both interfaces at once.

If the process dies, the original request remains `running` until ten minutes after it started; the next enrichment call marks it `uncertain`. Repeating an uncertain request never automatically runs provider calls again. Inspect saved cells before deliberately submitting a new key: provider spending can have occurred without a saved result. Exactly-once billing cannot be guaranteed across provider/storage failures.

## Current limits

- Formula sheets can be read and deleted, but other MCP mutations/enrichment are rejected because formula calculation currently requires the browser worker.
- Runs happen only during an active HTTP request (about 280 seconds of cells per call). Cells left come back `not_started`: run the quote again with a new idempotency key to continue.
- Browser views refresh through the existing focus and polling behavior, rather than immediate push updates.
- No MCP OAuth, permission scopes or background jobs. `find_rows` searches with filters; the browser's populate agent is not exposed.

## Verification

`node --conditions=react-server --test --import tsx tests/server/sheet-tools.test.ts` runs every new tool against the looot and MoltSets stand-ins, including the quote and budget rules. `scripts/mcp-smoke.mjs` runs a people search, a verified email column and a 5-row trial through the official MCP client against a running server.

`node --conditions=react-server --test --import tsx tests/server/mcp.test.ts` runs the migration and operations against embedded Postgres, including key sharing/rotation, isolation, revision conflicts, dependencies, replay, concurrent edits, and a real MCP SDK client using stateless HTTP.
