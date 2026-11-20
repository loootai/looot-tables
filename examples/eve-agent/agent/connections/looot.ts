import { defineDynamic, defineMcpClientConnection } from "eve/connections";

/** Optional: the looot MCP for one-off lookups outside a sheet. Set LOOOT_MCP_URL and LOOOT_TOKEN to turn it on. */
export default defineDynamic(() =>
  process.env.LOOOT_MCP_URL && process.env.LOOOT_TOKEN
    ? defineMcpClientConnection({
        url: process.env.LOOOT_MCP_URL,
        description: "looot: search the data catalog and run one lookup (a work email, a company, a web search). Runs are paid: say the price first.",
        headers: () => ({ Authorization: `Bearer ${process.env.LOOOT_TOKEN}` }),
        approval: ({ toolName }) => (toolName.endsWith("__run") ? "user-approval" : "not-applicable"),
      })
    : null,
);
