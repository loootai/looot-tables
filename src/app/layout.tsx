import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "looot tables",
  description: "Open-source Clay-style enrichment tables, powered by looot and Supabase",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
