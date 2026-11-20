# Development

For bugs and proposals, [open an issue](../CONTRIBUTING.md). This guide is for maintainers and people running their own forks; external PRs are not accepted.

## Setup

```bash
nvm use
npm ci
cp .env.example .env.local
# Set DATABASE_URL to a dedicated development database: Neon, or any Postgres, for example a local one.
npm run db:migrate
npm run dev
```

Use Node.js 22.23.4 as recorded in `.nvmrc`. If you manage Node without nvm, install that version and skip `nvm use`. Visit `/app` and enter your provider keys. Deployments use API keys. Do not configure OAuth or a session secret. Basic browser operation does not require an encryption root. MCP key creation/retrieval requires `ENRICHABLE_MCP_ENCRYPTION_SECRET`; see [MCP setup](mcp.md). Use the [README](../README.md) for deployment behavior and optional password-protected server keys.

## Architecture and common changes

| Area | Files and responsibility |
| --- | --- |
| App and API | `src/app/`: Next.js pages, request handlers, `/mcp` |
| Shared schema | `src/lib/types.ts`: validated sheets, cells, columns, and operations; `sheet-upgrade.ts` brings a sheet saved by an older version up to date wherever it is next read (browser or MCP) |
| Operation catalog | `src/lib/operations.ts`: one record per operation kind (references, row context, required providers, cost, worst-case time, validation) |
| References and columns | `src/lib/references.ts` (`{{…}}` grammar, renames, moves, dangling references), `column-roles.ts` (what a column means), `cell-admission.ts` (how a value from any source becomes a stored cell) |
| Grid and editing | `src/components/sheet/`: virtualized grid, editors, filters, import/export; `src/lib/sheet-commands.ts` holds the sheet's intent-level actions (run, stop, add and edit columns, delete, fill) behind the grid's props; `sheet-view.ts` keeps each viewer's filters and sort in their browser |
| Browser persistence | `src/lib/db.ts`, `sheet-remote.ts`, `sheet-cloud.ts`, `sheet-history.ts`: the IndexedDB cache commits every change through the `SheetRemote` seam and redoes it on a revision conflict; `sheet-cloud.ts` is its `/api/sheets` adapter (paging pinned to a revision, read retries, URLs); undo. Tests connect `tests/support/memory-remote.ts`, an in-memory workspace held to the real `/api/sheets` handlers (driven through `cloudSheets`) by `tests/server/sheet-remote-contract.test.ts` |
| Execution | `src/lib/enrichment-plan.ts` plans one cell for the browser runner and MCP alike (readiness, the record it sends, whether a saved result is complete, how results are stored and rechecked); `enrichment-freshness.ts` defines a run's inputs, from which its fingerprint and dependencies come; `runner.ts`, `cell-lifecycle.ts`, `populate-runner.ts`: concurrency, cancellation, halts on fatal failures, discovery; `tab-owner.ts` claims the owner a tab saves in its running cells (a Web Lock, so a duplicated tab is a new owner); `server-clock.ts` is the server time, learned from API responses, that running cells are stamped and expired on |
| Provider operations | `src/lib/server/enrich.ts`, `compose.ts`, `populate.ts`: validated provider calls; `enrich-failure.ts` classifies failures into structured reasons and holds the one retry rule for billable providers: the transport resend (`retryUnbilled`), and the per-enrichment spend tracker (`Spend`, recorded by `trackedFetch` and the OpenAI `spendMiddleware`) that decides whether a failure is still retryable. `looot.ts` is the one place that talks to looot: it sends each run with a fresh idempotency key, reads status, outcome and error from the run body, records the cost into the tracker, and keeps each run on the cell; `looot-jobs.ts` turns each job's answer into the shapes the operations use. Operations never count their own spend; `runOp` gives each enrichment a fresh tracker |
| Provider access | `src/lib/server/provider-access.ts`: which key, model, and endpoint a caller may use (browser and MCP policies), clients (OpenAI, looot, TypeSafe) wired to the access's spend tracker (`withSpend` gives an enrichment its own), endpoint guard, redaction |
| Database | `src/lib/server/database.ts`: `withDatabase` (Neon: HTTP reads, a pooled WebSocket for transactions. Any other Postgres: one small `pg` pool. `apiRoute` and `/mcp` open one per request; other callers, such as company context, open their own) and `Database` (`read`, `transaction` with the workspace create-and-lock, read-only snapshots, a rollback that keeps the original error). Tests use the PGlite adapter in `tests/support/database.ts`: every migration applied once per process, cloned per test |
| API routes | `src/lib/server/api-route.ts`: `apiRoute` gives signed-in routes `{ account, database }`; `failureOf` maps their errors and MCP's (our status-bearing errors keep their status, `parseInput` failures are 400, anything else is logged with a request id and answered 503). Provider routes (`routeInput` in `provider-access.ts`) map provider and credential failures themselves, using `failureOf` only for storage or configuration failures while resolving access |
| Storage and isolation | `src/lib/server/workspace-store.ts`: workspace-scoped SQL, quotas, revisions |
| Organization credentials | `src/lib/server/organization-store.ts`: encrypted provider vault and shared settings |
| Access modes | `src/lib/server/deployment.ts`, `self-hosted.ts`, `auth.ts`: browser workspaces, hosted OAuth, local developer sessions |
| Formulas | `src/lib/formulas.worker.ts`, `formula-*.ts`: IronCalc worker and editor; vendored catalog attribution in `src/lib/formula-catalog/` |
| Agent access | `src/lib/server/mcp-*.ts`, `mcp.ts`: MCP tools, workspace keys, bounded execution |

Browser edits persist through the sheet API into Neon and are cached in IndexedDB. Writes carry revisions and execute within workspace transactions. Browser enrichment calls an API operation and saves results through the same sheet persistence path. MCP writes use the workspace store directly. Neon Realtime is optional; polling/focus refresh is the fallback. There is no durable enrichment worker.

For a new operation, add its schema in `types.ts` and its record in `operations.ts` (the catalog test fails until the record is complete), then server execution, column composition and editor, and MCP operation guidance as applicable. Domain terms are defined in [CONTEXT.md](../CONTEXT.md). For data-model changes, update migrations and storage alongside browser serialization. Cover behavior and isolation with focused tests; avoid putting real provider credentials or customer records into fixtures.

This repository uses a newer Next.js version. Before changing framework behavior, read the relevant bundled documentation in `node_modules/next/dist/docs/`, as required by [AGENTS.md](../AGENTS.md).

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run typecheck` generates Next.js route types before running TypeScript, so it works before the first dev server or build.

`npm test` covers browser-independent behavior and server operations, including SQL against embedded PGlite and mocked providers. It does not require a production database or paid provider keys. The production build downloads the Google fonts configured in `src/app/layout.tsx`, so it needs network access. CI runs these four checks from `npm ci` without deployment secrets. Separate CI jobs scan Git history for secrets and run `npm run test:browser:smoke`, self-hosted agent-access and own-key UI tests with mocked API endpoints and no database. This smoke check does not replace the full live database suite.

For browser tests:

```bash
npx playwright install chromium
npm run test:self-hosted
npm run test:browser
```

Use a dedicated migrated development database for browser tests. The self-hosted suite starts its own server on port 3107 without OAuth. It covers API-key onboarding, persistence, browser isolation, and agent access; live Realtime checks require a separately configured Neon Realtime branch and otherwise skip. The main browser suite uses its local identity fixture. Review `playwright*.config.ts` before running. Traces and screenshots can contain sheet data; keep them out of Git.

`scripts/mock-looot.mjs` is a local stand-in for the looot REST API on `http://127.0.0.1:4546` (runs, rows batches with continuation, `quoteOnly`, fallback routes with several attempts, `nextSteps`, catalog search with measured numbers, feedback). Start it with `node scripts/mock-looot.mjs --openai` and run the app with `LOOOT_API_URL=http://127.0.0.1:4546`, any `LOOOT_TOKEN`, and `OPENAI_BASE_URL=http://127.0.0.1:4545/v1`. All its data is invented and no call costs anything.

`scripts/mock-openai.mjs` provides an OpenAI-compatible fixture server on `http://localhost:4545/v1` for manual local testing. It is synthetic, not a live-model quality check. Use test keys and synthetic rows.

## Database changes

Add the next numbered `.sql` file under `migrations/`. `npm run db:migrate` applies all files in name order in one transaction, protected by a transaction-level advisory lock so overlapping deployments serialize. It reruns them on later invocations, so migrations must be safe to repeat. The runner splits statements on semicolons: avoid function bodies or SQL strings containing semicolons unless you first update the runner. Keep schema changes confined to `enrichable` and prefer additive changes that work while old and new servers overlap.

Verify new SQL with PGlite tests and a separate Neon development branch before deployment. Do not run tests against production data. The explicit `ENRICHABLE_LIVE_DB_TEST=true` workspace-store check writes temporary workspaces to the configured database; use it only against a dedicated test branch. Apply migrations before code that depends on the new schema. A code rollback does not undo a migration or safely remove budget ledgers.

Vercel uses `vercel.json` to run migrations before the production build. A migration error stops deployment. Ordinary `npm run build` does not connect to or migrate a database. See [deployment setup](deploy.md) for the guided Neon flow and existing projects.

