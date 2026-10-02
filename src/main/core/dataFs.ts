// Sandboxed data-root filesystem (PLAN §3 "Writes and renames"). Electron-free: used by the IPC modules and by the tsx
// tests in scripts/. Every renderer path is data-root relative (POSIX) and checked lexically AND by realpath, so a
// junction or symlink inside the data root can never lead outside it.
import { randomBytes } from 'node:crypto';
import { promises as fsp, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { DirEntry, ScanNode } from '../../shared/api';
import { joinRel } from '../../shared/dataPaths';
import { formatJson } from '../../shared/json';

let dataRoot = ''; // absolute, realpath-resolved

/** Creates the dir if needed; returns the realpath used as the sandbox root. */
export async function setDataRoot(dir: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  dataRoot = await fsp.realpath(path.resolve(dir));
  return dataRoot;
}

export const getDataRoot = (): string => dataRoot;

const escapesRoot = (r: string): boolean => r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r);

export const errCode = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? '';

const codedError = (message: string, code: string): Error => Object.assign(new Error(message), { code });

/** Lexical check of a renderer-supplied relative path; returns the absolute path inside the data root. */
export function resolveInside(rel: unknown, { allowRoot = false } = {}): string {
  if (!dataRoot)
    throw new Error('Data root not set');
  if (typeof rel !== 'string')
    throw new TypeError('path must be a string');
  if (rel.includes('\0'))
    throw new Error('NUL byte in path');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\'))
    throw new Error(`Absolute paths are not allowed: ${rel}`);
  const abs = path.resolve(dataRoot, rel);
  const r = path.relative(dataRoot, abs); // win32: case-insensitive
  if (r === '') {
    if (!allowRoot)
      throw new Error('Operation on the data root is not allowed');
    return abs;
  }
  if (escapesRoot(r))
    throw new Error(`Path escapes the data root: ${rel}`);
  return abs;
}

/**
 * Junction / symlink guard: the realpath of `abs` (or, when it does not exist yet, of its nearest existing ancestor
 * plus the missing tail) must stay inside the data root.
 */
export async function assertRealInside(abs: string): Promise<void> {
  let probe = abs;
  let tail = '';
  for (;;) {
    let real: string | null = null;
    try {
      real = await fsp.realpath(probe);
    } catch (e) {
      if (errCode(e) !== 'ENOENT' && errCode(e) !== 'ENOTDIR')
        throw e;
    }
    if (real !== null) {
      if (escapesRoot(path.relative(dataRoot, path.join(real, tail))))
        throw new Error('Resolved path escapes the data root');
      return;
    }
    const parent = path.dirname(probe);
    if (parent === probe)
      return;
    tail = path.join(path.basename(probe), tail);
    probe = parent;
  }
}

/** resolveInside + the realpath guard. */
export async function resolveChecked(rel: unknown, opts?: { allowRoot?: boolean }): Promise<string> {
  const abs = resolveInside(rel, opts);
  await assertRealInside(abs);
  return abs;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Retry transient Windows errors (AV scanners, OneDrive and Explorer previews hold handles): 50, 100, … 800 ms. */
export async function retry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !RETRY_CODES.has(errCode(e)))
        throw e;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
}

/**
 * Atomic write: random-suffix temp file beside the target ("<name>.<hex>.tmp"), fsync, rename over the target.
 * Non-recursive unless createDirs: fails (code ENOENT) when the parent dir is gone, so a late write can never
 * resurrect a deleted or renamed folder.
 */
export async function atomicWrite(abs: string, data: string | Uint8Array, { createDirs = false } = {}): Promise<void> {
  if (createDirs)
    await fsp.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  let fh: FileHandle | null = null;
  try {
    fh = await fsp.open(tmp, 'wx');
  } catch (e) {
    if (errCode(e) === 'ENOENT')
      throw codedError(`Cannot write "${path.basename(abs)}": its folder no longer exists`, 'ENOENT');
    throw e;
  }
  try {
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    await retry(() => fsp.rename(tmp, abs));
  } catch (e) {
    if (fh)
      await fh.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** JSON.parse that tolerates a UTF-8 byte order mark (files edited in Notepad). */
export const parseJsonText = (text: string): unknown => JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// ---------- IPC operations (rel paths) ----------

export async function readJson(rel: string): Promise<unknown> {
  const text = await fsp.readFile(await resolveChecked(rel), 'utf8');
  return parseJsonText(text);
}

/** Resolves the written file's mtimeMs (as scanData reports it), so the caller can tell its own save from an external edit. */
export async function writeJson(rel: string, data: unknown, opts?: { createDirs?: boolean }): Promise<number> {
  if (data === undefined)
    throw new TypeError('writeJson: data is undefined');
  const abs = await resolveChecked(rel);
  await atomicWrite(abs, formatJson(data) + '\n', { createDirs: !!opts?.createDirs });
  return (await fsp.stat(abs)).mtimeMs;
}

export async function readBinary(rel: string): Promise<Uint8Array> {
  return new Uint8Array(await fsp.readFile(await resolveChecked(rel)));
}

export async function writeBinary(rel: string, bytes: Uint8Array, opts?: { createDirs?: boolean }): Promise<void> {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError('bytes must be a Uint8Array');
  await atomicWrite(await resolveChecked(rel), bytes, { createDirs: !!opts?.createDirs });
}

export async function exists(rel: string): Promise<boolean> {
  const abs = await resolveChecked(rel, { allowRoot: true });
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** One dir; the parent must exist (never recursive). An existing dir is fine. */
export async function makeDir(rel: string): Promise<void> {
  const abs = await resolveChecked(rel);
  try {
    await fsp.mkdir(abs);
  } catch (e) {
    if (errCode(e) === 'EEXIST' && (await fsp.stat(abs)).isDirectory())
      return;
    if (errCode(e) === 'ENOENT')
      throw codedError(`Cannot create "${rel}": its parent folder does not exist`, 'ENOENT');
    throw e;
  }
}

/** Same entry on disk (case-only renames on case-insensitive file systems). */
async function sameEntry(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fsp.lstat(a, { bigint: true }), fsp.lstat(b, { bigint: true }).catch(() => null)]);
  if (!sb)
    return false;
  if (sa.ino !== 0n || sb.ino !== 0n)
    return sa.ino === sb.ino && sa.dev === sb.dev;
  return path.dirname(a).toLowerCase() === path.dirname(b).toLowerCase() && path.basename(a).toLowerCase() === path.basename(b).toLowerCase();
}

/**
 * Rename a file or dir. Rejects when the target exists (case-insensitively, unless it is the source itself: a case-only
 * rename) and when the target's parent dir is missing (never creates dirs). Retries EPERM/EBUSY/EACCES with backoff.
 */
export async function renameEntry(fromRel: string, toRel: string): Promise<void> {
  const from = await resolveChecked(fromRel);
  const to = await resolveChecked(toRel);
  if (from === to)
    return;
  await fsp.lstat(from); // ENOENT when the source is gone
  const toDir = path.dirname(to);
  const toName = path.basename(to).toLowerCase();
  let siblings: string[];
  try {
    siblings = await fsp.readdir(toDir);
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR')
      throw codedError(`Cannot rename to "${toRel}": the target folder does not exist`, 'ENOENT');
    throw e;
  }
  for (const name of siblings) {
    if (name.toLowerCase() === toName && !(await sameEntry(from, path.join(toDir, name))))
      throw codedError(`"${toRel}" already exists`, 'EEXIST');
  }
  await retry(() => fsp.rename(from, to));
}

/** Image GC: unlink files (never dirs or links). A missing file counts as deleted. Rejects if any path escapes. */
export async function deleteFiles(rels: unknown): Promise<{ deleted: string[]; failed: string[] }> {
  if (!Array.isArray(rels) || !rels.every((r) => typeof r === 'string'))
    throw new TypeError('deleteFiles: expected an array of paths');
  const targets = (rels as string[]).map((rel) => ({ rel, abs: resolveInside(rel) }));
  const ok = await Promise.all(targets.map(async ({ rel, abs }): Promise<boolean> => {
    try {
      await assertRealInside(abs);
      const st = await fsp.lstat(abs);
      if (!st.isFile())
        return false;
      await retry(() => fsp.unlink(abs));
      return true;
    } catch (e) {
      if (errCode(e) === 'ENOENT')
        return true;
      console.warn(`[fs] deleteFiles: ${rel}: ${(e as Error).message}`);
      return false;
    }
  }));
  return { deleted: targets.filter((_, i) => ok[i]).map((t) => t.rel), failed: targets.filter((_, i) => !ok[i]).map((t) => t.rel) };
}

// ---------- listing and scanning ----------

/** Dot entries (incl. .ptk) and temp files are internal. */
export const isHiddenName = (name: string): boolean => name.startsWith('.') || /\.tmp$/i.test(name);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const compareNames = (a: string, b: string): number => collator.compare(a, b);

/** readdir withFileTypes minus hidden entries; [] when the dir is missing. Links and junctions are neither file nor dir. */
async function readEntries(abs: string): Promise<Dirent[]> {
  try {
    return (await fsp.readdir(abs, { withFileTypes: true })).filter((d) => !isHiddenName(d.name));
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR')
      return [];
    throw e;
  }
}

export async function listDir(rel: string): Promise<DirEntry[]> {
  const entries = await readEntries(await resolveChecked(rel, { allowRoot: true }));
  return entries.filter((d) => d.isFile() || d.isDirectory())
    .map((d): DirEntry => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' }))
    .sort((a, b) => compareNames(a.name, b.name));
}

const JSON_RE = /\.json$/i;

const mtimeOf = async (abs: string): Promise<number | null> => {
  try {
    return (await fsp.stat(abs)).mtimeMs;
  } catch (e) {
    if (errCode(e) === 'ENOENT')
      return null;
    throw e;
  }
};

const byName = (a: ScanNode, b: ScanNode): number => compareNames(a.name, b.name);

async function scanCharacter(charRel: string, name: string, jsonRel: string): Promise<ScanNode | null> {
  const [mtimeMs, entries] = await Promise.all([mtimeOf(path.join(dataRoot, jsonRel)), readEntries(path.join(dataRoot, charRel))]);
  if (mtimeMs === null)
    return null;
  const anims = await Promise.all(entries.filter((d) => d.isFile() && JSON_RE.test(d.name)).map(async (d): Promise<ScanNode | null> => {
    const rel = joinRel(charRel, d.name);
    const m = await mtimeOf(path.join(dataRoot, rel));
    return m === null ? null : { kind: 'animation', name: d.name.slice(0, -5), rel, mtimeMs: m, children: [] };
  }));
  const children = anims.filter((a): a is ScanNode => a !== null).sort(byName);
  return { kind: 'character', name, rel: charRel, mtimeMs, children };
}

/**
 * Characters (dir + sibling json, paired case-insensitively) and broken characters (json without its dir) among the
 * entries of the dir at `rel`; dirs without a json become folders when `folders` (root level only), else are ignored.
 */
async function scanLevel(rel: string, entries: Dirent[], folders: boolean): Promise<ScanNode[]> {
  const jsons = new Map<string, string>();
  for (const d of entries) {
    if (d.isFile() && JSON_RE.test(d.name))
      jsons.set(d.name.slice(0, -5).toLowerCase(), d.name);
  }
  const tasks: Promise<ScanNode | null>[] = [];
  for (const d of entries) {
    if (!d.isDirectory())
      continue;
    const dirRel = joinRel(rel, d.name);
    const json = jsons.get(d.name.toLowerCase());
    if (json !== undefined) {
      jsons.delete(d.name.toLowerCase());
      tasks.push(scanCharacter(dirRel, d.name, joinRel(rel, json)));
    } else if (folders) {
      tasks.push(scanFolder(dirRel, d.name));
    }
  }
  for (const json of jsons.values()) {
    const name = json.slice(0, -5);
    tasks.push(mtimeOf(path.join(dataRoot, rel, json)).then((m): ScanNode | null =>
      m === null ? null : { kind: 'brokenCharacter', name, rel: joinRel(rel, name), mtimeMs: m, children: [] }));
  }
  return (await Promise.all(tasks)).filter((n): n is ScanNode => n !== null);
}

async function scanFolder(rel: string, name: string): Promise<ScanNode> {
  const children = await scanLevel(rel, await readEntries(path.join(dataRoot, rel)), false);
  return { kind: 'folder', name, rel, mtimeMs: null, children: children.sort(byName) };
}

/** Folders (root only), characters (root or in folders), broken characters and animations (*.json in a character dir). */
export async function scanData(): Promise<ScanNode[]> {
  if (!dataRoot)
    throw new Error('Data root not set');
  const nodes = await scanLevel('', await readEntries(dataRoot), true);
  const rank = (n: ScanNode): number => n.kind === 'folder' ? 0 : 1;
  return nodes.sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

// ---------- startup cleanup ----------

/**
 * Delete files whose name matches `re` in `dir` and in its subdirs down to `maxDepth` levels (0 = `dir` only), never
 * following links. Best effort: a missing or unreadable dir is skipped. Returns the count.
 */
export async function removeMatchingFiles(dir: string, re: RegExp, maxDepth: number): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR')
      return 0;
    if (!RETRY_CODES.has(errCode(e)))
      throw e;
    console.warn(`[fs] temp cleanup skipped ${dir}: ${(e as Error).message}`);
    return 0;
  }
  let count = 0;
  for (const d of entries) {
    const abs = path.join(dir, d.name);
    if (d.isFile() && re.test(d.name)) {
      try {
        await retry(() => fsp.unlink(abs));
        count++;
      } catch (e) {
        console.warn(`[fs] could not remove stale temp file ${abs}: ${(e as Error).message}`);
      }
    } else if (maxDepth > 0 && d.isDirectory()) {
      count += await removeMatchingFiles(abs, re, maxDepth - 1);
    }
  }
  return count;
}

/** Temp file names atomicWrite creates: "<name>.<12 hex>.tmp" (never other programs' *.tmp files). */
export const ATOMIC_TMP_RE = /\.[0-9a-f]{12}\.tmp$/i;

/**
 * Data tree depth the temp cleanup walks: root → folder → character dir, and root → .ptk → jobs → <key> (staging).
 * Bounded, so a data root pointed at a large folder never turns startup into a crawl of it.
 */
const TMP_CLEANUP_DEPTH = 3;

/** Startup: stale atomic-write temp files under the data root (characters, animations, .ptk and job staging dirs). */
export const cleanupStaleTmp = (): Promise<number> => removeMatchingFiles(dataRoot, ATOMIC_TMP_RE, TMP_CLEANUP_DEPTH);
