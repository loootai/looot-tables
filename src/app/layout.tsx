import type { Metadata } from "next";
import "./globals.css";
import { TablesShell } from "@/components/TablesShell";

export const metadata: Metadata = {
  title: "looot tables",
  description: "Open-source Clay-style enrichment tables, powered by looot and Supabase",
  icons: { icon: "/brand/looot-mark.svg" },
};

/** Applies the saved theme before first paint, so a dark choice does not flash light. */
const THEME_SCRIPT = `try{var t=localStorage.getItem("looot-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else if(matchMedia("(prefers-color-scheme: dark)").matches)document.documentElement.dataset.theme="dark"}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <TablesShell>{children}</TablesShell>
      </body>
    </html>
  );
}
