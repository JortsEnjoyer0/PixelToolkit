// Case-insensitive comparisons of data-root-relative paths (Windows file names compare case-insensitively).

/** Comparison key of a rel. */
export const relKey = (rel: string): string => rel.toLowerCase();

export const sameRel = (a: string, b: string): boolean => relKey(a) === relKey(b);

/** `rel` is `root` or lies below it; the data root ('') contains everything. */
export function isAtOrBelow(rel: string, root: string): boolean {
  if (root === '')
    return true;
  const a = relKey(rel);
  const r = relKey(root);
  return a === r || a.startsWith(r + '/');
}

/** `rel` with its `from` prefix replaced by `to` (unchanged when not at or below `from`). */
export const remapRel = (rel: string, from: string, to: string): string => isAtOrBelow(rel, from) ? to + rel.slice(from.length) : rel;
