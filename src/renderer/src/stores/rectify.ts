// Rectify store (RectifyStoreApi; docs/img2pixel/img2pixel.md "State and persistence"): Img to PixelArt's Rectify To
// Grid. Holds the source image (a markRaw SourceImage in a shallowRef: pixels and bitmap are never reactive; the old
// object URL is revoked and the old bitmap closed when it is replaced), the pixel grid (frozen, always
// normalizeGrid'ed), the last estimate and the busy flags. The output options live in the workspace (img2pixel.rectify). Nothing is written to
// data/: images come in through files.openImage, drops and pastes, and leave through the preview's files.savePng.
import { defineStore } from 'pinia';
import { computed, markRaw, onScopeDispose, ref, shallowRef } from 'vue';
import { decodeImageBlob } from '../core/pixelart/decode';
import { estimateGrid } from '../core/pixelart/estimate';
import { normalizeGrid, outputSize as gridOutputSize, type GridEstimate, type GridSpec } from '../core/pixelart/grid';
import { rectify as rectifyImage, type RectifyOptions, type RectifyResult } from '../core/pixelart/rectify';
import { useWorkspaceStore } from './workspace';
import type { RectifyStoreApi, SourceImage } from './types';

/** The grid before any image or estimate. A new image keeps the current grid. */
export const DEFAULT_GRID: Readonly<GridSpec> = Object.freeze({ size: 16, offsetX: 0, offsetY: 0 });

/** Resolves after the next paint, so a spinner shows before synchronous work blocks the thread. */
const afterPaint = (): Promise<void> => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
});

export const useRectifyStore = defineStore('rectify', () => {
  const workspace = useWorkspaceStore();
  const source = shallowRef<SourceImage | null>(null);
  const grid = shallowRef<Readonly<GridSpec>>(DEFAULT_GRID);
  const lastEstimate = shallowRef<GridEstimate | null>(null);
  const loading = ref(false);
  const estimating = ref(false);
  const rectifying = ref(false);
  /** Bumped by every load: only the newest one adopts its image. */
  let loadSeq = 0;

  const options = computed<Readonly<RectifyOptions>>(() => workspace.state.img2pixel.rectify);
  const outputSize = computed(() => {
    const img = source.value?.image;
    return img ? gridOutputSize(img.width, img.height, grid.value, options.value.makeSquare) : null;
  });

  function release(src: SourceImage | null): void {
    if (src) {
      URL.revokeObjectURL(src.url);
      src.bitmap.close();
    }
  }

  /** The grid (always normalized) stays as it is: images from one generator tend to share a pixel size. */
  function adopt(next: SourceImage): void {
    const old = source.value;
    source.value = markRaw(next);
    lastEstimate.value = null;
    release(old);
  }

  async function loadBlob(blob: Blob, name: string): Promise<void> {
    const seq = ++loadSeq;
    loading.value = true;
    try {
      const { image, bitmap } = await decodeImageBlob(blob, name);
      if (seq !== loadSeq) {
        bitmap.close();
        return;
      }
      adopt({ name, image, bitmap, url: URL.createObjectURL(blob) });
    } catch (e) {
      // A newer load superseded this one: its failure no longer matters
      if (seq === loadSeq)
        throw e;
    } finally {
      if (seq === loadSeq)
        loading.value = false;
    }
  }

  async function openFile(): Promise<void> {
    const file = await window.api.files.openImage();
    if (file)
      await loadBlob(new Blob([file.bytes as Uint8Array<ArrayBuffer>]), file.name);
  }

  async function runEstimate(): Promise<void> {
    const src = source.value;
    if (!src || estimating.value)
      return;
    estimating.value = true;
    try {
      await afterPaint();
      if (source.value !== src)
        return;
      const est = estimateGrid(src.image);
      lastEstimate.value = Object.freeze({ ...est });
      grid.value = Object.freeze(normalizeGrid(est));
    } finally {
      estimating.value = false;
    }
  }

  function setGrid(patch: Partial<GridSpec>): void {
    const next = normalizeGrid({ ...grid.value, ...patch });
    const cur = grid.value;
    if (next.size !== cur.size || next.offsetX !== cur.offsetX || next.offsetY !== cur.offsetY)
      grid.value = Object.freeze(next);
  }

  function nudge(dx: number, dy: number): void {
    setGrid({ offsetX: grid.value.offsetX + dx, offsetY: grid.value.offsetY + dy });
  }

  function setOptions(patch: Partial<RectifyOptions>): void {
    const img2pixel = workspace.state.img2pixel;
    workspace.update({ img2pixel: { ...img2pixel, rectify: { ...img2pixel.rectify, ...patch } } });
  }

  async function rectify(): Promise<RectifyResult | null> {
    const src = source.value;
    if (!src || rectifying.value)
      return null;
    rectifying.value = true;
    try {
      await afterPaint();
      return rectifyImage(src.image, grid.value, options.value);
    } finally {
      rectifying.value = false;
    }
  }

  onScopeDispose(() => release(source.value));

  return {
    source, grid, options, lastEstimate, loading, estimating, rectifying, outputSize,
    loadBlob, openFile, runEstimate, setGrid, nudge, setOptions, rectify
  };
});

/** The store typed as its public API (also a compile-time check that it satisfies RectifyStoreApi). */
export function useRectifyApi(): RectifyStoreApi {
  return useRectifyStore();
}
