const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Suggest {{Column}} for every operation input whose name matches a column name, ignoring case and punctuation. */
export function suggestInputMap(inputNames: string[], columnNames: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const input of inputNames) {
    const match = columnNames.find((c) => norm(c) === norm(input));
    map[input] = match ? `{{${match}}}` : "";
  }
  return map;
}
