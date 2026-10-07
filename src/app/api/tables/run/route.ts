import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/api";
import { estimateCost } from "@/lib/cost";
import { loootFromEnv } from "@/lib/looot";
import { BATCH_LIMIT, runColumnRows, type CellPatch, type RunTarget } from "@/lib/runner";
import type { CellRow, ColumnRow } from "@/lib/types";

export const maxDuration = 60;

interface RunBody {
  columnId?: string;
  rowIds?: string[];
  /** The most the person agreed to spend on this batch, in USD. */
  maxCostUsd?: number;
  /** Set when the endpoint has no known price and the person agreed anyway. */
  acceptUnknownPrice?: boolean;
}

export async function POST(req: Request) {
  const auth = await requireUser();
  if (auth.response) return auth.response;
  const { sb } = auth;
  const body = (await req.json().catch(() => ({}))) as RunBody;
  const rowIds = Array.isArray(body.rowIds) ? body.rowIds : [];
  if (!body.columnId || rowIds.length === 0) return NextResponse.json({ error: "columnId and rowIds are required" }, { status: 400 });
  if (rowIds.length > BATCH_LIMIT) return NextResponse.json({ error: `At most ${BATCH_LIMIT} rows per request` }, { status: 400 });

  try {
    const { data: column, error: colErr } = await sb.from("columns").select("*").eq("id", body.columnId).single<ColumnRow>();
    if (colErr || !column || column.kind !== "enrichment" || !column.operation_id) {
      return NextResponse.json({ error: "Not an enrichment column" }, { status: 404 });
    }

    const { data: columns } = await sb.from("columns").select("id,name").eq("table_id", column.table_id);
    const { data: cells } = await sb.from("cells").select("*").in("row_id", rowIds).returns<CellRow[]>();
    const nameById = new Map((columns ?? []).map((c) => [c.id as string, c.name as string]));

    const targets: RunTarget[] = rowIds.map((rowId) => {
      const values: Record<string, unknown> = {};
      let existing: RunTarget["existing"];
      for (const cell of (cells ?? []).filter((c) => c.row_id === rowId)) {
        const name = nameById.get(cell.column_id);
        if (name !== undefined) values[name] = cell.value;
        if (cell.column_id === column.id) existing = { status: cell.status, run_id: cell.run_id };
      }
      return { rowId, values, existing };
    });

    // Rows that only re-read an already paid run cost nothing.
    const billable = targets.filter((t) => !(t.existing?.status === "pending" && t.existing.run_id)).length;
    const estimate = estimateCost(column.unit_cost_usd, billable);
    if (estimate === null && !body.acceptUnknownPrice) {
      return NextResponse.json({ error: "This endpoint has no known price. Confirm to run anyway." }, { status: 409 });
    }
    if (estimate !== null && (typeof body.maxCostUsd !== "number" || body.maxCostUsd + 1e-9 < estimate)) {
      return NextResponse.json({ error: "Cost confirmation is missing or lower than the estimate", estimateUsd: estimate }, { status: 409 });
    }

    const looot = loootFromEnv();
    let required: string[] = [];
    const types: Record<string, string | undefined> = {};
    try {
      const info = await looot.inspect(column.operation_id);
      required = info.inputSchema?.required ?? info.usageHints?.requiredInputFields ?? [];
      for (const [name, p] of Object.entries(info.inputSchema?.properties ?? {})) types[name] = p.type;
    } catch {
      // Inspect is a convenience here. Without it the run still goes through, unvalidated.
    }

    const summary = await runColumnRows({
      looot,
      column: { id: column.id, operation_id: column.operation_id, input_map: column.input_map, output_path: column.output_path },
      targets,
      required,
      types,
      store: {
        async setCell(rowId: string, columnId: string, patch: CellPatch) {
          const { error } = await sb.from("cells").upsert({ row_id: rowId, column_id: columnId, ...patch });
          if (error) throw new Error(error.message);
        },
      },
    });
    return NextResponse.json({ summary });
  } catch (e) {
    return errorResponse(e);
  }
}
