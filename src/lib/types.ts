import type { InputMap } from "./mapping";

export interface TableRow {
  id: string;
  name: string;
  created_at: string;
}

export interface ColumnRow {
  id: string;
  table_id: string;
  name: string;
  kind: "input" | "enrichment";
  operation_id: string | null;
  input_map: InputMap | null;
  output_path: string | null;
  unit_cost_usd: number | null;
  position: number;
}

export interface GridRow {
  id: string;
  table_id: string;
  position: number;
}

export interface CellRow {
  row_id: string;
  column_id: string;
  value: unknown;
  status: "empty" | "pending" | "done" | "error";
  cost_usd: number;
  run_id: string | null;
  error: string | null;
}
