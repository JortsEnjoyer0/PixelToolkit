// Playback logic behind stores/playback.ts (PlaybackStoreApi), store-free so it can be driven by a test with mock docs
// and a fake requestAnimationFrame. Reactive state holds only doc ids and small FrameTarget objects, never DocHandles.
import { ref, shallowReactive, watch, watchSyncEffect, type Ref } from 'vue';
import { DEFAULT_FPS, type FrameData, type FrameTarget } from '../../core/model';
import { clamp } from '../../core/util/math';
import type { DocHandle } from '../types';

export interface PlaybackDeps {
  /** Open docs by id (reactive map; read on every call). */
  docs(): ReadonlyMap<string, DocHandle>;
  /** The active tab's doc id: the only doc that plays. */
  activeDocId(): string | null;
  raf?: (cb: (t: number) => void) => number;
  caf?: (handle: number) => void;
}

export interface PlaybackCore {
  playing: Readonly<Ref<boolean>>;
  target(docId: string): FrameTarget;
  setTarget(docId: string, target: FrameTarget): void;
  play(): void;
  pause(): void;
  toggle(): void;
  step(delta: 1 | -1): void;
  seekStart(): void;
  seekEnd(): void;
  /** Drop a closed doc's target (the store does this when a doc leaves the documents map). */
  forget(docId: string): void;
}

export const REF_TARGET: FrameTarget = Object.freeze({ kind: 'ref' });

/** A dt above this (window hidden, debugger, long task) counts as one frame, never a fast-forward. */
const MAX_DT_MS = 250;
const MIN_FPS = 1;
const MAX_FPS = 60;

const frameTarget = (uid: string): FrameTarget => Object.freeze({ kind: 'frame', uid });

const playFps = (fps: number): number => Number.isFinite(fps) && fps > 0 ? clamp(fps, MIN_FPS, MAX_FPS) : DEFAULT_FPS;

export function createPlayback(deps: PlaybackDeps): PlaybackCore {
  const raf = deps.raf ?? ((cb: (t: number) => void): number => requestAnimationFrame(cb));
  const caf = deps.caf ?? ((h: number): void => cancelAnimationFrame(h));

  /** Stored targets per doc (absent = REF). Normalized when frames vanish (see the sync effect below). */
  const targets = shallowReactive(new Map<string, FrameTarget>());
  /** Last index where each doc's frame target was found: a vanished uid resolves to the frame now at that index. */
  const lastIndex = new Map<string, number>();
  const playing = ref(false);

  let playDocId: string | null = null;
  let rafId = 0;
  let lastT = -1;
  let acc = 0;

  const doc = (docId: string): DocHandle | undefined => deps.docs().get(docId);
  const activeDoc = (): DocHandle | undefined => {
    const id = deps.activeDocId();
    return id === null ? undefined : doc(id);
  };

  /** The stored target if its frame still exists, else the frame at its last index (clamped), else REF. */
  function resolve(docId: string, t: FrameTarget, frames: readonly FrameData[]): FrameTarget {
    if (t.kind === 'ref')
      return REF_TARGET;
    const i = frames.findIndex((f) => f.uid === t.uid);
    if (i >= 0) {
      lastIndex.set(docId, i);
      return t;
    }
    if (frames.length === 0)
      return REF_TARGET;
    const j = Math.min(lastIndex.get(docId) ?? 0, frames.length - 1);
    return frameTarget(frames[j].uid);
  }

  function target(docId: string): FrameTarget {
    const t = targets.get(docId) ?? REF_TARGET;
    const d = doc(docId);
    return d ? resolve(docId, t, d.state.value.frames) : t;
  }

  /** Store without touching playback (the tick, step and seeks use this). */
  function store(docId: string, t: FrameTarget): void {
    if (t.kind === 'ref') {
      targets.delete(docId);
      lastIndex.delete(docId);
      return;
    }
    const cur = targets.get(docId);
    if (cur?.kind === 'frame' && cur.uid === t.uid)
      return;
    const frozen = Object.isFrozen(t) ? t : frameTarget(t.uid);
    const frames = doc(docId)?.state.value.frames;
    const i = frames ? frames.findIndex((f) => f.uid === t.uid) : -1;
    if (i >= 0)
      lastIndex.set(docId, i);
    targets.set(docId, frozen);
  }

  /** Index of the doc's current target: -1 = REF. */
  function currentIndex(d: DocHandle): number {
    const t = target(d.id);
    return t.kind === 'ref' ? -1 : d.state.value.frames.findIndex((f) => f.uid === t.uid);
  }

  function stopLoop(): void {
    if (rafId !== 0)
      caf(rafId);
    rafId = 0;
  }

  function pause(): void {
    stopLoop();
    playDocId = null;
    if (playing.value)
      playing.value = false;
  }

  function tick(t: number): void {
    rafId = 0;
    const d = activeDoc();
    if (!playing.value || !d || d.id !== playDocId) {
      pause();
      return;
    }
    const frames = d.state.value.frames;
    if (frames.length === 0) {
      pause();
      return;
    }
    const frameMs = 1000 / playFps(d.fps.value);
    let dt = lastT < 0 ? 0 : t - lastT;
    if (dt < 0 || dt > MAX_DT_MS)
      dt = frameMs;
    lastT = t;
    acc += dt;
    let steps = 0;
    while (acc >= frameMs) {
      acc -= frameMs;
      steps++;
    }
    if (steps > 0) {
      const i = currentIndex(d); // REF (-1) + 1 → frame 1
      const next = ((i + steps) % frames.length + frames.length) % frames.length;
      store(d.id, frameTarget(frames[next].uid));
    }
    rafId = raf(tick);
  }

  function play(): void {
    const d = activeDoc();
    if (playing.value || !d)
      return;
    const frames = d.state.value.frames;
    if (frames.length === 0)
      return;
    if (currentIndex(d) < 0)
      store(d.id, frameTarget(frames[0].uid));
    playDocId = d.id;
    playing.value = true;
    acc = 0;
    lastT = -1;
    stopLoop();
    rafId = raf(tick);
  }

  function toggle(): void {
    if (playing.value)
      pause();
    else
      play();
  }

  /** Public setter: picking REF while playing pauses (REF is not in the loop); picking a frame restarts its timing. */
  function setTarget(docId: string, t: FrameTarget): void {
    store(docId, t);
    if (!playing.value || docId !== playDocId)
      return;
    if (t.kind === 'ref')
      pause();
    else
      acc = 0;
  }

  function step(delta: 1 | -1): void {
    const d = activeDoc();
    pause();
    if (!d)
      return;
    const frames = d.state.value.frames;
    const next = clamp(currentIndex(d) + delta, -1, frames.length - 1);
    store(d.id, next < 0 ? REF_TARGET : frameTarget(frames[next].uid));
  }

  function seekStart(): void {
    const d = activeDoc();
    pause();
    if (d)
      store(d.id, REF_TARGET);
  }

  function seekEnd(): void {
    const d = activeDoc();
    pause();
    if (!d)
      return;
    const frames = d.state.value.frames;
    store(d.id, frames.length > 0 ? frameTarget(frames[frames.length - 1].uid) : REF_TARGET);
  }

  function forget(docId: string): void {
    targets.delete(docId);
    lastIndex.delete(docId);
    if (docId === playDocId)
      pause();
  }

  // Normalize stored targets whose frame vanished (delete, undo, job result) to the nearest remaining frame, so the
  // choice sticks when later edits shift indices. Sync: runs inside doc.apply / undo before anything re-renders.
  watchSyncEffect(() => {
    for (const [docId, t] of targets) {
      const d = doc(docId);
      if (t.kind !== 'frame' || !d)
        continue;
      const r = resolve(docId, t, d.state.value.frames);
      if (r !== t)
        store(docId, r);
    }
  });

  // Only the active doc plays: switching tabs pauses
  watch(() => deps.activeDocId(), () => pause(), { flush: 'sync' });

  // An emptied track pauses at once (the tick would notice on the next frame anyway)
  watch(() => activeDoc()?.state.value.frames.length ?? 0, (n) => {
    if (n === 0)
      pause();
  }, { flush: 'sync' });

  // Closed docs lose their target
  watch(() => [...deps.docs().keys()], (now, before) => {
    for (const id of before) {
      if (!now.includes(id))
        forget(id);
    }
  }, { flush: 'sync' });

  return { playing, target, setTarget, play, pause, toggle, step, seekStart, seekEnd, forget };
}
