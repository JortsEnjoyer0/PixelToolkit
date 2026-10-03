// Entity names (folders, characters, animations) map 1:1 to Windows file names
// (docs/architecture.md "Data root and files"). The name rules are shared with main (@shared/names); this adds the
// sibling checks.
import { MAX_NAME_LENGTH, nameProblem } from '@shared/names';
import { sameRel } from './relPath';

export { MAX_NAME_LENGTH };

/** True when `name` collides (case-insensitively) with a sibling other than `self` (so case-only renames pass). */
export function nameTaken(name: string, siblings: Iterable<string>, self?: string): boolean {
  for (const s of siblings) {
    if (sameRel(s, name) && !(self !== undefined && sameRel(s, self)))
      return true;
  }
  return false;
}

/**
 * User-facing error, or null when valid: nameProblem() (not blank, no \ / : * ? " < > | . or control characters, no
 * leading/trailing spaces, not a reserved device name, not "base", ≤ 64 characters), then (when `siblings` is given)
 * unique among them case-insensitively, excluding `self`.
 */
export function validateName(name: string, opts: { siblings?: Iterable<string>; self?: string } = {}): string | null {
  const problem = nameProblem(name);
  if (problem)
    return problem;
  if (opts.siblings && nameTaken(name, opts.siblings, opts.self))
    return `"${name}" already exists here`;
  return null;
}

/** `base`, then "base 2", "base 3", … until no sibling matches case-insensitively. */
export function uniqueName(base: string, existing: Iterable<string>): string {
  const taken = [...existing];
  if (!nameTaken(base, taken))
    return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!nameTaken(candidate, taken))
      return candidate;
  }
}

/**
 * Entity names a directory listing already occupies: sub-dir names and "*.json" basenames (a folder or character dir
 * and a character or animation json all claim their name). Feed to uniqueName() / validateName() for new entities, so
 * a dir the scan hides (e.g. a plain dir inside a folder) still counts.
 */
export function entityNamesInListing(entries: Iterable<{ name: string; kind: 'file' | 'dir' }>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind === 'dir')
      out.push(e.name);
    else if (/\.json$/i.test(e.name))
      out.push(e.name.slice(0, -5));
  }
  return out;
}
