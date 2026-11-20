# looot tables agent on eve

A sales research agent built with [eve](https://eve.dev). Its only tools come from the looot tables MCP server (and, if you turn it on, the looot MCP). Ask it to "find heads of RevOps at 50-500 person SaaS companies, then get their work emails and verify them", and it builds the sheet in your looot tables workspace.

```text
agent/
├── agent.ts                    # the model: Claude Sonnet 5.5, or your OpenAI model
├── instructions.md             # how to work, and the money rules
└── connections/
    ├── looot-tables.ts         # the looot tables MCP server; asks before paid or deleting tools
    └── looot.ts                # optional: the looot MCP, when LOOOT_MCP_URL is set
```

Built-in eve tools are off (`defaultTools: false`). The agent has no shell, files or open web, so it needs no sandbox.

## Money

Spending goes through two gates:

1. The looot tables server refuses `run_column`, `find_rows` and paid `enrich_cells` without a quote id, a budget (`maxUsd`) and an idempotency key. It also holds every cell against its per-cell cap and the sheet's spend cap. See [docs/mcp.md](../../docs/mcp.md).
2. This agent asks you before each of those calls, and before deletes (eve's approval prompt, `approval` in `connections/looot-tables.ts`).

## Run it

You need Node 24 or newer (eve's requirement). looot tables itself runs on Node 22, so this example is a separate package.

1. Start looot tables (see the main README; the stand-ins in `scripts/` work, so nothing is paid). Open Configuration → Agent access and create an agent key.
2. Here:

   ```bash
   cd examples/eve-agent
   cp .env.example .env.local     # fill in LOOOT_TABLES_MCP_KEY, LOOOT_TOKEN and a model key
   npm install
   npx eve dev                    # the terminal chat
   ```

   `eve dev` loads `.env.local`. With the stand-ins, any looot token works.

3. Type: `Find heads of RevOps at 50-500 person SaaS companies, then get their work emails and verify them.` The agent creates the sheet, prices the search and asks you to approve `find_rows`, then adds a Work email column and asks before running 5 rows. Watch the sheet fill in looot tables.

| Variable | What it does |
| --- | --- |
| `LOOOT_TABLES_MCP_URL` | The looot tables MCP endpoint, `http://localhost:3000/mcp` by default. |
| `LOOOT_TABLES_MCP_KEY` | The organization key from Configuration → Agent access (`lt_mcp_…`). |
| `LOOOT_TOKEN` | Your looot token, sent as `x-looot-key`. A self-hosted looot tables needs it from MCP clients. |
| `OPENAI_API_KEY` | Sent as `x-openai-key` for AI columns, and the agent's model when no Anthropic key is set. |
| `OPENAI_MODEL` | The OpenAI model, when the agent runs on OpenAI. |
| `ANTHROPIC_API_KEY` | The agent runs on Claude Sonnet 5.5 with it. |
| `LOOOT_MCP_URL` | Optional. Turns on the looot MCP connection, with `LOOOT_TOKEN` as its bearer token. |

## What was tested

With eve 0.91.0 on Node 24.18: `npm install` (pinned versions, pin-guard clean), `eve info` (compiles with 0 errors), `eve build`, and `eve start` (`/eve/v1/health` answers ready). A conversation with a model was not run for this example, because it would need a paid model key. The same flow is covered end to end by `scripts/mcp-smoke.mjs` (the official MCP client against a running looot tables) and by the in-app agent's eval in `tests/server/agent.test.ts`.

## Deploy

`eve build && eve start` runs it as a Node service. Self-hosted sessions use eve's local Workflow world (files under `.eve/`) unless you configure the Postgres world. See eve's [self-hosting guide](https://eve.dev/docs/guides/deployment/self-hosting). Replace local-only route auth before you expose it.
