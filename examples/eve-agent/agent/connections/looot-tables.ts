import { defineMcpClientConnection } from "eve/connections";

/** Tools that spend looot credit or delete data. eve pauses for a person before each call. */
const ASK_FIRST = ["run_column", "find_rows", "enrich_cells", "delete_sheet", "delete_rows", "update_spend_guard"];

export default defineMcpClientConnection({
  url: process.env.LOOOT_TABLES_MCP_URL ?? "http://localhost:3000/mcp",
  description: "looot tables: lead-list spreadsheets. Create sheets, find people and companies, add columns that find and verify emails or research each row, quote and run them, read results and receipts.",
  // The organization key, plus the provider keys a self-hosted looot tables expects from MCP clients.
  headers: () => ({
    Authorization: `Bearer ${process.env.LOOOT_TABLES_MCP_KEY ?? ""}`,
    ...(process.env.LOOOT_TOKEN ? { "x-looot-key": process.env.LOOOT_TOKEN } : {}),
    ...(process.env.OPENAI_API_KEY ? { "x-openai-key": process.env.OPENAI_API_KEY } : {}),
  }),
  approval: ({ toolName }) => (ASK_FIRST.some((name) => toolName.endsWith(`__${name}`)) ? "user-approval" : "not-applicable"),
});
