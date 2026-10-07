/** Cost of running one column over n rows at a per-call price, rounded to millionths of a dollar. */
export function estimateCost(unitCostUsd: number | null | undefined, rowCount: number): number | null {
  if (unitCostUsd === null || unitCostUsd === undefined || !Number.isFinite(unitCostUsd)) return null;
  return Math.round(unitCostUsd * rowCount * 1e6) / 1e6;
}

/** Read a USD price from a number or a string such as "$0.0064". Null when there is none. */
export function parsePriceUsd(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string") {
    const m = /\d+(?:\.\d+)?/.exec(value);
    return m ? Number(m[0]) : null;
  }
  return null;
}

/** Show a USD amount with enough digits for sub-cent prices. */
export function formatUsd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "price unknown";
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
