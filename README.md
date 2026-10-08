# looot-tables

Open-source Clay-style enrichment tables, powered by [looot](https://looot.ai) and Supabase.

## Install for agents

```bash
git clone https://github.com/loootai/looot-tables.git
claude mcp add --transport http looot https://api.looot.ai/mcp
```

See also: [awesome-looot-use-cases](https://github.com/loootai/awesome-looot-use-cases) (copy-paste recipes) and [awesome-gtm](https://github.com/loootai/awesome-gtm) (open-source GTM tools).

Import a CSV, add a column that runs a looot operation (work email, company data, Google results, LinkedIn profiles, and about 2,500 more endpoints), pick which rows to run, see the cost first, confirm. Each result is stored in its cell with its status and cost. Export the table as CSV when you are done.

It is a small Next.js app (App Router, TypeScript) with a Supabase Postgres database. There is one table of data per sheet and no background workers. The looot token stays on the server.

## What you can do

- Create a table or import a CSV (one input column per header).
- Search the looot catalog in plain words, inspect an operation to see its inputs and price, and add it as an enrichment column.
- Map each operation input to your columns with templates such as `{{Company website}}` or `https://{{Domain}}`. Inputs with a matching column name are filled in for you.
- Select rows and press Run column. The app shows the estimated cost and asks you to confirm before it spends anything.
- Cells show `pending`, `done` or `error`, plus the cost of that call. A cell that finished too slowly for one request stays `pending`; run the column again and it is read back without paying twice.
- Export the table, results included, as CSV.

## Quickstart

You need Node 20 or newer, a free Supabase project, and a looot account.

1. Create a Supabase project in the Supabase dashboard. Under Authentication, create your own user (email and password) and turn off public sign-ups (see Access below).
2. Get a looot agent token. In the looot dashboard open Settings, Agent tokens, create one, and tick `catalog.read`, `runs.read`, `runs.execute` and `usage.read`. Top up the balance from $5.
3. Clone and install.

   ```bash
   git clone https://github.com/loootai/looot-tables.git
   cd looot-tables
   npm install
   ```

4. Run the migration with the Supabase CLI.

   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase db push
   ```

   `supabase db push` applies `supabase/migrations/20261008000000_init.sql`. You can also paste that file into the SQL editor.

5. Copy `.env.example` to `.env.local` and fill it in.

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Project URL from Project Settings, API |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The anon (public) key from the same page |
   | `LOOOT_TOKEN` | The looot agent token. Server only. |
   | `LOOOT_API_URL` | Optional. Defaults to `https://api.looot.ai`. |

6. Start it.

   ```bash
   npm run dev
   ```

   Open http://localhost:3000, sign in, and import a CSV.

## Deploy to Vercel

Use the button text below in any README or page.

[Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Floootai%2Flooot-tables&env=NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY,LOOOT_TOKEN&project-name=looot-tables)

Set the three environment variables when Vercel asks. Mark `LOOOT_TOKEN` as sensitive. The run endpoint allows up to 60 seconds, which needs a Vercel plan that supports it; on a shorter limit, rows that do not finish stay `pending` and you run the column again.

## How billing works

looot is prepaid. You top up a balance (from $5) and every call draws from it. There is no subscription and no per-seat fee, and this app adds no markup.

- The price of an operation is shown when you pick it, and stored on the column.
- Before every run the app shows `rows x price per row` and asks you to confirm. The server refuses a run if the confirmed amount is lower than its own estimate.
- A failed call costs nothing. The cost on each cell is what looot actually charged for that call, and the header shows the table's total spend.
- Every run carries an idempotency key built from the column, row and input, so pressing Run twice never pays twice for the same input.
- If the balance runs out, the remaining cells show an error and nothing else is charged. Top up and run again.

## Access and security

The schema uses one simple rule: any signed-in user can read and write every table (`using (true)` for the `authenticated` role, with row level security on). That fits a single person or a small team sharing one workspace. It is not multi-tenant. To keep it private, create your user by hand and disable sign-ups in Authentication, Providers, Email. If you need separate workspaces per user, add an `owner_id uuid default auth.uid()` column to `tables` and change the policies to `owner_id = auth.uid()`.

The looot token is read from `LOOOT_TOKEN` in server code only (`src/lib/looot.ts`, route handlers under `src/app/api`). The browser never sees it. The server routes check your Supabase session before they call looot.

## How it works

```
browser  --supabase-js (anon key, your session, RLS)-->  Postgres   tables, columns, rows, cells
browser  --/api/looot/search, /api/looot/inspect------->  server  --LOOOT_TOKEN-->  api.looot.ai
browser  --/api/tables/run (6 rows per request)-------->  server  --POST /v1/runs?wait=15, poll GET /v1/runs/{id}-->  api.looot.ai
```

- `src/lib/mapping.ts` turns a row into an operation input from the column's `input_map`.
- `src/lib/cost.ts` estimates cost. `src/lib/csv.ts` imports and exports CSV.
- `src/lib/runner.ts` runs a column over rows with 3 in parallel, polls slow runs, and writes each cell.
- `src/lib/looot.ts` is the REST client: search, inspect, run, get run, balance.

## Development

```bash
npm test          # vitest: input mapping, cost, CSV, run flow with mocked HTTP
npm run typecheck
npm run build
```

Tests make no network calls. Turn on the leak scanner hook once per clone with `git config core.hooksPath .githooks`.

## Limits in v0.1.0

- The grid loads the whole table into the browser. It is fine for a few thousand rows.
- No formulas, no per-cell editing UI beyond double-click on input cells, no waterfall across several operations in one column. A looot `job:` id already lets looot pick the provider for you.
- Result fields are picked with a dot path such as `data.0.email`. If you leave it empty, the whole result is stored as JSON.

## License

MIT. See [LICENSE](LICENSE).
