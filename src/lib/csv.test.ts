import { describe, expect, it } from "vitest";
import { cleanHeaders, parseCsv, toCsv } from "./csv";

describe("csv", () => {
  it("parses quoted fields, a BOM, and drops blank lines", () => {
    const { headers, rows } = parseCsv('﻿Name,Note\n"Lovelace, Ada","said ""hi"""\n\n,\nBob,\n');
    expect(headers).toEqual(["Name", "Note"]);
    expect(rows).toEqual([
      { Name: "Lovelace, Ada", Note: 'said "hi"' },
      { Name: "Bob", Note: "" },
    ]);
  });
  it("fixes blank and repeated headers", () => {
    expect(cleanHeaders(["a", "", "a"])).toEqual(["a", "Column 2", "a 2"]);
  });
  it("pads short rows", () => {
    expect(parseCsv("a,b\n1\n").rows).toEqual([{ a: "1", b: "" }]);
  });
  it("round-trips through export", () => {
    const csv = toCsv(["Name", "Note"], [{ Name: "Lovelace, Ada", Note: 'said "hi"' }]);
    expect(parseCsv(csv).rows).toEqual([{ Name: "Lovelace, Ada", Note: 'said "hi"' }]);
  });
  it("writes objects as JSON and guards formula cells", () => {
    const csv = toCsv(["v"], [{ v: { a: 1 } }, { v: "=SUM(A1)" }, { v: "-5" }, { v: null }]);
    expect(csv.split("\n")).toEqual(["v", '"{""a"":1}"', "'=SUM(A1)", "-5", ""]);
  });
  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });
});
