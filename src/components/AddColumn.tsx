"use client";

import { useState } from "react";
import { formatUsd } from "@/lib/cost";
import { suggestInputMap } from "@/lib/autoMap";

interface Hit { endpointId: string; provider: string | null; name: string; category: string | null; priceUsd: number | null }
interface Inspected { endpointId: string; priceUsd: number | null; inputs: { name: string; type: string; description: string; required: boolean }[] }

export interface NewEnrichment {
  name: string;
  operationId: string;
  inputMap: Record<string, string>;
  outputPath: string;
  unitCostUsd: number | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

/** Pick a looot operation, see its inputs and price, and map the inputs to table columns. */
export function AddColumn({ columnNames, onCreate, onCancel }: {
  columnNames: string[];
  onCreate: (c: NewEnrichment) => Promise<void>;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [info, setInfo] = useState<Inspected | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      setHits((await getJson<{ results: Hit[] }>(`/api/looot/search?q=${encodeURIComponent(q)}`)).results);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    setBusy(false);
  }

  async function pick(hit: Hit) {
    setPicked(hit);
    setInfo(null);
    setError("");
    try {
      const detail = await getJson<Inspected>(`/api/looot/inspect?id=${encodeURIComponent(hit.endpointId)}`);
      setInfo(detail);
      setMap(suggestInputMap(detail.inputs.map((i) => i.name), columnNames));
      setName((n) => n || hit.name);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  const price = info?.priceUsd ?? picked?.priceUsd ?? null;

  async function create() {
    if (!picked || !info) return;
    setBusy(true);
    try {
      const inputMap = Object.fromEntries(Object.entries(map).filter(([, v]) => v.trim() !== ""));
      await onCreate({ name: name.trim() || picked.name, operationId: picked.endpointId, inputMap, outputPath: outputPath.trim(), unitCostUsd: price });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  }

  return (
    <div className="card">
      <form className="row" onSubmit={search}>
        <input type="text" style={{ flex: 1, minWidth: 220 }} placeholder="What do you want to find? e.g. work email from name and company" value={q} onChange={(e) => setQ(e.target.value)} />
        <button disabled={busy || !q.trim()}>Search looot</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </form>
      {error && <p className="err">{error}</p>}
      <div style={{ marginTop: 12, maxHeight: 220, overflow: "auto" }}>
        {hits.map((h) => (
          <button key={h.endpointId} className={`hit ${picked?.endpointId === h.endpointId ? "sel" : ""}`} onClick={() => pick(h)}>
            {h.name} <span className="muted">{h.provider} {h.endpointId} {formatUsd(h.priceUsd)} per call</span>
          </button>
        ))}
      </div>
      {picked && info && (
        <div style={{ marginTop: 12 }}>
          <p><strong>{picked.endpointId}</strong> <span className="muted">{formatUsd(price)} per row</span></p>
          <div className="field"><label>Column name</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
          {info.inputs.map((i) => (
            <div className="field" key={i.name}>
              <label title={i.description}>{i.name}{i.required ? " *" : ""} <span className="tag">{i.type}</span></label>
              <div className="row">
                <input type="text" style={{ flex: 1 }} placeholder="{{Column name}} or fixed text" value={map[i.name] ?? ""} onChange={(e) => setMap({ ...map, [i.name]: e.target.value })} />
                <select value="" onChange={(e) => e.target.value && setMap({ ...map, [i.name]: `${map[i.name] ?? ""}{{${e.target.value}}}` })}>
                  <option value="">Insert column</option>
                  {columnNames.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
          ))}
          <div className="field"><label>Result field <span className="tag">optional, e.g. email or data.0.email</span></label><input type="text" value={outputPath} onChange={(e) => setOutputPath(e.target.value)} /></div>
          <button className="primary" disabled={busy} onClick={create}>Add column</button>
        </div>
      )}
    </div>
  );
}
