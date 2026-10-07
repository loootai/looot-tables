import { getPath } from "./path";
import { applyInputMap, type InputMap, type InputTypes } from "./mapping";
import { TERMINAL_STATUSES, type LoootClient, type LoootRun } from "./looot";

/** Most rows one request runs. The browser sends bigger selections in several requests. */
export const BATCH_LIMIT = 6;

export interface CellPatch {
  status: "empty" | "pending" | "done" | "error";
  value?: unknown;
  cost_usd?: number;
  run_id?: string | null;
  error?: string | null;
}

export interface CellStore {
  setCell(rowId: string, columnId: string, patch: CellPatch): Promise<void>;
}

export interface RunColumn {
  id: string;
  operation_id: string;
  input_map: InputMap | null;
  output_path: string | null;
}

export interface RunTarget {
  rowId: string;
  /** Cell values of the row keyed by column name. */
  values: Record<string, unknown>;
  /** Current cell of the column being run. */
  existing?: { status: string; run_id: string | null; cost_usd?: number | null };
}

export interface RunOptions {
  looot: Pick<LoootClient, "run" | "getRun">;
  store: CellStore;
  column: RunColumn;
  targets: RunTarget[];
  required?: string[];
  types?: InputTypes;
  concurrency?: number;
  waitSeconds?: number;
  maxPolls?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunSummary {
  done: number;
  error: number;
  pending: number;
  costUsd: number;
}

function djb2(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Same column, row and input always give the same key, so a repeat never pays twice. */
export function idempotencyKeyFor(columnId: string, rowId: string, input: unknown, retry: boolean): string {
  const base = `tables-${columnId}-${rowId}-${djb2(JSON.stringify(input))}`;
  return retry ? `${base}-r${Date.now().toString(36)}` : base;
}

function describeFailure(run: LoootRun): string {
  return run.error?.message ?? run.outcomeReason ?? `run ${run.status}`;
}

/** Run one enrichment column over the given rows, writing each cell as it settles. */
export async function runColumnRows(opts: RunOptions): Promise<RunSummary> {
  const { looot, store, column, targets } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPolls = opts.maxPolls ?? 2;
  const pollMs = opts.pollMs ?? 4000;
  const summary: RunSummary = { done: 0, error: 0, pending: 0, costUsd: 0 };

  async function settle(target: RunTarget, run: LoootRun): Promise<void> {
    let current = run;
    for (let i = 0; i < maxPolls && !TERMINAL_STATUSES.includes(current.status); i++) {
      await sleep(pollMs);
      current = await looot.getRun(current.runId);
    }
    if (current.status === "completed") {
      const cost = current.actualCost ?? 0;
      const raw = current.normalized ?? current.result ?? null;
      await store.setCell(target.rowId, column.id, {
        status: "done",
        value: getPath(raw, column.output_path),
        cost_usd: cost,
        run_id: current.runId,
        error: null,
      });
      summary.done++;
      summary.costUsd += cost;
    } else if (TERMINAL_STATUSES.includes(current.status)) {
      const cost = current.actualCost ?? 0;
      await store.setCell(target.rowId, column.id, {
        status: "error",
        cost_usd: cost,
        run_id: current.runId,
        error: describeFailure(current),
      });
      summary.error++;
      summary.costUsd += cost;
    } else {
      // Still queued or running. The run id is kept; running the column again polls it for free.
      await store.setCell(target.rowId, column.id, { status: "pending", run_id: current.runId, error: null });
      summary.pending++;
    }
  }

  async function one(target: RunTarget): Promise<void> {
    try {
      if (target.existing?.status === "pending" && target.existing.run_id) {
        await settle(target, await looot.getRun(target.existing.run_id));
        return;
      }
      const { input, empty } = applyInputMap(column.input_map, target.values, opts.types);
      const missing = (opts.required ?? []).filter((name) => empty.includes(name));
      if (missing.length > 0) {
        await store.setCell(target.rowId, column.id, {
          status: "error",
          cost_usd: 0,
          run_id: null,
          error: `missing input: ${missing.join(", ")}`,
        });
        summary.error++;
        return;
      }
      await store.setCell(target.rowId, column.id, { status: "pending", run_id: null, error: null });
      const key = idempotencyKeyFor(column.id, target.rowId, input, target.existing?.status === "error");
      await settle(target, await looot.run(column.operation_id, input, key, opts.waitSeconds ?? 15));
    } catch (e) {
      await store.setCell(target.rowId, column.id, {
        status: "error",
        cost_usd: 0,
        error: e instanceof Error ? e.message : String(e),
      });
      summary.error++;
    }
  }

  const queue = [...targets];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 3, queue.length) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) await one(t);
  });
  await Promise.all(workers);
  summary.costUsd = Math.round(summary.costUsd * 1e6) / 1e6;
  return summary;
}
