/** Pick a value out of a result with a dot path such as "data.0.email". Empty path returns the whole value. */
export function getPath(value: unknown, path: string | null | undefined): unknown {
  const trimmed = (path ?? "").trim();
  if (!trimmed) return value;
  let current: unknown = value;
  for (const part of trimmed.split(".")) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return null;
  }
  return current;
}
