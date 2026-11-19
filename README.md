<p align="center">
  <img src=".github/assets/banner.png" alt="looot tables: a spreadsheet that enriches itself from the internet" width="100%" />
</p>

<p align="center">
  <a href="https://looot.ai"><strong>looot</strong></a> ·
  <a href="#self-host">Self-host</a> ·
  <a href="docs/usage.md">Docs</a> ·
  <a href="docs/mcp.md">MCP</a> ·
  <a href="https://github.com/loootai/looot-tables/issues/new">Report an issue</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square" alt="MIT license" /></a>
  <a href="docs/mcp.md"><img src="https://img.shields.io/badge/MCP-server-2563eb?style=flat-square" alt="MCP server" /></a>
</p>

> **looot tables is built on [Enrichable](https://github.com/context-dot-dev/enrichable) by Context.dev** (MIT, imported at commit 640e58e). Every outside lookup here runs on [looot](https://looot.ai) jobs through one looot token. Enrichable's code, tests and docs keep their MIT license and copyright; see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

**looot tables is an open-source AI spreadsheet for data enrichment.** Describe the companies or people you want and it finds them. Then add a column with a plain-English question and it researches every row on the live web: pricing pages, CEOs, tech stacks, work emails, anything public. Every answer keeps its sources.

Every outside lookup (web search, page reads, company and people data, emails, phones) runs as a [looot](https://looot.ai) job on your own looot balance. There is one looot token, no shared token and no included credit: a run is never billed to anyone but you.

## Features

- **Lead lists from a prompt.** "VP of Sales at Series B fintech companies in New York." The agent finds companies, then people at each one. Rows stream in, deduplicated.
- **AI research columns.** "Who is the CEO?" "Does the pricing page offer a free tier?" Each answer links to its sources.
- **Checks, categories and scores.** True/false, category and score columns, each with a probability or confidence.
- **Work emails, checks and phones.** One column asks looot for a work email. looot tries its email providers one after another and stops at the first address. You pick the order (balanced, cheapest or most reliable), not a list of providers. Verify and phone columns work the same way.
- **Any looot endpoint.** Search the looot catalog in plain words, map the endpoint's inputs from your columns with `{{Column}}` templates, and see the estimated cost for the rows you pick before it runs.
- **Provider, cost and attempts per cell.** Open a cell to see which provider answered, the price in USD, how the run ended (hit, weak, miss, error) and every provider a fallback route tried.
- **Emails and documents.** A personalized email draft or branded PDF for every row.
- **Real formulas.** Excel-style functions run locally in the browser, with no API calls.
- **Export.** CSV, Excel or JSON, with or without confidence and sources.
- **MCP server.** Claude Code, Cursor and other MCP clients can read, edit and enrich your sheets.

## How it works

1. **Find rows.** Describe what you want, import a CSV, or start blank.
2. **Add columns.** Ask a question and reference other columns with `{{Website}}`. looot tables picks the operation: web research, a page read, a company or person lookup, an email or phone search, or any looot endpoint you choose.
3. **Review and export.** Open any cell to see its sources, confidence, provider and cost, rerun or edit it, filter what passes, and export.

[looot](https://looot.ai) handles the data (search, scraping, company and people data, emails, phones). OpenAI does the reasoning. [TypeSafe](https://typesafe.ai) makes calibrated true/false and category calls when you connect it.

## Self-host

You need Node.js 22, a Postgres database, a [looot](https://looot.ai) token with a funded balance, and an OpenAI API key.

```bash
git clone https://github.com/loootai/looot-tables
cd looot-tables
nvm use
npm ci
cp .env.example .env.local   # set DATABASE_URL
npm run db:migrate
npm run dev
```

Open [localhost:3000/app](http://localhost:3000/app) and add your keys. `DATABASE_URL` can be a Neon database or any Postgres: the app uses Neon's driver for `*.neon.tech` hosts and the normal Postgres driver for everything else. Set `DATABASE_DRIVER=neon` or `postgres` to force one.

### Deploy to Vercel

Create a Postgres database, add `DATABASE_URL` to the project, and deploy. The build creates the tables. Then open `/app` on your deployment and add your keys. See the [deployment guide](docs/deploy.md).

## API keys

Bring your own keys. Usage is billed to your own accounts. Add them in the app under **Configuration → Connections**.

| Provider | Used for | |
| --- | --- | --- |
| [looot](https://looot.ai) | Web search, page reads, company and people data, emails, phones, any catalog endpoint | Required |
| [OpenAI](https://platform.openai.com/api-keys) | AI columns, Find rows and column setup | Required |
| [TypeSafe](https://typesafe.ai) | Calibrated true/false, category and score columns (falls back to OpenAI) | Optional |

Keys you enter stay in your browser and are only sent to your deployment's API routes. For a private team deployment, set `LOOOT_TOKEN`, `OPENAI_API_KEY` and the rest on the server together with `ENRICHABLE_PASSWORD`. [.env.example](.env.example) lists every option. Set `LOOOT_API_URL` only to reach looot through a proxy.

Every run sends a fresh idempotency key for each cell attempt, so a resend of the same attempt never pays twice.

## Good to know

- **Storage.** Sheets live in your Postgres database, cached in the browser with IndexedDB.
- **Access.** Each browser gets a private workspace tied to a cookie. Self-hosted copies have no accounts, so export sheets to move them between browsers. To keep an instance private, restrict access at your host or network.
- **Limits.** 10 sheets per workspace and 1,000 rows per sheet. Change them in [workspace.ts](src/lib/workspace.ts).
- **Search engines.** Copies are `noindex` unless you set `ENRICHABLE_ALLOW_INDEXING=true`.
- **Analytics.** Off unless you set `NEXT_PUBLIC_DATABUDDY_CLIENT_ID`. It never sends sheet contents, prompts or keys.

## Docs

| Guide | Covers |
| --- | --- |
| [Usage](docs/usage.md) | Column operations, formulas, selection, undo and providers |
| [MCP](docs/mcp.md) | Connecting Claude Code, Cursor or any MCP client |
| [Deploy](docs/deploy.md) | Vercel and Neon setup, existing databases, troubleshooting |
| [Email and phone](docs/email-enrichment.md) | The email, verify and phone columns, and how looot walks its providers |
| [Realtime](docs/realtime.md) | Live collaboration with Neon Realtime |
| [Development](docs/development.md) | Architecture, tests and migrations |

Built with Next.js 16, React 19, TypeScript, Tailwind CSS 4, Postgres, Dexie, IronCalc, the Vercel AI SDK and the Model Context Protocol.

## Contributing

Bug reports and feature ideas are welcome. [Open an issue](https://github.com/loootai/looot-tables/issues/new). See [CONTRIBUTING.md](CONTRIBUTING.md).

Found a vulnerability? Please report it privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Bundled code, fonts and assets are listed in the [third-party notices](THIRD_PARTY_NOTICES.md).

---

<p align="center">
  <sub>looot tables is built on <a href="https://github.com/context-dot-dev/enrichable">Enrichable</a>, made by <a href="https://github.com/YahiaBakour">@YahiaBakour</a> and <a href="https://github.com/nikhilrado">@nikhilrado</a> with the <a href="https://link.context.dev/enrichable/github/context">Context.dev</a> team (MIT).</sub>
</p>
