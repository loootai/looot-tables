import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "./csv";

async function insertChunks(sb: SupabaseClient, table: string, records: object[], size = 500) {
  for (let i = 0; i < records.length; i += size) {
    const { error } = await sb.from(table).insert(records.slice(i, i + size));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

/** Create a table from CSV text: one input column per header, one row per line. Returns the table id. */
export async function importCsvAsTable(sb: SupabaseClient, name: string, csvText: string): Promise<string> {
  const { headers, rows } = parseCsv(csvText);
  if (headers.length === 0) throw new Error("The CSV has no header row");
  const { data: table, error } = await sb.from("tables").insert({ name }).select("id").single();
  if (error || !table) throw new Error(error?.message ?? "Could not create the table");
  try {
    const columns = headers.map((h, i) => ({ id: crypto.randomUUID(), table_id: table.id, name: h, kind: "input", position: i }));
    await insertChunks(sb, "columns", columns);
    const gridRows = rows.map((_, i) => ({ id: crypto.randomUUID(), table_id: table.id, position: i }));
    await insertChunks(sb, "rows", gridRows);
    const cells = gridRows.flatMap((r, i) =>
      columns.map((c) => ({ row_id: r.id, column_id: c.id, value: rows[i][c.name], status: "done" })),
    );
    await insertChunks(sb, "cells", cells, 1000);
  } catch (e) {
    await sb.from("tables").delete().eq("id", table.id);
    throw e;
  }
  return table.id;
}
