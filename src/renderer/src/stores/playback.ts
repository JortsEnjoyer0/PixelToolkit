// Playback store (PlaybackStoreApi; docs/skelanim/skelanim.md "Playback"): the sole owner of each doc's active target
// (REF or a track frame uid, never an index) and the play loop of the active doc. Logic lives in
// stores/job/playbackCore.ts.
// - target(docId): REF by default; a vanished frame uid resolves to the frame now at its last index, or REF.
// - play() loops the active doc over frames 1..N at doc.fps (from REF it starts at frame 1); switching the active
//   tab, emptying the track, step() and the seeks pause it. setTarget() to a frame keeps playing from there.
import { defineStore } from 'pinia';
import { createPlayback } from './job/playbackCore';
import { useDocumentsStore } from './documents';
import { useTabsStore } from './tabs';
import type { DocHandle, PlaybackStoreApi } from './types';

const NO_DOCS: ReadonlyMap<string, DocHandle> = new Map();

export const usePlaybackStore = defineStore('playback', () => {
  // Resolved lazily (and tolerant of a store still running its setup), so documents / tabs may use this store in theirs
  const core = createPlayback({
    docs: () => useDocumentsStore().docs ?? NO_DOCS,
    activeDocId: () => useTabsStore().activeDocId ?? null
  });
  return {
    playing: core.playing,
    target: core.target,
    setTarget: core.setTarget,
    play: core.play,
    pause: core.pause,
    toggle: core.toggle,
    step: core.step,
    seekStart: core.seekStart,
    seekEnd: core.seekEnd,
    forget: core.forget
  };
});

/** The store typed as its public API (also a compile-time check that it satisfies PlaybackStoreApi). */
export function usePlaybackApi(): PlaybackStoreApi {
  return usePlaybackStore();
}
