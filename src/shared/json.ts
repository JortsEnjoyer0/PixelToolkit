// JSON text format for every file the app writes (docs/architecture.md "Data root and files"): 2-space pretty print,
// numeric arrays on one line.
// Also the small guards every reader of untrusted JSON (files, IPC, PixelLab answers) needs.

/** A parsed JSON object. */
export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export const finiteOrNull = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export const posInt = (v: unknown): number | null => typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

/** Deep copy of JSON data (drops undefined members and functions, like a JSON round trip). */
export const plainCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function fmt(value: unknown, indent: string): string {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function')
    return fmt((value as { toJSON(): unknown }).toJSON(), indent);
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0)
      return '[]';
    if (value.every((v) => typeof v === 'number'))
      return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    return `[\n${value.map((v) => inner + fmt(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol');
  if (entries.length === 0)
    return '{}';
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${fmt(v, inner)}`).join(',\n')}\n${indent}}`;
}

/** Same data model as JSON.stringify (undefined members dropped, NaN → null); no trailing newline. */
export function formatJson(value: unknown): string {
  return fmt(value, '');
}
