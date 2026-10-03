// Crash-safe image GC: the session sweep (docs/architecture.md "Data root and files"). Every image file main writes
// this session is appended to data/.ptk/session-created.json. The list is swept at startup (before the window opens)
// and after closeReady: a listed file whose uid no json references and no job needs is deleted. Electron-free (tested
// by scripts/test-main-fs.ts).
import { promises as fsp, type Dirent } from 'node:fs';
import {
  PTK_DIR, SESSION_CREATED_REL, baseNameRel, charJsonRel, joinRel, parentRel, parseImageFileName,
  type SessionCreatedEntry, type SessionCreatedList
} from '../../shared/dataPaths';
import { formatJson, isObj } from '../../shared/json';
import { UID_RE } from '../../shared/uid';
import { assertRealInside, atomicWrite, errCode, getDataRoot, isHiddenName, parseJsonText, resolveInside, retry } from './dataFs';

let queue: Promise<unknown> = Promise.resolve();

/** Every read-modify-write of the list runs here, one at a time. */
function serial<T>(op: () => Promise<T>): Promise<T> {
  const run = queue.then(op);
  queue = run.catch(() => undefined);
  return run;
}

const isPtkRel = (rel: string): boolean => rel === PTK_DIR || rel.startsWith(PTK_DIR + '/');

/** The entry for an image file rel; null unless it is a "<owner>.<uid>.png" file inside a dir of the data tree. */
export function sessionEntryFor(rel: string): SessionCreatedEntry | null {
  const dir = parentRel(rel);
  const parsed = parseImageFileName(baseNameRel(rel));
  if (!parsed || dir === '' || isPtkRel(rel))
    return null;
  const ownerRel = parsed.owner === 'base' ? charJsonRel(dir) : joinRel(dir, `${parsed.owner}.json`);
  return { uid: parsed.uid, file: rel, ownerRel };
}

/** A stored entry is trusted only when its file name really carries its uid. */
function validEntry(v: unknown): SessionCreatedEntry | null {
  if (!isObj(v) || typeof v.file !== 'string' || typeof v.ownerRel !== 'string')
    return null;
  const derived = sessionEntryFor(v.file);
  return derived && derived.uid === v.uid ? { uid: derived.uid, file: v.file, ownerRel: v.ownerRel } : null;
}

/**
 * The stored list; [] when it is missing or not valid JSON. Any other read error (a lock that outlasts retry()) rejects,
 * so the callers never rewrite the list from an empty one and lose earlier sessions' entries.
 */
async function readList(): Promise<SessionCreatedEntry[]> {
  let text: string;
  try {
    text = await retry(() => fsp.readFile(resolveInside(SESSION_CREATED_REL), 'utf8'));
  } catch (e) {
    if (errCode(e) === 'ENOENT')
      return [];
    throw e;
  }
  let raw: unknown;
  try {
    raw = parseJsonText(text);
  } catch (e) {
    console.warn(`[session-created] the list is not valid JSON, starting a new one: ${(e as Error).message}`);
    return [];
  }
  const list = isObj(raw) ? raw : {};
  const byFile = new Map<string, SessionCreatedEntry>();
  for (const v of Array.isArray(list.entries) ? list.entries : []) {
    const entry = validEntry(v);
    if (entry)
      byFile.set(entry.file, entry);
  }
  for (const file of Array.isArray(list.files) ? list.files : []) {
    const entry = typeof file === 'string' && !byFile.has(file) ? sessionEntryFor(file) : null;
    if (entry)
      byFile.set(entry.file, entry);
  }
  return [...byFile.values()];
}

async function writeList(entries: SessionCreatedEntry[]): Promise<void> {
  const list: SessionCreatedList = { version: 1, files: entries.map((e) => e.file), entries };
  await atomicWrite(resolveInside(SESSION_CREATED_REL), formatJson(list) + '\n', { createDirs: true });
}

/** Current list (for tests and diagnostics). */
export const listSessionCreated = (): Promise<SessionCreatedEntry[]> => serial(readList);

/** Record image files written this session. Best effort: a failure is logged, never thrown. */
export function noteCreatedImages(rels: string[]): Promise<void> {
  const add = rels.map(sessionEntryFor).filter((e): e is SessionCreatedEntry => e !== null);
  if (add.length === 0)
    return Promise.resolve();
  return serial(async () => {
    const list = await readList();
    const known = new Set(list.map((e) => e.file));
    await writeList([...list, ...add.filter((e) => !known.has(e.file))]);
  }).catch((e) => console.error(`[session-created] append failed: ${(e as Error).message}`));
}

// ---------- sweep ----------

interface References {
  /** Every uid-shaped string in any character / animation json (conservative: ids, frames and sourceBaseUid count too). */
  uids: Set<string>;
  /** Image files in the data tree by uid ("<owner>.<uid>.png", any owner: renamed owners are found too). */
  pngs: Map<string, string[]>;
  /** Lower-cased dir rels next to (or owned by) a json that could not be parsed: nothing there is deleted. */
  unsafe: Set<string>;
}

/** root → folder → character dir is depth 2; one level of slack. */
const MAX_DEPTH = 3;

function collectUids(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') {
    if (UID_RE.test(v))
      out.add(v);
  } else if (Array.isArray(v)) {
    for (const x of v)
      collectUids(x, out);
  } else if (isObj(v)) {
    for (const x of Object.values(v))
      collectUids(x, out);
  }
}

/** Any fs error other than a vanished dir rejects, which aborts the sweep (nothing is deleted). */
async function collectReferences(): Promise<References> {
  const refs: References = { uids: new Set(), pngs: new Map(), unsafe: new Set() };
  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(rel === '' ? getDataRoot() : resolveInside(rel), { withFileTypes: true });
    } catch (e) {
      if (errCode(e) === 'ENOENT' || errCode(e) === 'ENOTDIR')
        return;
      throw e;
    }
    const work: Promise<void>[] = [];
    for (const d of entries) {
      const childRel = joinRel(rel, d.name);
      const img = parseImageFileName(d.name);
      if (isHiddenName(d.name))
        continue;
      if (d.isDirectory() && depth < MAX_DEPTH) {
        work.push(walk(childRel, depth + 1));
      } else if (d.isFile() && img) {
        refs.pngs.set(img.uid, [...(refs.pngs.get(img.uid) ?? []), childRel]);
      } else if (d.isFile() && /\.json$/i.test(d.name)) {
        work.push(fsp.readFile(resolveInside(childRel), 'utf8').then((text) => {
          try {
            collectUids(parseJsonText(text), refs.uids);
          } catch (e) {
            console.warn(`[session-created] ${childRel} is not valid JSON; keeping images beside it: ${(e as Error).message}`);
            refs.unsafe.add(rel.toLowerCase());
            refs.unsafe.add(joinRel(rel, d.name.slice(0, -5)).toLowerCase());
          }
        }));
      }
    }
    await Promise.all(work);
  };
  await walk('', 0);
  return refs;
}

/** Unlink one listed image; true when it is gone. */
async function removeImage(rel: string): Promise<boolean> {
  const abs = resolveInside(rel);
  try {
    await assertRealInside(abs);
    if (!(await fsp.lstat(abs)).isFile())
      return false;
    await retry(() => fsp.unlink(abs));
    return true;
  } catch (e) {
    if (errCode(e) === 'ENOENT')
      return true;
    console.warn(`[session-created] could not delete ${rel}: ${(e as Error).message}`);
    return false;
  }
}

export interface SweepReport { listed: number; deleted: string[]; kept: number }

/**
 * For every listed image: referenced by some json → it is owned now, drop it from the list; needed by a job
 * (`liveUids`: journal frameUids and reference images) → keep it listed; otherwise delete every "<any>.<uid>.png" (the
 * owner may have been renamed) and drop it. Undeletable files and files beside an unparsable json stay listed.
 */
export function sweepSessionCreated(liveUids: Iterable<string>): Promise<SweepReport> {
  const live = new Set(liveUids);
  return serial(async (): Promise<SweepReport> => {
    const list = await readList();
    if (list.length === 0)
      return { listed: 0, deleted: [], kept: 0 };
    const refs = await collectReferences();
    const keep: SessionCreatedEntry[] = [];
    const deleted: string[] = [];
    for (const entry of list) {
      if (refs.uids.has(entry.uid))
        continue;
      const files = [...new Set([entry.file, ...(refs.pngs.get(entry.uid) ?? [])])];
      if (live.has(entry.uid) || files.some((f) => refs.unsafe.has(parentRel(f).toLowerCase()))) {
        keep.push(entry);
        continue;
      }
      let gone = true;
      for (const f of files) {
        const existed = await fsp.access(resolveInside(f)).then(() => true, () => false);
        const removed = await removeImage(f);
        if (removed && existed)
          deleted.push(f);
        gone = gone && removed;
      }
      if (!gone)
        keep.push(entry);
    }
    await writeList(keep);
    return { listed: list.length, deleted, kept: keep.length };
  });
}
