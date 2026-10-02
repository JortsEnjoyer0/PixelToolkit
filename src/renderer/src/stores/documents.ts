// Documents store (DocumentsStoreApi, PLAN §5): open DocHandles, the character cache and every IO-aware entity
// operation: load, save (Ctrl+S, autosave, close prompts), animation renames, explorer exclusivity (runExclusive),
// image GC, rescan reconciliation and the app-close prompt. Each doc has one serial IO queue; ops read the doc's
// paths when they run, never when they are queued. Handles are markRaw'd in a shallowReactive Map.
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, shallowReactive, watch } from 'vue';
import type { ScanNode } from '@shared/api';
import {
  animImageFileName, animJsonRel, animNameFromRel, charJsonRel, charNameFromRel, charRelFromAnimRel, joinRel,
  parentRel, parseImageFileName
} from '@shared/dataPaths';
import { FINAL_JOB_STATUSES, type JobUpdateEvent } from '@shared/jobs';
import { isObj } from '@shared/json';
import { uid } from '@shared/uid';
import {
  formatJson, parseAnimation, parseCharacter, serializeAnimation, serializeCharacter, type AnimationMeta, type CharacterMeta
} from '../core/model';
import { metaFromState, referencedImages, stateFromMeta } from '../core/docState';
import { validateName } from '../core/util/naming';
import { isAtOrBelow, relKey, sameRel } from '../core/util/relPath';
import { dialogs } from '../services/dialogs';
import { cancelEditorInteraction, whenEditorIdle } from '../services/editorState';
import { errorMessage, reportError } from '../services/errors';
import { lifecycle } from '../services/lifecycle';
import { mouseNotify } from '../services/mouseNotify';
import { blurTextField } from '../services/shortcuts';
import { useSettingsStore } from './settings';
import { useWorkspaceStore } from './workspace';
import type { DocHandle, DocumentsStoreApi } from './types';
import { deps } from './doc/deps';
import { collectGarbage, jobImages, type GcKeep } from './doc/gc';
import { createDocHandle, freezeState, type DocInternal } from './doc/handle';
import { IoQueue } from './doc/ioQueue';

/** Eviction GC runs this long after the last eviction (slider merges evict on every tick). */
export const GC_DELAY_MS = 300;

const isUnfinished = (r: JobUpdateEvent): boolean => !FINAL_JOB_STATUSES.includes(r.status);

/** A queued op found its doc deleted by an explorer operation or closed (not reported: the user did that). */
class DeletedError extends Error {}

/** A parsed animation as the json a save would write (with `id`): compare two parses for equal content. */
const comparableJson = (meta: AnimationMeta, id: string): string => formatJson(serializeAnimation({ ...meta, id }));

export const useDocumentsStore = defineStore('documents', () => {
  const settings = useSettingsStore();
  const docs = shallowReactive(new Map<string, DocInternal>());
  const characters = shallowReactive(new Map<string, CharacterMeta>());
  const ioCount = ref(0);
  const ioBusy = computed(() => ioCount.value > 0);
  const onIoCount = (delta: number): void => {
    ioCount.value += delta;
  };

  /** In-flight loads by lowercase rel. */
  const loading = new Map<string, Promise<DocInternal>>();
  /** Docs whose unload is still draining, by docId. */
  const unloading = new Map<string, { rel: string; done: Promise<void> }>();
  /** Running runExclusive() operations. */
  const exclusive = new Set<{ rel: string; done: Promise<unknown> }>();
  /** Running loads and closed-animation renames (runExclusive waits for the ones that started before it). */
  const closedOps = new Set<{ rel: string; done: Promise<unknown> }>();
  /** Serial queues for closed animations (load, rename) by lowercase json rel, and for character jsons by lowercase charRel. */
  const relQueues = new Map<string, IoQueue>();
  const charQueues = new Map<string, IoQueue>();
  /** Character json mtimes from the last reconcile, by lowercase charRel. */
  const charMtimes = new Map<string, number>();
  const gcTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const jobRecords = (): readonly JobUpdateEvent[] => deps.jobs().records;

  function queueFor(map: Map<string, IoQueue>, key: string): IoQueue {
    const k = relKey(key);
    let q = map.get(k);
    if (!q) {
      q = new IoQueue(onIoCount);
      map.set(k, q);
    }
    return q;
  }

  /** Serial op on a closed animation's rel (load vs rename); the queue entry is dropped when idle. */
  function withRelLock<T>(rel: string, op: () => Promise<T>): Promise<T> {
    const q = queueFor(relQueues, rel);
    return q.run(op).finally(() => {
      if (q.pending === 0 && relQueues.get(relKey(rel)) === q)
        relQueues.delete(relKey(rel));
    });
  }

  function get(docId: string): DocHandle | undefined {
    return docs.get(docId);
  }

  function findOpen(rel: string): DocInternal | undefined {
    for (const d of docs.values()) {
      if (sameRel(d.rel.value, rel))
        return d;
    }
    return undefined;
  }

  function findByRel(rel: string): DocHandle | undefined {
    return findOpen(rel);
  }

  /** Register a load / closed rename on `rel` until it settles. */
  function trackClosed<T>(rel: string, p: Promise<T>): Promise<T> {
    const entry = { rel, done: p };
    closedOps.add(entry);
    const drop = (): void => {
      closedOps.delete(entry);
    };
    p.then(drop, drop);
    return p;
  }

  /**
   * Wait for the explorer operations covering `rel` and the unloads of the same rel that are running now. Each op only
   * waits for older ones (runExclusive waits for the loads and renames that started before it), so nothing deadlocks.
   */
  async function settleBefore(rel: string): Promise<void> {
    const waits = [...exclusive].filter((x) => isAtOrBelow(rel, x.rel)).map((x) => x.done);
    for (const u of unloading.values()) {
      if (sameRel(u.rel, rel))
        waits.push(u.done);
    }
    await Promise.allSettled(waits);
  }

  // ---------- GC ----------

  function gcNow(doc: DocInternal, keep: GcKeep): Promise<string[]> {
    return doc.runIo((p) => collectGarbage(doc, p, keep, jobImages(doc, jobRecords(), p)));
  }

  function clearGcTimer(docId: string): void {
    const t = gcTimers.get(docId);
    if (t !== undefined)
      clearTimeout(t);
    gcTimers.delete(docId);
  }

  /** UndoStack eviction → GC on the doc's queue (debounced). */
  function scheduleGc(doc: DocInternal): void {
    if (doc.unloading || gcTimers.has(doc.id))
      return;
    gcTimers.set(doc.id, setTimeout(() => {
      gcTimers.delete(doc.id);
      if (doc.unloading)
        return;
      gcNow(doc, 'history').catch((e: unknown) => console.warn('[documents] image GC failed', e));
    }, GC_DELAY_MS));
  }

  // ---------- characters ----------

  /** Load (or reload) a character json into `characters`. Serial per charRel with updateCharacter(). */
  function loadCharacter(charRel: string): Promise<CharacterMeta> {
    return queueFor(charQueues, charRel).run(async () => {
      const meta = freezeState(parseCharacter(await window.api.fs.readJson(charJsonRel(charRel))));
      characters.set(charRel, meta);
      return meta;
    });
  }

  /** Serial read-modify-write of a character json (the producer gets a frozen copy; return it unchanged for a no-op). */
  function updateCharacter(charRel: string, producer: (c: CharacterMeta) => CharacterMeta): Promise<CharacterMeta> {
    return queueFor(charQueues, charRel).run(async () => {
      const cur = freezeState(parseCharacter(await window.api.fs.readJson(charJsonRel(charRel))));
      const next = producer(cur);
      let stored = cur;
      if (next !== cur) {
        stored = freezeState(serializeCharacter(next));
        charMtimes.set(relKey(charRel), await window.api.fs.writeJson(charJsonRel(charRel), stored)); // no reload on rescan
      }
      characters.set(charRel, stored);
      return stored;
    });
  }

  function ensureCharacter(charRel: string): void {
    if (characters.has(charRel))
      return;
    loadCharacter(charRel).catch((e: unknown) => console.warn(`[documents] could not load character "${charRel}"`, e));
  }

  // ---------- load / unload ----------

  /** Load the animation json, or return the already open doc. Concurrent loads of one rel share a promise. */
  function load(rel: string): Promise<DocHandle> {
    const open = findOpen(rel);
    if (open)
      return Promise.resolve(open);
    const key = relKey(rel);
    let p = loading.get(key);
    if (!p) {
      p = trackClosed(rel, loadFresh(rel)).finally(() => loading.delete(key));
      loading.set(key, p);
    }
    return p;
  }

  /** The animation json at `rel` holds `id` (false when it is missing or unreadable). */
  async function holdsId(rel: string, id: string): Promise<boolean> {
    try {
      const raw: unknown = await window.api.fs.readJson(rel);
      return isObj(raw) && raw.id === id;
    } catch {
      return false;
    }
  }

  /**
   * The json at `rel` is a copy made outside the app (it shares its original's id) while the original still exists:
   * a pending job of that id targets another json holding the id, or images it references are not named after it but
   * after another animation whose json holds the id. Best effort: false when unsure (a later load of the same id
   * still gets a fresh one).
   */
  async function isCopy(meta: AnimationMeta, rel: string): Promise<boolean> {
    for (const r of jobRecords()) {
      if (r.docId === meta.id && !sameRel(r.animRel, rel) && await holdsId(r.animRel, meta.id))
        return true;
    }
    const uids = referencedImages(stateFromMeta(meta));
    if (uids.length === 0)
      return false;
    const charRel = charRelFromAnimRel(rel);
    const own = animNameFromRel(rel);
    const owners = new Map<string, string[]>(); // uid → owner names of its files
    for (const e of await window.api.fs.listDir(charRel)) {
      const parsed = e.kind === 'file' ? parseImageFileName(e.name) : null;
      if (parsed && uids.includes(parsed.uid) && !sameRel(parsed.owner, 'base'))
        owners.set(parsed.uid, [...owners.get(parsed.uid) ?? [], parsed.owner]);
    }
    const others = new Set<string>();
    for (const u of uids) {
      const names = owners.get(u) ?? [];
      if (!names.some((n) => sameRel(n, own)))
        names.forEach((n) => others.add(n));
    }
    for (const other of others) {
      if (await holdsId(animJsonRel(charRel, other), meta.id))
        return true;
    }
    return false;
  }

  async function loadFresh(rel: string): Promise<DocInternal> {
    await settleBefore(rel);
    // The doc is registered inside the lock: a closed-animation rename queued behind this load then finds it open
    const { doc, oldId } = await withRelLock(rel, async () => {
      const before = findOpen(rel);
      if (before)
        return { doc: before, oldId: null };
      let meta: AnimationMeta;
      try {
        meta = parseAnimation(await window.api.fs.readJson(rel));
      } catch (e) {
        throw new Error(`Could not open "${animNameFromRel(rel)}": ${errorMessage(e)}`);
      }
      const copy = !docs.has(meta.id) && await isCopy(meta, rel).catch((e: unknown) => {
        console.warn(`[documents] could not check whether "${rel}" is a copy`, e);
        return false;
      });
      const open = findOpen(rel);
      if (open)
        return { doc: open, oldId: null };
      // A copied json shares its original's id (jobs and tabs are keyed by id): the copy gets a fresh one, and so does
      // the second of two jsons with one id when neither can be told apart
      const id = meta.id;
      const fresh = copy || docs.has(id);
      if (fresh)
        meta.id = uid();
      const created = createDocHandle(meta, rel, { undoLimit: settings.settings.app.undoLimit, onIoCount, onEvict: scheduleGc });
      docs.set(created.id, created);
      return { doc: created, oldId: fresh ? id : null };
    });
    ensureCharacter(doc.charRel.value);
    if (oldId !== null) {
      // Jobs submitted from this very file follow it to its new id
      const own = jobRecords().filter((r) => r.docId === oldId && sameRel(r.animRel, rel));
      await Promise.all(own.map((r) => window.api.jobs.rekey(r.key, doc.id).catch((e: unknown) => console.warn('[documents] job rekey failed', e))));
      writeDoc(doc).catch((e: unknown) => console.warn('[documents] could not store the new animation id', e));
    }
    return doc;
  }

  /** Drop a doc without prompting: it leaves `docs` at once (its tab closes), then the queue drains and GC runs. */
  async function unload(docId: string): Promise<void> {
    const doc = docs.get(docId);
    if (!doc) {
      await unloading.get(docId)?.done;
      return;
    }
    await unloadDoc(doc, true);
  }

  async function unloadDoc(doc: DocInternal, gc: boolean): Promise<void> {
    doc.unloading = true;
    docs.delete(doc.id);
    clearGcTimer(doc.id);
    const done = (async (): Promise<void> => {
      try {
        if (gc && !doc.deleted)
          await gcNow(doc, 'saved');
        else
          await doc.io.drain();
      } catch (e) {
        console.warn('[documents] GC on unload failed', e);
      } finally {
        doc.dispose();
      }
    })();
    unloading.set(doc.id, { rel: doc.rel.value, done });
    try {
      await done;
    } finally {
      if (unloading.get(doc.id)?.done === done)
        unloading.delete(doc.id);
    }
  }

  // ---------- save ----------

  /**
   * Queue a write of the doc's state as it is when the write runs. Throws a user-facing error on failure, and a
   * DeletedError when the doc was deleted or closed before the write ran (its unload GC may already have run).
   */
  function writeDoc(doc: DocInternal): Promise<void> {
    return doc.runIo(async (p) => {
      if (doc.deleted)
        throw new DeletedError(`"${p.name}" was deleted`);
      if (doc.unloading)
        throw new DeletedError(`"${p.name}" was closed`);
      if (doc.missingOnDisk.value && !await window.api.fs.exists(p.charRel))
        throw new Error(`The character folder "${charNameFromRel(p.charRel)}" no longer exists`);
      const state = doc.state.value;
      const rev = doc.metaRev.value;
      const data = serializeAnimation(metaFromState(state, { id: doc.id, fps: doc.fps.value }));
      const mtime = await window.api.fs.writeJson(p.rel, data);
      doc.markSavedAs(state, rev);
      doc.missingOnDisk.value = false;
      doc.diskMtime = mtime; // the next rescan sees our own write as unchanged (no re-read)
    });
  }

  /** Save now (queued). `auto` only changes the wording ("Auto-saved"). false on failure (toast shown). */
  async function save(docId: string, opts: { auto?: boolean } = {}): Promise<boolean> {
    const doc = docs.get(docId);
    if (!doc)
      return false;
    if (!opts.auto)
      blurTextField();
    try {
      await writeDoc(doc);
    } catch (e) {
      if (!(e instanceof DeletedError))
        reportError(e, `Could not save "${doc.name.value}"`);
      return false;
    }
    mouseNotify(opts.auto ? 'Auto-saved' : 'Saved');
    return true;
  }

  let autosaving = false;

  /** Save every dirty doc (deferred while the editor drags); one "Auto-saved" note when something was written. */
  async function autosave(): Promise<number> {
    if (autosaving || lifecycle.isClosing())
      return 0;
    autosaving = true;
    try {
      await whenEditorIdle();
      if (lifecycle.isClosing())
        return 0;
      let saved = 0;
      // Missing-on-disk docs are recreated only by an explicit save
      for (const doc of [...docs.values()].filter((d) => d.dirty.value && !d.missingOnDisk.value && !d.unloading)) {
        // Re-checked per doc: earlier writes take time, and meanwhile a tab may close (Don't Save) or the app close
        if (docs.get(doc.id) !== doc || doc.unloading || !doc.dirty.value || doc.missingOnDisk.value || lifecycle.isClosing())
          continue;
        try {
          await writeDoc(doc);
          saved++;
        } catch (e) {
          if (!(e instanceof DeletedError))
            reportError(e, `Could not auto-save "${doc.name.value}"`);
        }
      }
      if (saved > 0)
        mouseNotify('Auto-saved');
      return saved;
    } finally {
      autosaving = false;
    }
  }

  // ---------- rename ----------

  /** Uids whose files belong to an open doc: everything it ever referenced or created, every history state, the saved state. */
  function ownedUids(doc: DocInternal): Set<string> {
    const out = new Set<string>([...doc.candidates, ...doc.created]);
    for (const s of [...doc.history.allStates(), doc.savedState(), doc.state.value]) {
      for (const u of referencedImages(s))
        out.add(u);
    }
    return out;
  }

  /**
   * Validate `newName` against the sibling animations, rename the owned images (an exact "<old>.<uid>.png" first, else
   * an orphaned "*.<uid>.png" left by an interrupted rename, never a file whose owner json exists), then the json.
   * The images roll back when the json rename fails.
   */
  async function moveAnimationFiles(jsonRel: string, newName: string, uids: ReadonlySet<string>): Promise<string> {
    const charRel = charRelFromAnimRel(jsonRel);
    const oldName = animNameFromRel(jsonRel);
    const entries = await window.api.fs.listDir(charRel);
    const siblings = entries.filter((e) => e.kind === 'file' && /\.json$/i.test(e.name)).map((e) => e.name.slice(0, -5));
    const problem = validateName(newName, { siblings, self: oldName });
    if (problem)
      throw new Error(problem);
    const live = new Set(siblings.map(relKey));
    const byUid = new Map<string, { name: string; orphan: boolean }[]>();
    for (const e of entries) {
      const parsed = e.kind === 'file' ? parseImageFileName(e.name) : null;
      if (!parsed || sameRel(parsed.owner, 'base'))
        continue;
      byUid.set(parsed.uid, [...byUid.get(parsed.uid) ?? [], { name: e.name, orphan: !live.has(relKey(parsed.owner)) }]);
    }
    const moved: [string, string][] = [];
    try {
      for (const u of uids) {
        const files = byUid.get(u) ?? [];
        const target = animImageFileName(newName, u);
        const exact = files.find((f) => sameRel(f.name, animImageFileName(oldName, u)));
        const orphan = files.some((f) => sameRel(f.name, target)) ? undefined : files.find((f) => f.orphan);
        const src = (exact ?? orphan)?.name;
        if (src === undefined || src === target)
          continue;
        await window.api.fs.rename(joinRel(charRel, src), joinRel(charRel, target));
        moved.push([src, target]);
      }
      const newRel = animJsonRel(charRel, newName);
      await window.api.fs.rename(jsonRel, newRel);
      return newRel;
    } catch (e) {
      for (const [src, target] of moved.reverse()) {
        await window.api.fs.rename(joinRel(charRel, target), joinRel(charRel, src))
          .catch((err: unknown) => console.warn('[documents] rename rollback failed', err));
      }
      throw e;
    }
  }

  async function retargetJobs(match: (r: JobUpdateEvent) => boolean, newRel: (r: JobUpdateEvent) => string | null): Promise<void> {
    const tasks = jobRecords().filter(match).map((r) => {
      const to = newRel(r);
      if (to === null || to === r.animRel)
        return Promise.resolve();
      return window.api.jobs.retarget(r.key, to).catch((e: unknown) => console.warn('[documents] job retarget failed', e));
    });
    await Promise.all(tasks);
  }

  async function renameOpen(doc: DocInternal, newName: string): Promise<string> {
    return doc.runIo(async (p) => {
      if (doc.deleted)
        throw new DeletedError(`"${p.name}" was deleted`);
      if (newName === p.name)
        return p.rel;
      if (doc.missingOnDisk.value)
        throw new Error(`"${p.name}" is missing on disk. Save it first, then rename it.`);
      const newRel = await moveAnimationFiles(p.rel, newName, ownedUids(doc));
      doc.setLocation(newRel);
      await retargetJobs((r) => r.docId === doc.id || sameRel(r.animRel, p.rel), () => newRel);
      return newRel;
    });
  }

  async function renameClosed(rel: string, newName: string): Promise<string> {
    await settleBefore(rel);
    return withRelLock(rel, async () => {
      const open = findOpen(rel);
      if (open)
        return renameOpen(open, newName);
      if (newName === animNameFromRel(rel))
        return rel;
      const meta = parseAnimation(await window.api.fs.readJson(rel));
      const newRel = await moveAnimationFiles(rel, newName, new Set(referencedImages(stateFromMeta(meta))));
      // By path only: a json copied outside the app shares the original's id (a stale animRel is found by id at apply)
      await retargetJobs((r) => sameRel(r.animRel, rel), () => newRel);
      return newRel;
    });
  }

  /** Rename an animation on disk, open or not. Resolves the new rel; rejects with a user-facing message. */
  async function renameAnimation(rel: string, newName: string): Promise<string> {
    try {
      const open = findOpen(rel);
      return await (open ? renameOpen(open, newName) : trackClosed(rel, renameClosed(rel, newName)));
    } catch (e) {
      throw new Error(errorMessage(e));
    }
  }

  // ---------- explorer exclusivity ----------

  /** Re-key cached characters at or below `root` (probe: where would an animation inside them go?). */
  function remapCharacters(root: string, remap: (docRel: string) => string | null): void {
    for (const [key, meta] of [...characters]) {
      if (!isAtOrBelow(key, root))
        continue;
      const probe = remap(joinRel(key, 'x.json'));
      const mtime = charMtimes.get(relKey(key));
      characters.delete(key);
      charMtimes.delete(relKey(key));
      if (probe === null)
        continue;
      const next = parentRel(probe);
      characters.set(next, meta);
      if (mtime !== undefined)
        charMtimes.set(relKey(next), mtime);
    }
  }

  /**
   * Run an explorer filesystem op on `rel` while the IO queues of the open docs at or below it are drained and paused,
   * then remap them (null → unloaded without prompt, so the tab closes) and retarget their pending jobs. `op` must not
   * save or rename the affected docs itself (their queues are paused).
   */
  async function runExclusive<T>(rel: string, op: () => Promise<T>, remap: (docRel: string) => string | null): Promise<T> {
    // Loads and closed renames that started earlier finish first; later ones wait for this op (settleBefore)
    const prior = [...closedOps].filter((x) => isAtOrBelow(x.rel, rel)).map((x) => x.done);
    let finish!: () => void;
    const entry = { rel, done: new Promise<void>((resolve) => {
      finish = resolve;
    }) };
    exclusive.add(entry);
    const unloads: Promise<void>[] = [];
    let result!: T;
    try {
      await Promise.allSettled(prior);
      const affected = [...docs.values()].filter((d) => isAtOrBelow(d.rel.value, rel));
      const releases = await Promise.all(affected.map((d) => d.io.pause()));
      try {
        result = await op();
        for (const doc of affected) {
          const from = doc.rel.value;
          const to = remap(from);
          if (to === null)
            doc.deleted = true;
          else if (to !== from)
            doc.setLocation(to);
        }
        remapCharacters(rel, remap);
        await retargetJobs((r) => isAtOrBelow(r.animRel, rel), (r) => remap(r.animRel));
        for (const doc of affected) {
          // Deleted docs leave `docs` now (tabs close); their unload drains once the queue is released
          if (doc.deleted)
            unloads.push(unloadDoc(doc, false));
          else
            ensureCharacter(doc.charRel.value);
        }
      } finally {
        for (const release of releases)
          release();
      }
    } finally {
      exclusive.delete(entry);
      finish();
    }
    await Promise.all(unloads);
    return result;
  }

  // ---------- rescan ----------

  /**
   * Clean doc whose json mtime changed (every save changes it): reload when the content differs from ours. Both sides
   * go through parseAnimation, so a file we wrote compares equal to the state it was written from (parsing
   * renormalizes the rounded quaternions, which can move their 6th decimal).
   */
  async function refreshFromDisk(doc: DocInternal, mtimeMs: number): Promise<void> {
    await doc.runIo(async (p) => {
      if (doc.deleted || doc.unloading || doc.dirty.value)
        return;
      const raw = await window.api.fs.readJson(p.rel);
      if (doc.dirty.value || doc.unloading)
        return;
      const meta = parseAnimation(raw);
      const mine = parseAnimation(serializeAnimation(metaFromState(doc.state.value, { id: doc.id, fps: doc.fps.value })));
      if (comparableJson(mine, doc.id) !== comparableJson(meta, doc.id))
        doc.replaceState(stateFromMeta(meta), meta.fps);
      doc.diskMtime = mtimeMs;
    });
  }

  /** After a rescan: reload clean docs whose json changed, flag vanished ones missingOnDisk, refresh / drop characters. */
  async function reconcile(scan: readonly ScanNode[]): Promise<void> {
    const anims = new Map<string, ScanNode>();
    const chars = new Map<string, ScanNode>();
    const walk = (nodes: readonly ScanNode[]): void => {
      for (const n of nodes) {
        if (n.kind === 'animation')
          anims.set(relKey(n.rel), n);
        else if (n.kind === 'character')
          chars.set(relKey(n.rel), n);
        walk(n.children);
      }
    };
    walk(scan);
    const tasks: Promise<void>[] = [];
    for (const doc of docs.values()) {
      if (doc.unloading)
        continue;
      const node = anims.get(relKey(doc.rel.value));
      if (!node) {
        // The scan may predate a rename or save that ran since: confirm on the queue before flagging it
        tasks.push(doc.runIo(async (p) => {
          const missing = !doc.deleted && !await window.api.fs.exists(p.rel);
          doc.missingOnDisk.value = missing;
          if (missing)
            doc.diskMtime = null;
        }).catch((e: unknown) => console.warn(`[documents] could not check "${doc.name.value}"`, e)));
        continue;
      }
      doc.missingOnDisk.value = false;
      if (node.mtimeMs === null || node.mtimeMs === doc.diskMtime || doc.dirty.value)
        continue;
      tasks.push(refreshFromDisk(doc, node.mtimeMs).catch((e: unknown) => console.warn(`[documents] could not reload "${doc.name.value}"`, e)));
    }
    for (const key of [...characters.keys()]) {
      const node = chars.get(relKey(key));
      if (!node) {
        characters.delete(key);
        charMtimes.delete(relKey(key));
        continue;
      }
      const mtime = node.mtimeMs;
      if (mtime === null || charMtimes.get(relKey(key)) === mtime)
        continue;
      tasks.push(loadCharacter(key).then(() => {
        charMtimes.set(relKey(key), mtime);
      }, (e: unknown) => console.warn(`[documents] could not reload character "${key}"`, e)));
    }
    await Promise.all(tasks);
  }

  // ---------- app close ----------

  function closePrompt(dirty: DocInternal[]): Promise<string> {
    const label = (d: DocInternal): string => `"${d.name.value}" (${charNameFromRel(d.charRel.value)})`;
    // One doc is named in the message only; several are listed in the detail (at most 12 lines)
    const names = dirty.length === 1 ? [] : dirty.slice(0, 12).map((d) => `• ${label(d)}`);
    if (dirty.length > 12)
      names.push(`• … and ${dirty.length - 12} more`);
    const jobs = jobRecords().filter(isUnfinished).length;
    const jobLine = jobs === 0 ? '' : `${jobs === 1 ? 'A generation job is' : `${jobs} generation jobs are`} still running. ${jobs === 1 ? 'It continues' : 'They continue'} the next time the app starts.`;
    const detail = [names.join('\n'), jobLine].filter((t) => t !== '').join('\n\n');
    return dialogs.choice({
      title: 'Unsaved changes',
      message: dirty.length === 1 ? `Save changes to ${label(dirty[0])} before closing?` : `Save changes to ${dirty.length} animations before closing?`,
      detail: detail || undefined,
      buttons: [
        { id: 'save', label: dirty.length === 1 ? 'Save' : 'Save All', kind: 'primary' },
        { id: 'discard', label: 'Don\'t Save', kind: 'danger' },
        { id: 'cancel', label: 'Cancel' }
      ],
      cancelId: 'cancel'
    });
  }

  /** lifecycle close handler: prompt for dirty docs, save, GC every doc, persist the workspace. */
  async function onAppClose(): Promise<boolean> {
    cancelEditorInteraction();
    blurTextField(); // a focused field's edit counts as unsaved and is saved with its doc
    const dirty = [...docs.values()].filter((d) => d.dirty.value);
    if (dirty.length > 0) {
      const choice = await closePrompt(dirty);
      if (choice === 'cancel')
        return false;
      if (choice === 'save') {
        for (const doc of dirty) {
          try {
            await writeDoc(doc);
          } catch (e) {
            reportError(e, `Could not save "${doc.name.value}"`);
            return false;
          }
        }
      }
    }
    for (const id of [...gcTimers.keys()])
      clearGcTimer(id);
    await Promise.all([...docs.values()].map((d) => gcNow(d, 'savedAndCurrent').catch((e: unknown) => console.warn('[documents] image GC failed', e))));
    await Promise.all([...charQueues.values()].map((q) => q.drain()));
    await useWorkspaceStore().flush();
    return true;
  }

  const anyDirty = (): boolean => [...docs.values()].some((d) => d.dirty.value);

  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (lifecycle.isClosing() || !anyDirty())
      return;
    e.preventDefault();
    e.returnValue = '';
  };

  // ---------- wiring ----------

  watch(() => settings.settings.app.undoLimit, (limit) => {
    for (const doc of docs.values())
      doc.history.setLimit(limit);
  });

  let autosaveTimer: ReturnType<typeof setInterval> | null = null;
  watch(() => settings.settings.app.autoSaveIntervalSec, (sec) => {
    if (autosaveTimer !== null)
      clearInterval(autosaveTimer);
    autosaveTimer = null;
    if (sec > 0)
      autosaveTimer = setInterval(() => void autosave(), sec * 1000);
  }, { immediate: true });

  const offClose = lifecycle.registerCloseHandler(onAppClose);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
    window.addEventListener('beforeunload', onBeforeUnload);

  onScopeDispose(() => {
    offClose();
    if (autosaveTimer !== null)
      clearInterval(autosaveTimer);
    for (const id of [...gcTimers.keys()])
      clearGcTimer(id);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function')
      window.removeEventListener('beforeunload', onBeforeUnload);
  });

  return {
    docs, characters, ioBusy,
    get, findByRel, load, save, unload, renameAnimation, runExclusive, loadCharacter, updateCharacter, reconcile,
    autosave
  };
});

/** The store typed as its public API (also a compile-time check that it satisfies DocumentsStoreApi). */
export function useDocumentsApi(): DocumentsStoreApi {
  return useDocumentsStore();
}
