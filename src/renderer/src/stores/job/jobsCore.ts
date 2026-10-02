// Jobs logic behind stores/jobs.ts (JobsStoreApi, PLAN §5 Jobs / §7), store-free so a test can drive it with a mock
// window.api and mock documents / tabs stores. Reactive state holds plain records and doc ids, never DocHandles.
// - records mirror main's journal through 'jobs:update' plus api.jobs.list() at init;
// - in-flight estimates / submits / result applications are tracked per doc id (busy flags, spinners);
// - final records are handled once per key: completed → staged PNGs moved, "Generate" applied, saved, acked (once the
//   save worked); failed → error toast, acked; cancelled → acked quietly;
// - a close handler waits for generation POSTs in flight, so a job PixelLab accepted is journaled before the app quits.
import { shallowReactive, shallowRef, watch, type ShallowRef } from 'vue';
import type { ScanNode } from '@shared/api';
import { animImageRel, animNameFromRel, jobStageDirRel } from '@shared/dataPaths';
import { FINAL_JOB_STATUSES, type JobRecord, type JobStatus, type JobUpdateEvent, type SubmitAnimateResult } from '@shared/jobs';
import type { KeypointOut } from '@shared/pixellab';
import { uid } from '@shared/uid';
import type { CharacterMeta } from '../../core/model';
import { buildGeneration } from '../../core/generate';
import { isAtOrBelow, sameRel } from '../../core/util/relPath';
import { cancelEditorInteraction } from '../../services/editorState';
import { errorMessage, reportError } from '../../services/errors';
import { lifecycle } from '../../services/lifecycle';
import { toasts } from '../../services/toasts';
import type { DocHandle, DocumentsStoreApi, TabsStoreApi } from '../types';
import { changesMessage, hasJobResult, snapshotChanges, withJobResult, type SnapshotChanges } from './applyResult';

export interface JobsDeps {
  /** Read lazily on every use (the stores may reference each other during their setup). */
  documents(): Pick<DocumentsStoreApi, 'docs' | 'characters' | 'get' | 'findByRel' | 'load' | 'save' | 'unload' | 'loadCharacter' | 'updateCharacter'>;
  tabs(): Pick<TabsStoreApi, 'order' | 'activeDocId' | 'open'>;
  /** Window focus (default document.hasFocus()): unfocused → flash the taskbar and keep result toasts up. */
  hasFocus?: () => boolean;
}

export interface JobsCore {
  records: ShallowRef<readonly JobUpdateEvent[]>;
  busy(docId: string): boolean;
  busyUnder(rel: string): boolean;
  pendingUnder(rel: string): JobUpdateEvent[];
  activeJob(docId: string): JobUpdateEvent | null;
  estimate(docId: string, opts?: { force?: boolean }): Promise<KeypointOut[] | null>;
  submitGenerate(docId: string): Promise<SubmitAnimateResult>;
  cancel(key: string): Promise<void>;
  /** Subscribe to 'jobs:update', load api.jobs.list() and handle records that are already final. Idempotent. */
  init(): Promise<void>;
  /** Unsubscribe (tests). */
  dispose(): void;
  /** Resolves when every queued final-record handling has finished (tests, close flows). */
  idle(): Promise<void>;
}

const UNFINISHED: readonly JobStatus[] = ['submitting', 'queued', 'processing'];
const isUnfinished = (r: JobUpdateEvent): boolean => UNFINISHED.includes(r.status);
const isFinal = (r: JobUpdateEvent): boolean => FINAL_JOB_STATUSES.includes(r.status);
const copyKeypoint = (k: KeypointOut): KeypointOut => ({ label: k.label, x: k.x, y: k.y, z_index: k.z_index });
const NO_CHANGES: SnapshotChanges = { track: false, camera: false };
const CLOSING_POLL_MS = 500;
/** Longest wait for a generation POST at app close: main's submit timeout (120 s) plus a margin. */
const SUBMIT_WAIT_MS = 125_000;

/** A full record (api.jobs.get) as the event shape the store keeps. */
function withoutSnapshot(r: JobRecord): JobUpdateEvent {
  const ev: Partial<JobRecord> = { ...r };
  delete ev.snapshot;
  return ev as JobUpdateEvent;
}

export function createJobs(deps: JobsDeps): JobsCore {
  const api = (): Window['api'] => window.api;
  const hasFocus = deps.hasFocus ?? ((): boolean => typeof document === 'undefined' || document.hasFocus());

  const records = shallowRef<readonly JobUpdateEvent[]>([]);
  const estimating = shallowReactive(new Set<string>());
  const submitting = shallowReactive(new Set<string>());
  /** Docs whose completed job is being applied (the record is 'completed', but the doc must stay busy). */
  const applying = shallowReactive(new Set<string>());
  /** Keys acked this session: late events for them are ignored. */
  const done = new Set<string>();
  /** Keys whose final handling is queued or running (guards against double-apply). */
  const handling = new Set<string>();
  /** Completed keys whose applied result is not saved yet, with the watcher that acks them once it is. */
  const unsaved = new Map<string, () => void>();
  let chain: Promise<void> = Promise.resolve();
  let off: (() => void) | null = null;
  let offClose: (() => void) | null = null;
  let initPromise: Promise<void> | null = null;

  // ---------- records ----------

  function upsert(ev: JobUpdateEvent): void {
    if (done.has(ev.key))
      return;
    const list = records.value;
    const i = list.findIndex((r) => r.key === ev.key);
    if (i >= 0 && list[i].updatedAt > ev.updatedAt)
      return;
    const next = list.slice();
    if (i >= 0)
      next[i] = ev;
    else
      next.push(ev);
    records.value = next;
  }

  function removeRecord(key: string): void {
    if (records.value.some((r) => r.key === key))
      records.value = records.value.filter((r) => r.key !== key);
  }

  const findRecord = (key: string): JobUpdateEvent | undefined => records.value.find((r) => r.key === key);

  /** Where a record's animation is now: the open doc's path (renames follow it), else main's animRel. */
  const recordRel = (r: JobUpdateEvent): string => deps.documents().get(r.docId)?.rel.value ?? r.animRel;

  const displayName = (r: JobUpdateEvent): string => deps.documents().get(r.docId)?.name.value ?? animNameFromRel(r.animRel);

  // ---------- queries ----------

  function busy(docId: string): boolean {
    return estimating.has(docId) || submitting.has(docId) || applying.has(docId)
      || records.value.some((r) => r.docId === docId && isUnfinished(r));
  }

  function busyUnder(rel: string): boolean {
    const documents = deps.documents();
    for (const id of [...estimating, ...submitting, ...applying]) {
      const d = documents.get(id);
      if (d && isAtOrBelow(d.rel.value, rel))
        return true;
    }
    return records.value.some((r) => isUnfinished(r) && isAtOrBelow(recordRel(r), rel));
  }

  function pendingUnder(rel: string): JobUpdateEvent[] {
    return records.value.filter((r) => isUnfinished(r) && isAtOrBelow(recordRel(r), rel));
  }

  function activeJob(docId: string): JobUpdateEvent | null {
    let best: JobUpdateEvent | null = null;
    for (const r of records.value) {
      if (r.docId === docId && isUnfinished(r) && (!best || r.submittedAt > best.submittedAt))
        best = r;
    }
    return best;
  }

  // ---------- estimate ----------

  async function loadCharacterMeta(charRel: string): Promise<CharacterMeta> {
    const documents = deps.documents();
    return documents.characters.get(charRel) ?? await documents.loadCharacter(charRel);
  }

  /** The base image's cached estimate (a copy), or null when there is none or the character cannot be read. */
  async function cachedEstimate(charRel: string, baseUid: string): Promise<KeypointOut[] | null> {
    let meta: CharacterMeta;
    try {
      meta = await loadCharacterMeta(charRel);
    } catch (e) {
      console.warn('[jobs] could not read the character for its estimate cache; estimating instead', e);
      return null;
    }
    const kps = meta.baseImages.find((b) => b.uid === baseUid)?.estimate?.keypoints;
    return kps ? kps.map(copyKeypoint) : null;
  }

  /** Store the estimate on the source base image (skipped when that base image is gone). Never throws. */
  async function cacheEstimate(charRel: string, baseUid: string, keypoints: readonly KeypointOut[]): Promise<void> {
    try {
      const meta = await loadCharacterMeta(charRel);
      if (!meta.baseImages.some((b) => b.uid === baseUid))
        return;
      const at = new Date().toISOString();
      await deps.documents().updateCharacter(charRel, (c) => {
        const i = c.baseImages.findIndex((b) => b.uid === baseUid);
        if (i < 0)
          return c;
        const baseImages = c.baseImages.slice();
        baseImages[i] = { ...baseImages[i], estimate: { keypoints: keypoints.map(copyKeypoint), at } };
        return { ...c, baseImages };
      });
    } catch (e) {
      console.warn('[jobs] could not cache the estimate', e);
      toasts.push({ kind: 'warning', title: 'Estimate not cached', message: `The estimate worked, but saving it in the character failed: ${errorMessage(e)}` });
    }
  }

  /** The estimate finished for an image that is no longer the reference (another one was picked, undo): say so. */
  function staleEstimate(doc: DocHandle, cached: boolean): null {
    if (deps.documents().get(doc.id) === doc) {
      toasts.push({
        kind: 'info',
        title: 'Estimate discarded',
        message: `The reference image of "${doc.name.value}" changed while the estimate ran.${cached ? ' The result is cached on its base image.' : ''}`
      });
    }
    return null;
  }

  async function estimate(docId: string, opts: { force?: boolean } = {}): Promise<KeypointOut[] | null> {
    const doc = deps.documents().get(docId);
    if (!doc || busy(docId))
      return null;
    const { image: imageUid, sourceBaseUid: baseUid } = doc.state.value.reference;
    if (!imageUid)
      return null;
    const current = (): boolean => deps.documents().get(docId) === doc && doc.state.value.reference.image === imageUid;
    estimating.add(docId);
    try {
      if (!opts.force && baseUid) {
        const cached = await cachedEstimate(doc.charRel.value, baseUid);
        if (cached)
          return current() ? cached : staleEstimate(doc, false);
      }
      // Dispatched from the doc's IO queue so the image path is current (renames run there), but awaited outside it:
      // saves must not wait for a network call
      const call = await doc.runIo(async (p) => {
        const result = api().pixellab.estimateSkeleton(animImageRel(p.charRel, p.name, imageUid));
        result.catch(() => undefined);
        return { result };
      });
      const res = await call.result;
      if (!res.ok) {
        toasts.push({ kind: 'error', title: 'Skeleton estimate failed', message: res.error });
        return null;
      }
      const keypoints = res.data.keypoints.map(copyKeypoint);
      if (baseUid && deps.documents().get(docId) === doc)
        await cacheEstimate(doc.charRel.value, baseUid, keypoints);
      return current() ? keypoints : staleEstimate(doc, !!baseUid);
    } catch (e) {
      reportError(e, 'Skeleton estimate failed');
      return null;
    } finally {
      estimating.delete(docId);
    }
  }

  // ---------- generate ----------

  async function characterDescription(charRel: string): Promise<string> {
    try {
      return (await loadCharacterMeta(charRel)).description;
    } catch (e) {
      console.warn('[jobs] could not read the character description', e);
      return '';
    }
  }

  async function submitGenerate(docId: string): Promise<SubmitAnimateResult> {
    const doc = deps.documents().get(docId);
    if (!doc)
      return { ok: false, error: 'The animation is not open' };
    if (busy(docId))
      return { ok: false, error: 'A PixelLab call is already running for this animation' };
    const state = doc.state.value; // what the user confirmed; later edits do not change the submission
    const imageUid = state.reference.image;
    if (!imageUid)
      return { ok: false, error: 'Pick a reference image' };
    submitting.add(docId);
    try {
      const plan = buildGeneration(state, await characterDescription(doc.charRel.value));
      const frameUids: string[] = [];
      while (frameUids.length < plan.snapshot.frames.length) {
        const u = uid();
        if (!frameUids.includes(u))
          frameUids.push(u);
      }
      // Same queue rule as estimate: paths read in the queue, the POST awaited outside it
      const call = await doc.runIo(async (p) => {
        const result = api().jobs.submitAnimate({
          docId, animRel: p.rel, refImageRel: animImageRel(p.charRel, p.name, imageUid),
          request: plan.request, frameUids, snapshot: plan.snapshot
        });
        result.catch(() => undefined);
        return { result };
      });
      const res = await call.result;
      if (res.ok)
        upsert(res.data);
      else if (res.record)
        onUpdate(res.record); // the failed record main kept (maybe billed): its one toast comes from handleFinal
      return res;
    } catch (e) {
      console.error('[jobs] submit failed', e);
      return { ok: false, error: errorMessage(e) };
    } finally {
      submitting.delete(docId);
    }
  }

  /** Close handler: wait (bounded) for generation POSTs in flight, so the job PixelLab accepts is journaled by main. */
  async function waitForSubmits(): Promise<boolean> {
    if (submitting.size === 0)
      return true;
    const id = toasts.push({ kind: 'info', title: 'Waiting for PixelLab to accept the generation…', message: 'The app closes once it is queued.', timeoutMs: 0 });
    const until = Date.now() + SUBMIT_WAIT_MS;
    while (submitting.size > 0 && Date.now() < until)
      await new Promise((r) => setTimeout(r, CLOSING_POLL_MS));
    toasts.dismiss(id);
    return true;
  }

  async function cancel(key: string): Promise<void> {
    const res = await api().jobs.cancel(key);
    if (!res.ok)
      toasts.push({ kind: 'warning', title: 'Could not cancel the generation', message: res.error });
  }

  // ---------- final records ----------

  function flash(): void {
    if (!hasFocus())
      api().app.flashFrame().catch(() => undefined);
  }

  async function ack(key: string): Promise<void> {
    await api().jobs.ack(key);
    done.add(key);
    removeRecord(key);
  }

  /** Don't touch docs while the close handshake runs (prompting, saving); a cancelled close resumes here. */
  async function whenNotClosing(): Promise<void> {
    while (lifecycle.isClosing())
      await new Promise((r) => setTimeout(r, CLOSING_POLL_MS));
  }

  /** Move a staged result into the character dir. Accepts a file an earlier attempt already moved (crash, retry). */
  async function moveStaged(fromRel: string, toRel: string): Promise<void> {
    try {
      await api().fs.rename(fromRel, toRel);
    } catch (e) {
      if (await api().fs.exists(toRel) && !await api().fs.exists(fromRel))
        return;
      throw e;
    }
  }

  /**
   * The doc a record applies to: the open one, else loaded headless from `rel` (`loaded` = by us). Null when the json
   * is gone or now holds a different animation (a doc loaded only to find that out is unloaded again).
   */
  async function resolveDoc(docId: string, rel: string): Promise<{ doc: DocHandle; loaded: boolean } | null> {
    const documents = deps.documents();
    const open = documents.get(docId);
    if (open)
      return { doc: open, loaded: false };
    if (documents.findByRel(rel) || !await api().fs.exists(rel))
      return null;
    const doc = await documents.load(rel);
    if (doc.id === docId)
      return { doc, loaded: true };
    if (!deps.tabs().order.includes(doc.id))
      await documents.unload(doc.id);
    return null;
  }

  /** The id stored in an animation json; null when it cannot be read. */
  async function readId(rel: string): Promise<string | null> {
    try {
      const raw: unknown = await api().fs.readJson(rel);
      const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
      return typeof id === 'string' ? id : null;
    } catch {
      return null; // missing or unreadable: not the animation we look for
    }
  }

  /**
   * Where the closed animation `docId` lives when it is no longer at `oldRel` (renamed or moved outside the app, or
   * its record was never retargeted): the one json of the data root holding that id. Null when none or several do (a
   * json copied outside the app shares its original's id: never guess).
   */
  async function locate(docId: string, oldRel: string): Promise<string | null> {
    const rels: string[] = [];
    const walk = (nodes: readonly ScanNode[]): void => {
      for (const n of nodes) {
        if (n.kind === 'animation' && !sameRel(n.rel, oldRel))
          rels.push(n.rel);
        walk(n.children);
      }
    };
    walk(await api().fs.scanData());
    const hits: string[] = [];
    for (const rel of rels) {
      const open = deps.documents().findByRel(rel);
      if ((open ? open.id : await readId(rel)) === docId)
        hits.push(rel);
    }
    return hits.length === 1 ? hits[0] : null;
  }

  /** resolveDoc(), else the animation found by id elsewhere in the data root (the record is retargeted to it). */
  async function resolveOrLocate(rec: JobRecord): Promise<{ doc: DocHandle; loaded: boolean } | null> {
    const found = await resolveDoc(rec.docId, rec.animRel);
    if (found)
      return found;
    const rel = await locate(rec.docId, rec.animRel);
    if (rel === null)
      return null;
    await api().jobs.retarget(rec.key, rel);
    return resolveDoc(rec.docId, rel);
  }

  async function discard(rec: JobUpdateEvent, why: string): Promise<void> {
    toasts.push({ kind: 'warning', title: 'Generated animation discarded', message: why });
    await ack(rec.key);
  }

  /** A complete result with nothing to apply it to: its staged images go to the Recycle Bin (recoverable), then ack. */
  async function discardToTrash(rec: JobUpdateEvent, why: string): Promise<void> {
    const dir = jobStageDirRel(rec.key);
    if (!await api().fs.exists(dir))
      return discard(rec, why); // an earlier attempt already moved the images out
    await api().fs.trash(dir);
    await discard(rec, `${why} They were moved to the Recycle Bin (folder "${rec.key}").`);
  }

  /**
   * The applied result could not be saved: main keeps the record (its frames stay safe from the session sweep and a
   * crash re-applies them at the next launch) until the doc is clean again (saved, or undone to its saved state) or
   * closed. Then it is acked, so a later launch never re-applies an old result.
   */
  function ackOnceSaved(key: string, doc: DocHandle): void {
    unsaved.get(key)?.();
    unsaved.delete(key);
    const settled = (): boolean => !doc.dirty.value || deps.documents().get(doc.id) !== doc;
    const finish = (): void => {
      ack(key).catch((e: unknown) => console.warn(`[jobs] could not ack job ${key}`, e));
    };
    if (settled()) {
      finish();
      return;
    }
    const stop = watch(settled, (ok) => {
      if (!ok)
        return;
      stop();
      unsaved.delete(key);
      finish();
    });
    unsaved.set(key, stop);
  }

  async function applyCompleted(rec: JobUpdateEvent): Promise<void> {
    await whenNotClosing();
    const full = await api().jobs.get(rec.key);
    if (!full) {
      done.add(rec.key);
      removeRecord(rec.key);
      return;
    }
    // Main's copy is the newest (e.g. animRel after a retarget); the documents store reads our records when loading
    upsert(withoutSnapshot(full));
    const name = displayName(rec);
    const imageUids = full.frameUids;
    const staged = full.stagedFiles;
    const n = imageUids.length;
    if (!staged || staged.length !== n || full.snapshot.frames.length !== n)
      return discard(rec, `The generation for "${name}" finished without a complete set of images.`);

    applying.add(full.docId);
    try {
      const first = await resolveOrLocate(full);
      if (!first)
        return discardToTrash(rec, `"${name}" no longer exists, so its ${n} generated frames were not applied.`);
      const moving = first.doc;
      await moving.runIo(async (p) => {
        for (let i = 0; i < n; i++) {
          await moveStaged(staged[i], animImageRel(p.charRel, p.name, imageUids[i]));
          moving.noteCreatedImage(imageUids[i]);
        }
      });
      // The doc may have been unloaded while the files moved (tab closed): resolve it again from its last path
      const target = deps.documents().get(full.docId) === moving ? first : await resolveDoc(full.docId, moving.rel.value);
      if (!target)
        return discard(rec, `"${name}" no longer exists, so its ${n} generated frames were not applied.`);
      const { doc, loaded } = target;
      const tabs = deps.tabs();

      let changes = NO_CHANGES;
      if (!hasJobResult(doc.state.value, imageUids)) {
        changes = snapshotChanges(doc.state.value, full.snapshot);
        if (tabs.activeDocId === doc.id)
          cancelEditorInteraction();
        if (doc !== moving) {
          for (const u of imageUids)
            doc.noteCreatedImage(u);
        }
        doc.apply('Generate', (s) => withJobResult(s, full.snapshot, imageUids));
      }
      const saved = await deps.documents().save(doc.id, { auto: true });
      const hasTab = tabs.order.includes(doc.id);
      if (loaded && !hasTab) {
        if (saved)
          await deps.documents().unload(doc.id);
        else
          await tabs.open(doc.rel.value); // keep the unsaved result visible instead of dropping it
      }
      if (saved)
        await ack(full.key);
      else
        ackOnceSaved(full.key, doc);

      const docId = doc.id;
      const lastRel = doc.rel.value;
      const focused = hasFocus();
      const notes = [changesMessage(changes, hasTab || !saved), saved ? '' : 'It is not saved yet: save the animation to keep the frames.'];
      toasts.push({
        kind: 'success',
        title: `Animation generated — ${doc.name.value} (${n} frames)`,
        message: notes.filter((m) => m !== '').join(' ') || undefined,
        action: tabs.activeDocId === docId ? undefined : { label: 'Open', run: () => openDoc(docId, lastRel) },
        timeoutMs: focused ? undefined : 0
      });
      flash();
    } finally {
      applying.delete(full.docId);
    }
  }

  /** The result toast's Open: the open doc, else the closed json, found by id when it was renamed or moved since. */
  function openDoc(docId: string, fallbackRel: string): void {
    void (async () => {
      let rel = deps.documents().get(docId)?.rel.value ?? null;
      if (rel === null)
        rel = await readId(fallbackRel) === docId ? fallbackRel : await locate(docId, fallbackRel);
      if (rel === null) {
        toasts.push({ kind: 'info', title: `"${animNameFromRel(fallbackRel)}" was moved or deleted`, message: 'Open it from the explorer.' });
        return;
      }
      await deps.tabs().open(rel);
    })().catch((e: unknown) => reportError(e, 'Could not open the animation'));
  }

  async function handleFinal(key: string): Promise<void> {
    const rec = findRecord(key);
    if (!rec || done.has(key))
      return;
    if (rec.status === 'cancelled')
      return ack(key);
    if (rec.status === 'failed') {
      // No job id: PixelLab may have accepted (and billed) a submission whose answer never arrived; that toast stays up
      const unconfirmed = rec.jobId === null;
      const error = rec.error ?? 'PixelLab reported the job as failed';
      toasts.push({
        kind: 'error',
        title: `${unconfirmed ? 'Generation not confirmed' : 'Generation failed'} — ${displayName(rec)}`,
        message: rec.jobId && !error.includes(rec.jobId) ? `${error}\nPixelLab job: ${rec.jobId}` : error,
        timeoutMs: unconfirmed || !hasFocus() ? 0 : undefined
      });
      flash();
      return ack(key);
    }
    if (rec.status === 'completed')
      return applyCompleted(rec);
  }

  function applyFailed(key: string, e: unknown): void {
    console.error(`[jobs] handling job ${key} failed`, e);
    toasts.push({
      kind: 'error',
      title: 'Could not apply the generated animation',
      message: `${errorMessage(e)}. The result is kept and retried at the next launch.`,
      action: { label: 'Retry', run: () => retry(key) },
      timeoutMs: 0
    });
  }

  /** Queue a final record's handling once (serially, one record at a time). */
  function onFinal(rec: JobUpdateEvent): void {
    if (done.has(rec.key) || handling.has(rec.key) || unsaved.has(rec.key))
      return;
    handling.add(rec.key);
    chain = chain
      .then(() => handleFinal(rec.key))
      .catch((e) => applyFailed(rec.key, e))
      .finally(() => {
        handling.delete(rec.key);
      });
  }

  function retry(key: string): void {
    const rec = findRecord(key);
    if (rec && isFinal(rec))
      onFinal(rec);
  }

  function onUpdate(ev: JobUpdateEvent): void {
    if (done.has(ev.key))
      return;
    upsert(ev);
    const rec = findRecord(ev.key);
    if (rec && isFinal(rec))
      onFinal(rec);
  }

  function init(): Promise<void> {
    initPromise ??= (async () => {
      off = api().on('jobs:update', onUpdate);
      offClose = lifecycle.registerCloseHandler(waitForSubmits);
      for (const r of await api().jobs.list())
        upsert(r);
      for (const r of records.value) {
        if (isFinal(r))
          onFinal(r);
      }
    })();
    return initPromise;
  }

  function dispose(): void {
    off?.();
    off = null;
    offClose?.();
    offClose = null;
    for (const stop of unsaved.values())
      stop();
    unsaved.clear();
  }

  async function idle(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== chain) {
      seen = chain;
      await seen;
    }
  }

  return { records, busy, busyUnder, pendingUnder, activeJob, estimate, submitGenerate, cancel, init, dispose, idle };
}
