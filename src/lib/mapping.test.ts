import { describe, expect, it } from "vitest";
import { applyInputMap, coerceValue, placeholdersIn } from "./mapping";
import { suggestInputMap } from "./autoMap";
import { getPath } from "./path";

describe("applyInputMap", () => {
  const row = { "First name": "Ada", "Last name": "Lovelace", Company: "Analytical Engines", Empty: "", Employees: "42" };

  it("passes a whole placeholder through as the raw value", () => {
    expect(applyInputMap({ company: "{{Company}}" }, row).input).toEqual({ company: "Analytical Engines" });
  });
  it("joins several placeholders and literal text", () => {
    expect(applyInputMap({ full_name: "{{First name}} {{Last name}}", source: "csv" }, row).input).toEqual({
      full_name: "Ada Lovelace",
      source: "csv",
    });
  });
  it("leaves out inputs whose columns are empty or missing and lists them", () => {
    const { input, empty } = applyInputMap({ a: "{{Empty}}", b: "{{Nope}}", c: "x {{Empty}}", d: "{{Company}}" }, row);
    expect(input).toEqual({ d: "Analytical Engines" });
    expect(empty).toEqual(["a", "b", "c"]);
  });
  it("coerces numbers and booleans from the declared input types", () => {
    const { input } = applyInputMap({ size: "{{Employees}}", flag: "true" }, row, { size: "integer", flag: "boolean" });
    expect(input).toEqual({ size: 42, flag: true });
  });
  it("returns nothing for a missing map", () => {
    expect(applyInputMap(null, row)).toEqual({ input: {}, empty: [] });
  });
  it("lists placeholders once", () => {
    expect(placeholdersIn("{{A}} {{ B }} {{A}}")).toEqual(["A", "B"]);
  });
  it("keeps non-numeric text as is when a number is declared", () => {
    expect(coerceValue("abc", "number")).toBe("abc");
  });
});

describe("suggestInputMap", () => {
  it("matches input names to columns ignoring case and punctuation", () => {
    expect(suggestInputMap(["company_domain", "linkedin_url"], ["Company Domain", "Name"])).toEqual({
      company_domain: "{{Company Domain}}",
      linkedin_url: "",
    });
  });
});

describe("getPath", () => {
  it("walks objects and arrays and returns null for a miss", () => {
    const v = { data: [{ email: "a@example.com" }] };
    expect(getPath(v, "data.0.email")).toBe("a@example.com");
    expect(getPath(v, "data.1.email")).toBeNull();
    expect(getPath(v, "")).toBe(v);
  });
});
