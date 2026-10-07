export type InputMap = Record<string, string>;
export type InputTypes = Record<string, string | undefined>;

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function asText(value: unknown): string {
  if (isEmpty(value)) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Convert a mapped value to the JSON type the operation declares for that input. */
export function coerceValue(value: unknown, type: string | undefined): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (type === "number" || type === "integer") {
    const n = Number(text);
    return text !== "" && Number.isFinite(n) ? n : value;
  }
  if (type === "boolean") {
    if (/^(true|yes|1)$/i.test(text)) return true;
    if (/^(false|no|0)$/i.test(text)) return false;
  }
  return value;
}

/** Column names a template refers to, in order, without repeats. */
export function placeholdersIn(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Build the operation input for one row. Each map value is a template such as
 * "{{Company website}}" or "https://{{Domain}}/about". A template that is exactly one
 * placeholder passes the raw cell value through. Inputs whose columns are all empty are
 * left out and listed in `empty`.
 */
export function applyInputMap(
  map: InputMap | null | undefined,
  rowValues: Record<string, unknown>,
  types: InputTypes = {},
): { input: Record<string, unknown>; empty: string[] } {
  const input: Record<string, unknown> = {};
  const empty: string[] = [];
  for (const [name, template] of Object.entries(map ?? {})) {
    const whole = WHOLE_PLACEHOLDER.exec(template);
    let value: unknown;
    if (whole) {
      value = rowValues[whole[1]];
    } else if (placeholdersIn(template).length === 0) {
      value = template;
    } else {
      const refs = placeholdersIn(template);
      value = refs.every((ref) => isEmpty(rowValues[ref]))
        ? undefined
        : template.replace(PLACEHOLDER, (_all, ref: string) => asText(rowValues[ref]));
    }
    if (isEmpty(value)) {
      empty.push(name);
    } else {
      input[name] = coerceValue(value, types[name]);
    }
  }
  return { input, empty };
}
