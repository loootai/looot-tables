import { describe, expect, it } from "vitest";
import { estimateCost, formatUsd, parsePriceUsd } from "./cost";

describe("cost", () => {
  it("multiplies the unit price by the row count without float noise", () => {
    expect(estimateCost(0.0064, 3)).toBe(0.0192);
    expect(estimateCost(0.1, 3)).toBe(0.3);
    expect(estimateCost(0.05, 0)).toBe(0);
  });
  it("returns null when the price is unknown", () => {
    expect(estimateCost(null, 5)).toBeNull();
    expect(estimateCost(undefined, 5)).toBeNull();
  });
  it("reads prices from numbers and strings", () => {
    expect(parsePriceUsd(0.02)).toBe(0.02);
    expect(parsePriceUsd("$0.0064")).toBe(0.0064);
    expect(parsePriceUsd("free")).toBeNull();
    expect(parsePriceUsd(null)).toBeNull();
  });
  it("formats sub-cent prices with four digits", () => {
    expect(formatUsd(0.0064)).toBe("$0.0064");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(null)).toBe("price unknown");
  });
});
