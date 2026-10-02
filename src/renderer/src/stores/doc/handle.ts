// The real DocHandle (stores/types.ts) plus the store-private bookkeeping the documents store needs: GC candidates,
// the saved state, the doc's serial IO queue and its location. markRaw'd. stores/mockDoc.ts builds on it too.
import { computed, markRaw, ref, shallowRef } from 'vue';
import { animNameFromRel, charRelFromAnimRel } from '@shared/dataPaths';
import type { AnimationMeta, UndoableState } from '../../core/model';
import { referencedImages, stateFromMeta } from '../../core/docState';
import { deepFreeze } from '../../core/util/freeze';
import { UndoStack } from '../../core/undo/UndoStack';
import type { ApplyOptions, DocHandle, DocPaths } from '../types';
import { IoQueue } from './ioQueue';

/** Dev and node scripts freeze document state; production builds (DEV === false) skip it. */
const FREEZE = import.meta.env?.DEV !== false;
export const freezeState = <T>(s: T): T => FREEZE ? deepFreeze(s) : s;

export interface DocInternal extends DocHandle {
  readonly io: IoQueue;
  /** GC candidates: image uids this doc ever referenced (loaded json, any state it held) or created this session. */
  readonly candidates: Set<string>;
  /** Uids that appeared in some state. A created uid not in here is still being applied: eviction GC keeps it. */
  readonly seen: Set<string>;
  /** Uids registered through noteCreatedImage(). */
  readonly created: Set<string>;
  /** What is on disk (the loaded or last saved state). */
  savedState(): UndoableState;
  /** Record `state` + `metaRev` as written (a save captured them when it started). */
  markSavedAs(state: UndoableState, metaRev: number): void;
  /** Json mtime last matched against a scan; null = unknown (after load, save or a move). */
  diskMtime: number | null;
  /** Current location. Read it inside the IO queue only (runIo passes it). */
  paths(): DocPaths;
  /** Move the doc (rename or explorer remap): rel, charRel and name follow the new json rel. */
  setLocation(rel: string): void;
  /** Set when unload starts: autosave, reconcile and GC scheduling skip the doc. */
  unloading: boolean;
  /** Its file was deleted by an explorer operation: queued saves must not recreate it. */
  deleted: boolean;
  dispose(): void;
}

export interface CreateDocOptions {
  /** Default: UndoStack's DEFAULT_UNDO_LIMIT. */
  undoLimit?: number;
  /** IO queue size changes (summed into the store's ioBusy). */
  onIoCount: (delta: number) => void;
  /** The history evicted states (schedule GC). */
  onEvict: (doc: DocInternal) => void;
}

/** Handle for a parsed animation at json `rel`. The meta's nested objects become the (frozen) initial state. */
export function createDocHandle(meta: AnimationMeta, rel: string, opts: CreateDocOptions): DocInternal {
  const initial = freezeState(stateFromMeta(meta));
  const history = new UndoStack<UndoableState>(initial, { limit: opts.undoLimit });
  const state = shallowRef(initial);
  const fps = ref(meta.fps);
  const version = ref(0);
  const metaRev = ref(0);
  const saved = shallowRef<{ state: UndoableState; metaRev: number }>({ state: initial, metaRev: 0 });
  const relRef = ref(rel);
  const charRel = ref(charRelFromAnimRel(rel));
  const name = ref(animNameFromRel(rel));
  const candidates = new Set<string>();
  const seen = new Set<string>();
  const created = new Set<string>();

  const see = (s: UndoableState): void => {
    for (const u of referencedImages(s)) {
      seen.add(u);
      candidates.add(u);
    }
  };
  see(initial);

  const show = (s: UndoableState): void => {
    state.value = s;
    version.value++;
  };

  const doc: DocInternal = {
    id: meta.id,
    rel: relRef,
    charRel,
    name,
    state,
    fps,
    version,
    metaRev,
    dirty: computed(() => state.value !== saved.value.state || metaRev.value !== saved.value.metaRev),
    history,
    missingOnDisk: ref(false),
    io: new IoQueue(opts.onIoCount),
    candidates,
    seen,
    created,
    diskMtime: null,
    unloading: false,
    deleted: false,
    apply(label: string, producer: (s: UndoableState) => UndoableState, applyOpts?: ApplyOptions): void {
      const next = producer(state.value);
      if (next === state.value)
        return;
      const frozen = freezeState(next);
      see(frozen);
      history.push(label, frozen, applyOpts);
      show(history.current);
    },
    undo(): string | null {
      const r = history.undo();
      if (r)
        show(r.state);
      return r?.label ?? null;
    },
    redo(): string | null {
      const r = history.redo();
      if (r)
        show(r.state);
      return r?.label ?? null;
    },
    setFps(value: number): void {
      if (value === fps.value)
        return;
      fps.value = value;
      metaRev.value++;
      version.value++;
    },
    markSaved(): void {
      saved.value = { state: state.value, metaRev: metaRev.value };
    },
    markSavedAs(s: UndoableState, rev: number): void {
      saved.value = { state: s, metaRev: rev };
    },
    savedState: () => saved.value.state,
    replaceState(next: UndoableState, nextFps: number): void {
      const frozen = freezeState(next);
      see(frozen);
      history.reset(frozen);
      fps.value = nextFps;
      show(history.current);
      saved.value = { state: history.current, metaRev: metaRev.value };
    },
    paths: (): DocPaths => ({ rel: relRef.value, charRel: charRel.value, name: name.value }),
    runIo<T>(op: (paths: DocPaths) => Promise<T>): Promise<T> {
      return doc.io.run(() => op(doc.paths()));
    },
    noteCreatedImage(imageUid: string): void {
      created.add(imageUid);
      candidates.add(imageUid);
    },
    setLocation(nextRel: string): void {
      relRef.value = nextRel;
      charRel.value = charRelFromAnimRel(nextRel);
      name.value = animNameFromRel(nextRel);
      doc.diskMtime = null;
    },
    dispose(): void {
      offEvict();
    }
  };
  const offEvict = history.onEvict(() => opts.onEvict(doc));
  return markRaw(doc);
}
