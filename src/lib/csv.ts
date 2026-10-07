import Papa from "papaparse";

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Make header names non-empty and unique: blanks become "Column N", repeats get " 2", " 3". */
export function cleanHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  });
}

/** Parse CSV text with a header row. Rows with no values at all are dropped. */
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  const [head, ...body] = result.data;
  if (!head) return { headers: [], rows: [] };
  const headers = cleanHeaders(head);
  const rows = body.map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
  return { headers, rows };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Stop spreadsheet formula injection when the file is opened in Excel or Sheets.
  return /^[=+@]/.test(text) || /^-(?!\d)/.test(text) ? `'${text}` : text;
}

/** Write CSV text, one line per row, columns in the order given. */
export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const data = rows.map((row) => headers.map((h) => cellText(row[h])));
  return Papa.unparse({ fields: headers, data }, { newline: "\n" });
}
