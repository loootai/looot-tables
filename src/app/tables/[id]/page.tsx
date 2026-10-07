"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { AddColumn, type NewEnrichment } from "@/components/AddColumn";
import { estimateCost, formatUsd } from "@/lib/cost";
import { toCsv } from "@/lib/csv";
import { fetchAll } from "@/lib/fetchAll";
import { BATCH_LIMIT } from "@/lib/runner";
import { browserSupabase } from "@/lib/supabase/browser";
import type { CellRow, ColumnRow, GridRow } from "@/lib/types";
import { useRequireSession } from "@/lib/useSession";

const key = (rowId: string, colId: string) => `${rowId}:${colId}`;
const show = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export default function TablePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  useRequireSession();
  const sb = useMemo(() => browserSupabase(), []);
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<ColumnRow[]>([]);
  const [rows, setRows] = useState<GridRow[]>([]);
  const [cells, setCells] = useState<Map<string, CellRow>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [busyColumn, setBusyColumn] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const { data: t } = await sb.from("tables").select("name").eq("id", id).single();
    setName(t?.name ?? "");
    const cols = (await fetchAll<ColumnRow>((a, b) => sb.from("columns").select("*").eq("table_id", id).order("position").range(a, b)));
    const rws = await fetchAll<GridRow>((a, b) => sb.from("rows").select("*").eq("table_id", id).order("position").range(a, b));
    const cls = cols.length === 0 ? [] : await fetchAll<CellRow>((a, b) =>
      sb.from("cells").select("*").in("column_id", cols.map((c) => c.id)).order("row_id").order("column_id").range(a, b));
    setColumns(cols);
    setRows(rws);
    setCells(new Map(cls.map((c) => [key(c.row_id, c.column_id), c])));
  }, [sb, id]);
  useEffect(() => { void load().catch((e) => setMessage(String(e))); }, [load]);

  const totalSpent = useMemo(() => [...cells.values()].reduce((sum, c) => sum + Number(c.cost_usd || 0), 0), [cells]);

  async function addInputColumn() {
    const colName = window.prompt("Column name");
    if (!colName?.trim()) return;
    const { error } = await sb.from("columns").insert({ table_id: id, name: colName.trim(), kind: "input", position: columns.length });
    setMessage(error ? error.message : "");
    await load();
  }

  async function addRow() {
    const { data, error } = await sb.from("rows").insert({ table_id: id, position: rows.length }).select("id").single();
    if (error || !data) return setMessage(error?.message ?? "Could not add row");
    const inputs = columns.filter((c) => c.kind === "input");
    if (inputs.length) await sb.from("cells").insert(inputs.map((c) => ({ row_id: data.id, column_id: c.id, value: "", status: "done" })));
    await load();
  }

  async function editCell(row: GridRow, col: ColumnRow) {
    if (col.kind !== "input") return;
    const current = cells.get(key(row.id, col.id))?.value;
    const next = window.prompt(col.name, show(current));
    if (next === null) return;
    const { error } = await sb.from("cells").upsert({ row_id: row.id, column_id: col.id, value: next, status: "done" });
    setMessage(error?.message ?? "");
    await load();
  }

  async function createEnrichment(c: NewEnrichment) {
    const { error } = await sb.from("columns").insert({
      table_id: id, name: c.name, kind: "enrichment", operation_id: c.operationId, input_map: c.inputMap,
      output_path: c.outputPath || null, unit_cost_usd: c.unitCostUsd, position: columns.length,
    });
    if (error) throw new Error(error.message);
    setAdding(false);
    await load();
  }

  async function runColumn(col: ColumnRow) {
    const todo = rows.filter((r) => selected.has(r.id) && cells.get(key(r.id, col.id))?.status !== "done");
    if (todo.length === 0) return setMessage("Select the rows to run first. Rows that are already done are skipped.");
    const rereads = todo.filter((r) => cells.get(key(r.id, col.id))?.status === "pending" && cells.get(key(r.id, col.id))?.run_id).length;
    const estimate = estimateCost(col.unit_cost_usd, todo.length - rereads);
    const priceLine = estimate === null
      ? "This endpoint has no known price."
      : `Estimated cost: up to ${formatUsd(estimate)} (${formatUsd(col.unit_cost_usd)} per row). Your looot balance is charged only for calls that run.`;
    if (!window.confirm(`Run "${col.name}" on ${todo.length} row${todo.length === 1 ? "" : "s"}?\n\n${priceLine}`)) return;

    setBusyColumn(col.id);
    setMessage("");
    try {
      for (let i = 0; i < todo.length; i += BATCH_LIMIT) {
        const batch = todo.slice(i, i + BATCH_LIMIT);
        const batchRereads = batch.filter((r) => cells.get(key(r.id, col.id))?.status === "pending" && cells.get(key(r.id, col.id))?.run_id).length;
        const res = await fetch("/api/tables/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            columnId: col.id,
            rowIds: batch.map((r) => r.id),
            maxCostUsd: estimateCost(col.unit_cost_usd, batch.length - batchRereads) ?? 0,
            acceptUnknownPrice: col.unit_cost_usd === null,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        await load();
        setMessage(`Ran ${Math.min(i + BATCH_LIMIT, todo.length)} of ${todo.length} rows`);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
    setBusyColumn(null);
  }

  function exportCsv() {
    const data = rows.map((r) => Object.fromEntries(columns.map((c) => [c.name, cells.get(key(r.id, c.id))?.value ?? ""])));
    const blob = new Blob([toCsv(columns.map((c) => c.name), data)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name || "table"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const toggle = (rowId: string) => setSelected((s) => { const n = new Set(s); if (n.has(rowId)) n.delete(rowId); else n.add(rowId); return n; });
  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <>
      <header className="bar">
        <div><Link href="/">All tables</Link><h1>{name}</h1></div>
        <div className="row">
          <span className="muted">{rows.length} rows, {selected.size} selected, spent {formatUsd(totalSpent)}</span>
          <button onClick={addInputColumn}>Add input column</button>
          <button onClick={addRow}>Add row</button>
          <button className="primary" onClick={() => setAdding(true)}>Add enrichment column</button>
          <button onClick={exportCsv}>Export CSV</button>
        </div>
      </header>
      {message && <p className={/^Ran /.test(message) ? "muted" : "err"}>{message}</p>}
      {adding && <AddColumn columnNames={columns.map((c) => c.name)} onCreate={createEnrichment} onCancel={() => setAdding(false)} />}
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th><input type="checkbox" aria-label="Select all rows" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
              {columns.map((c) => (
                <th key={c.id}>
                  {c.name}
                  <span className="tag">{c.kind === "input" ? "input" : c.operation_id}</span>
                  {c.kind === "enrichment" && (
                    <button disabled={busyColumn !== null} onClick={() => runColumn(c)}>{busyColumn === c.id ? "Running" : "Run column"}</button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" aria-label="Select row" checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                {columns.map((c) => {
                  const cell = cells.get(key(r.id, c.id));
                  const status = c.kind === "input" ? "" : cell?.status ?? "empty";
                  const text = status === "error" ? cell?.error ?? "error" : status === "pending" ? "pending" : show(cell?.value);
                  return (
                    <td key={c.id} className={status} title={text} onDoubleClick={() => editCell(r, c)}>
                      {text}{status === "done" && Number(cell?.cost_usd) > 0 && <span className="tag">{formatUsd(Number(cell?.cost_usd))}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Double-click an input cell to edit it. A pending cell finished too slowly for one request, so run the column again to read it for free.</p>
    </>
  );
}
