"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { browserSupabase } from "@/lib/supabase/browser";
import { importCsvAsTable } from "@/lib/importCsv";
import { useRequireSession } from "@/lib/useSession";
import type { TableRow } from "@/lib/types";

export default function HomePage() {
  useRequireSession();
  const router = useRouter();
  const [tables, setTables] = useState<TableRow[]>([]);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data } = await browserSupabase().from("tables").select("*").order("created_at", { ascending: false });
    setTables((data as TableRow[]) ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const sb = browserSupabase();
      const tableName = name.trim() || file?.name.replace(/\.csv$/i, "") || "Untitled";
      if (file) {
        router.push(`/tables/${await importCsvAsTable(sb, tableName, await file.text())}`);
      } else {
        const { data, error: err } = await sb.from("tables").insert({ name: tableName }).select("id").single();
        if (err || !data) throw new Error(err?.message ?? "Could not create the table");
        router.push(`/tables/${data.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function signOut() {
    await browserSupabase().auth.signOut();
    router.push("/login");
  }

  return (
    <>
      <header className="bar">
        <h1>looot tables</h1>
        <button onClick={signOut}>Sign out</button>
      </header>
      <form className="card" onSubmit={create}>
        <div className="row">
          <input type="text" placeholder="Table name" value={name} onChange={(e) => setName(e.target.value)} />
          <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="primary" disabled={busy}>{file ? "Import CSV" : "Create empty table"}</button>
        </div>
        <p className="muted">A CSV import makes one input column per header. Add enrichment columns once the table is open.</p>
        {error && <p className="err">{error}</p>}
      </form>
      <div className="card list" style={{ padding: 0 }}>
        {tables.length === 0 && <p className="muted" style={{ padding: 16 }}>No tables yet.</p>}
        {tables.map((t) => (
          <Link key={t.id} href={`/tables/${t.id}`}>{t.name} <span className="muted">{new Date(t.created_at).toLocaleDateString()}</span></Link>
        ))}
      </div>
    </>
  );
}
