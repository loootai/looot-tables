<p align="center">
  <img src=".github/assets/banner.png" alt="looot tables, an open-source enrichment sheet where every cell is a looot job with its provider and cost" width="100%" />
</p>

<p align="center">
  Powered by
  <a href="https://looot.ai"><img src="public/providers/looot.svg" alt="" width="16" height="16" /> looot</a>
  +
  <a href="https://moltsets.com"><img src="public/providers/moltsets.svg" alt="" width="16" height="16" /> MoltSets</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-004e32?style=flat-square" alt="MIT license" /></a>
  <a href="docs/mcp.md"><img src="https://img.shields.io/badge/MCP-server-004e32?style=flat-square" alt="MCP server" /></a>
  <a href="#self-hosting"><img src="https://img.shields.io/badge/self--host-Node%2022%20%2B%20Postgres-004e32?style=flat-square" alt="Self-host with Node 22 and Postgres" /></a>
</p>

looot tables is an open-source spreadsheet for sales and growth teams who build lead lists and enrich them. You describe the companies or people you want, it finds the rows, and each new column fills every row with a work email, a phone, company data or an AI answer. Every outside lookup runs as a [looot](https://looot.ai) job on your own looot balance, and each cell keeps a receipt with the providers looot tried, in order, with the price and time of each. If you pay for a [MoltSets](https://moltsets.com) plan, work email and phone columns ask MoltSets first at $0 per row and send only the misses to looot.

## Tour

Every screenshot below comes from a production build running against the local stand-ins in `scripts/`. The ten companies and their logos are real. The people are fictional, and every email, phone, headcount, funding figure and price is invented by the stand-ins.

<img src="docs/media/01-hero.png" alt="A sheet of 10 contacts with Industry, Funding, Work email and Phone columns filled" width="100%" />

Ten contacts at ten companies, with Industry, Funding, Work email and Phone filled in. Each email cell shows a grade (A to F from MoltSets, or Valid, Risky, Catch-all and Invalid from a looot check) and the logo of the provider that answered. The bottom bar reads "Spent $0.231 on this sheet · 87% found" next to the sheet's cap, "Cap $5.00 · $0.231 used".

### Agents and MCP

Type what you want and an agent builds the sheet. Open a sheet, click **Agent** (or press ⌘K) and ask: "Find heads of RevOps at 50-500 person SaaS companies, then get their work emails and verify them."

<img src="docs/media/19-agent-panel.png" alt="The agent panel next to a sheet of 10 heads of RevOps with verified work emails, showing its steps, two run cards with provider logos and the result" width="100%" />

The agent creates columns, adds rows and searches the catalog by itself, and shows each step in one line. It never spends on its own: paid work comes back as a quote card, and the agent continues after you click. Here a people search found 10 contacts for $0.03, and the Work email column ran on 5 rows, then on the other 5: 8 addresses found and checked (4 valid, 2 risky, 1 catch-all, 1 invalid) and 2 misses, $0.03 per run.

<img src="docs/media/20-agent-confirm.png" alt="A quote card reading Run 10 rows · up to $0.242 with Run 10 rows, Try 5 rows and Cancel" width="100%" />

Each card names the column, the job, the most the run can cost and what is left under the sheet's cap. A new column highlights **Try 5 rows**. The agent runs on Claude (`claude-sonnet-5-5`) with your Anthropic key, or on your OpenAI model. See [docs/agent.md](docs/agent.md).

Agents outside the app use the same tools through the MCP server at `/mcp`: Claude Code, Cursor, the OpenAI Responses API, or an [eve](https://eve.dev) agent ([examples/eve-agent](examples/eve-agent)).

```bash
claude mcp add --transport http looot-tables https://your-deployment.example/mcp \
  --header "Authorization: Bearer YOUR_MCP_KEY" --header "x-looot-key: YOUR_LOOOT_TOKEN"
```

| Area | Tools |
| --- | --- |
| Sheets | `list_sheets`, `get_sheet`, `create_sheet`, `rename_sheet`, `duplicate_sheet`, `delete_sheet` (with confirm), `save_view` |
| Rows | `query_rows`, `upsert_rows`, `update_cells`, `delete_rows`, `import_rows` (CSV text or URL), `dedupe_rows`, `export_sheet` |
| Find rows | `quote_find_rows`, `find_rows` (company.search and people.search with filters) |
| Columns | `configure_column` (every column type), `add_looot_column` (any looot endpoint), `add_contact_columns` (find and verify email, phone), `unpack_column`, `set_column_routing`, `get_next_steps` |
| Runs | `quote_run`, `run_column`, `get_run_status`, `cancel_run`, `get_cell_details` (the receipt), `enrich_cells` |
| Money and catalog | `get_spend`, `update_spend_guard`, `search_catalog`, `inspect_endpoint`, `moltsets_plan` |

Every paid tool needs a quote id, a budget and an idempotency key, and the server holds each cell against its per-cell cap and the sheet's spend cap. The server also offers each sheet as a CSV resource and three recipe prompts. Details are in [docs/mcp.md](docs/mcp.md).

### Find rows

<img src="docs/media/12-find-rows.png" alt="A people search filling a new sheet row by row" width="100%" />

Type "Revenue and growth leaders at developer-tools and SaaS companies in the US", pick People, and press the arrow. The model finds companies through the looot `company.search` job, then people at each one through `people.search`, and rows stream in with name, title, company, website and LinkedIn. The header counts them as they land ("Added 1 (7 of 20)").

<img src="docs/media/13-import-csv.png" alt="The Import a CSV dialog with a pasted list and a preview" width="100%" />

Or start from a list you already have. Drop or paste a CSV, name the sheet, and the dialog previews the first rows and counts them ("10 rows · 3 columns") before you import. The first row becomes the column headers.

### Research

<img src="docs/media/14-research-running.png" alt="An AI column researching each row while the bottom bar counts progress" width="100%" />

An AI column asks "Does {{Company}} publish a public pricing page?" for every row. Four cells show "Researching…" at a time (the parallel setting), the rest wait as "Queued", and finished rows already show answers such as "Yes: stripe.com/pricing". The header shows the estimate, about $0.0040 per row.

<img src="docs/media/15-research-answer.png" alt="A finished research cell open with confidence, cost, the looot runs behind it and its source" width="100%" />

Open a finished cell to see the answer, a 0.94 confidence, the cost ($0.0030) and the time (2.8 s). The receipt lists the two looot runs behind it, a `web.search` for $0.0010 and a `web.scrape.markdown` page read for $0.0020, and the source link the answer cites.

### Contact data: MoltSets first, then looot

<img src="docs/media/07-moltsets-key-and-meter.png" alt="The MoltSets key dialog on the Configuration page, with the plan meter in the sidebar" width="100%" />

Configuration lists each connection: looot and MoltSets keys saved in this browser, OpenAI from the deployment, TypeSafe not connected. "Replace key" opens this dialog for a MoltSets `ms_` key. Once a key is connected, the sidebar shows the records left in the current 5 hour window (14,995) and the phone tokens left (98) under the looot balance.

<img src="docs/media/03-column-filling.png" alt="The Work email column filling, with provider logos in the running cells" width="100%" />

The Work email column filling. Rows MoltSets answered are done right away; the others walk looot's email providers, and each running cell shows the provider it is asking and its step ("apollo 3/3", "hunter 2/3"). The bottom bar reads "Enriching 5/10" and a Stop button ends the run.

<img src="docs/media/08-email-grades.png" alt="Work email, Phone and research columns side by side with grades and provider logos" width="100%" />

Emails MoltSets found carry its risk grade: A and B green, C amber, D red, F grey. Emails looot found are checked in the same cell and show Valid, Risky, Catch-all or Invalid. The logo at the end of each cell is the provider that answered, and a miss reads "Not found · $0" when nothing was charged.

<img src="docs/media/16-phone-lookup.png" alt="A phone cell's receipt: MoltSets miss, ContactOut miss, QuickEnrich hit" width="100%" />

A phone cell's receipt. MoltSets could not match a LinkedIn profile ($0), then looot asked ContactOut (miss, $0, 1.2 s) and QuickEnrich, which found the number for $0.028 in 1.1 s.

### Cost and control

<img src="docs/media/02-run-quote.png" alt="The Run button quoting the most a run can cost, with the run menu open" width="100%" />

Before anything runs, the Run button says what it will do and the most it can cost: "Run 10 cells · up to $0.12". The menu next to it runs only unfinished cells or re-runs the visible rows, and the box beside it shows the sheet's cap and what it has used ("Cap $5.00 · $0.35 used").

<img src="docs/media/06-unpack-and-next-steps.png" alt="Industry, Headcount, HQ and Funding columns, plus two faint next-step columns" width="100%" />

One company lookup per row filled Industry. Headcount, HQ and Funding were unpacked from the answers it already holds, so they ran nothing and cost $0. The two faint columns on the right are next steps looot suggested, "Find decision makers $0.0040/row" and "Tech stack $0.012/row". Neither runs until you click it.

### Receipts and routing

<img src="docs/media/04-receipt-fallback.png" alt="A work email receipt: MoltSets miss, then prospeo, hunter and apollo" width="100%" />

Open any cell for its receipt. Here MoltSets had no address on the plan ($0, "MoltSets does not charge for a miss", 14,996 records left this window). looot then asked prospeo (miss, $0, 754 ms) and hunter (miss, $0, 671 ms), and apollo found it for $0.0061 in 896 ms. A verify run follows below it, and every run has a "Report bad result" link.

<img src="docs/media/05-routing-editor.png" alt="The routing editor for the Work email column" width="100%" />

The "Balanced" pill on a column header opens its routing. Pick Cheapest, Reliable, Fastest or Balanced, see each provider's hit rate, median time and price per call (prospeo 62%, 0.6 s, $0.0042), and switch a provider off to skip it. looot asks the next provider only after a miss.

### Self-host and MCP

<img src="docs/media/17-mcp.png" alt="Agent access with an agent key and the MCP config" width="100%" />

Configuration → Agent access creates one agent key for the workspace and shows the config to paste into Claude Code, Cursor or another MCP client. On a self-hosted copy the agent also sends `x-openai-key` and `x-looot-key` headers, because keys saved in the browser never leave it.

<img src="docs/media/18-export.png" alt="The Export menu with CSV, Excel and JSON" width="100%" />

Export the sheet as CSV, Excel or JSON, with or without each cell's confidence and sources. Hidden columns stay out ("Exporting all 10 rows · 5 hidden columns excluded").

<img src="docs/media/10-phone.png" alt="The sheet and a cell receipt on a 390px phone screen" width="100%" />

On a 390px phone the sheet keeps search, Find rows, the spend line and the Run button, and a cell's receipt opens as a full-width panel.

<img src="docs/media/11-landing.png" alt="The looot tables landing page" width="100%" />

The landing page that ships with the app. Its hero sheet and receipt fit above the fold at 1440 by 900.

<img src="docs/media/09-dark-hero.png" alt="The same sheet in dark mode" width="100%" />

The same sheet in dark mode, which follows your system setting.

## Open-source Loopster alternative: MoltSets + looot

Loopster sells a table of enrichment columns for a flat monthly fee. looot tables gives you the table for $0 under MIT. For contact data you can bring a MoltSets plan, which charges a flat monthly fee with limits per window. Everything else goes to looot, which bills each hit to a prepaid balance.

Prices read 2026-11-20 from their public pricing pages. Both vendors change them, so check before you decide.

| | Loopster | MoltSets |
| --- | --- | --- |
| Plans | Launch $179/mo, Scale $449/mo, Unlimited $1,299/mo | Solo $27/mo, Pro $97/mo, plus a free tier and larger plans |
| Limits | Requests per day | Records and requests per rolling 5 hours and per week |
| Work emails | In the plan | $0 per row on the plan |
| Mobiles | On Scale and Unlimited | Not in the plan. Separate phone tokens, from $27 for 180 ($0.15 each) |

An example. A team finds about 10,000 work emails and 2,000 mobiles a month.

| | Loopster Scale | MoltSets Pro + looot + looot tables |
| --- | --- | --- |
| Table | In the plan | $0 (MIT) |
| Flat fee | $449/mo | $97/mo |
| 10,000 work emails | In the plan | $0 per row on MoltSets while the window has room. Misses go to the looot email job, billed per hit |
| 2,000 mobiles | In the plan | About $300 in phone tokens at $0.15 each, or the looot phone job billed per hit |
| Everything else | Loopster's vendor wallet | looot jobs, billed per hit |

looot prices differ by provider and change, so the table shows no looot total. The app quotes the most a run can cost before it starts.

How the contact columns use MoltSets:

- A work email or phone column has a source setting: "MoltSets then looot" (the default once a key is connected), "looot only" or "MoltSets only".
- A MoltSets hit is the answer and looot is never called. A not_found, a used-up window, spent phone tokens or an error sends the row to the looot job. The receipt shows the MoltSets attempt at $0 first, then each looot attempt with its price.
- After MoltSets reports a used-up window, the app stops asking it until the window reopens and sends those rows to looot.
- MoltSets finds a mobile from a LinkedIn URL. Without one, it first looks up the profile by name and company, and uses it only if it is the single match or carries the same name.
- Columns that ask MoltSets first run cell by cell. Columns set to "looot only" with 10 cells or more go to looot in batches of up to 500 rows.

MoltSets people search, company search and personal email are not wired into columns yet.

## Quick start

You need Node.js 22 (`.nvmrc` pins 22.23.4), a Postgres database, a funded looot token and an OpenAI key.

```bash
git clone https://github.com/loootai/looot-tables
cd looot-tables
nvm use
npm ci
cp .env.example .env.local   # set DATABASE_URL, e.g. postgres://localhost:5432/looot_tables
npm run db:migrate
npm run dev
```

Open [localhost:3000/app](http://localhost:3000/app). The setup dialog asks for your looot token and OpenAI key, plus a MoltSets key if you have one. Keys you enter stay in your browser and go only to your own deployment's API routes.

### Try it with no keys

The stand-ins answer like looot, OpenAI and MoltSets with invented data, and no call costs money. You still need the Postgres database from above.

```bash
node scripts/mock-looot.mjs --openai   # looot on :4546, an OpenAI-compatible model on :4545 (it also plays the agent)
node scripts/mock-moltsets.mjs         # MoltSets on :4547

LOOOT_API_URL=http://127.0.0.1:4546 \
MOLTSETS_API_URL=http://127.0.0.1:4547 \
OPENAI_BASE_URL=http://127.0.0.1:4545/v1 \
OPENAI_API_KEY=sk-local \
LOOOT_TABLES_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD=true \
npm run dev
```

Enter any looot token and any key that starts with `ms_`. The looot stand-in starts with a $25 balance and walks fallback routes across several providers. The MoltSets stand-in finds work emails for Maya Rios, Marcus Bell, Yuki Tanaka, Ingrid Larsen and Amara Okafor (grades A, B, C, D and F), returns not_found for other names so the looot fallback runs, and answers any name starting with "Spent" as a used-up window. `scripts/mock-looot.mjs` lists the demo companies and contacts. The app accepts these loopback addresses only outside production, unless `LOOOT_TABLES_ALLOW_LOCAL_BASE_URL=true`.

## How costs and caps work

- **Quote before the run.** The Run button carries the most a run can spend, such as "Run 10 cells · up to $0.12". Runs above $0.50 or 50 cells ask you to confirm.
- **Cap per cell.** Each cell is sent with `fallback.maxCostUsd` set to three times the column's usual price, so a fallback route has room for a few providers and no more.
- **Cap per sheet.** Every sheet starts with a $5.00 cap. The server holds a cell's cap before sending it and refuses any cell that would take the sheet past the cap. You can raise it.
- **Halt after 20 misses.** A column stops after 20 misses or errors in a row. Check its inputs, then resume it.
- **Try 5 rows.** A new column offers "Try 5 rows" before the whole column.
- **Receipt per cell.** Open a cell to see the outcome, each provider attempt with its price and time, and the run id. A miss shows the amount looot charged for it, which is $0 when no provider billed.
- **No double charge.** Each cell attempt keeps one idempotency key for all its retries, so a resend after a timeout gets the run looot already has.

## Self-hosting

Any Postgres works. The app uses Neon's driver for `*.neon.tech` hosts and the normal Postgres driver for everything else. Run `npm run db:migrate` before you start the app; the tables live in the `looot_tables` schema. On Vercel, `vercel.json` runs the migrations before each production build. See the [deployment guide](docs/deploy.md).

Each browser gets a private workspace tied to a cookie. A workspace holds up to 10 sheets of 1,000 rows each, set in [src/lib/workspace.ts](src/lib/workspace.ts). Self-hosted copies have no accounts, so restrict access at your host or network to keep an instance private.

### Environment variables

[.env.example](.env.example) lists every option with comments.

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Required. |
| `DATABASE_DRIVER` | `neon` or `postgres` to force a driver. |
| `LOOOT_TABLES_MCP_ENCRYPTION_SECRET` | 32+ random characters. Encrypts MCP keys and saved provider keys. Keep it identical on every server that shares the database. |
| `LOOOT_TOKEN` | Server-side looot token. Every run is billed to its balance. |
| `OPENAI_API_KEY` | Server-side OpenAI key. |
| `TYPESAFE_API_KEY` | Optional server-side TypeSafe key for true/false and category columns. |
| `MOLTSETS_API_KEY` | Optional server-side MoltSets key. Contact columns try it before looot. |
| `ANTHROPIC_API_KEY` | Optional server-side Anthropic key. The agent runs on Claude with it. |
| `LOOOT_TABLES_PASSWORD` | The server-side keys above are used only when the browser sends this password. |
| `LOOOT_TABLES_ALLOW_SERVER_KEYS_WITHOUT_PASSWORD` | `true` lets anyone with the URL spend the server keys. Off by default. |
| `LOOOT_API_URL` | Reach looot through a proxy or a stand-in instead of `https://api.looot.ai`. |
| `MOLTSETS_API_URL` | Reach MoltSets through a proxy or a stand-in instead of `https://api.moltsets.com`. The MoltSets key goes only to this address. |
| `OPENAI_BASE_URL` | An OpenAI-compatible server, used with the server-side OpenAI key. |
| `LOOOT_TABLES_ALLOW_LOCAL_BASE_URL` | `true` allows a loopback or private base URL in production. |
| `OPENAI_MODEL` | Default model when the browser does not pick one. |
| `NEON_REALTIME_URL`, `NEON_REALTIME_SECRET`, `LOOOT_TABLES_REALTIME_ENABLED` | Live updates through Neon Realtime. Without them the app polls every 30 seconds. See [docs/realtime.md](docs/realtime.md). |
| `NEXT_PUBLIC_SITE_URL` | Public origin for canonical and Open Graph URLs. |
| `LOOOT_TABLES_ALLOW_INDEXING` | `true` lets search engines index the deployment. Off by default. |
| `NEXT_PUBLIC_DATABUDDY_CLIENT_ID` | Optional product analytics. Never sends sheet contents, prompts or keys. |

### MCP server

The app serves a Streamable HTTP MCP endpoint at `/mcp`. Claude Code, Cursor, the OpenAI Responses API, eve and other MCP clients can build, enrich and export your sheets with an agent key from Configuration → Agent access. Setup, the 33 tools and the money rules are in [docs/mcp.md](docs/mcp.md); the in-app agent is in [docs/agent.md](docs/agent.md).

## Development and tests

```bash
npm run lint
npm run typecheck              # generates Next.js route types, then runs tsc
npm test                       # unit and server tests on embedded PGlite, no keys needed
npm run build
npm run test:browser           # Playwright, needs a migrated dev database
npm run test:self-hosted       # starts its own server on port 3107
```

Architecture, migrations and the stand-ins are covered in [docs/development.md](docs/development.md). Column operations and formulas are in [docs/usage.md](docs/usage.md), and the email and phone columns in [docs/email-enrichment.md](docs/email-enrichment.md).

## Contributing

Open an [issue](https://github.com/loootai/looot-tables/issues/new) for bugs and ideas. [CONTRIBUTING.md](CONTRIBUTING.md) explains how issues are handled.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

MIT. Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
