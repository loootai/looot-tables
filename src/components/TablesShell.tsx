"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { browserSupabase } from "@/lib/supabase/browser";
import { AppShell, type NavItem } from "./AppShell";

const HEADING = "Your tables";

/** Sidebar frame that lists the signed-in user's tables under the "All tables" link. */
export function TablesShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [tables, setTables] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (path.startsWith("/login")) return;
    let alive = true;
    browserSupabase()
      .from("tables")
      .select("id, name")
      .order("created_at", { ascending: false })
      .limit(15)
      .then(({ data }) => {
        if (alive) setTables((data as { id: string; name: string }[] | null) ?? []);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  const items: NavItem[] = [{ href: "/", label: "All tables", icon: "tables" }, ...tables.map((t) => ({ href: `/tables/${t.id}`, label: t.name || "Untitled", icon: "file" }))];
  const groups = Object.fromEntries(tables.map((t) => [`/tables/${t.id}`, HEADING]));
  return (
    <AppShell items={items} groups={groups} spend={null}>
      {children}
    </AppShell>
  );
}
