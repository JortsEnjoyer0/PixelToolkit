<script lang="ts">
import { ref } from 'vue';

/** Bumped when devicePixelRatio changes (window moved to another monitor, zoom): thumbnails re-rasterize. */
const dprTick = ref(0);
let dprQuery: MediaQueryList | null = null;

function watchDpr(): void {
  if (typeof window === 'undefined' || dprQuery)
    return;
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprQuery.addEventListener('change', () => {
    dprQuery = null;
    dprTick.value++;
    watchDpr();
  }, { once: true });
}
</script>

<script setup lang="ts">
// One frame-track thumbnail (REF when `frame` is null): canvas 2D at devicePixelRatio over the grey CSS checker, with
// the frame image (a faint reference ghost for frames without one), the COCO-18 keypoints PixelLab receives and the
// label.
// Redraws only when the frame object, the reference (REF / ghost) or the projection key changes (direction, view,
// pitch, projection, rig, canvas size), when an image finishes loading, or while the editor's live pose targets it.
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import { assetUrl } from '@shared/api';
import { animImageRel } from '@shared/dataPaths';
import type { Keypoint } from '@shared/pixellab';
import type { FrameData, FrameTarget, Pose, UndoableState } from '../../../core/model';
import type { DocHandle } from '../../../stores/types';
import { THUMB_HEIGHT } from '../../../stores/workspace';
import { isLiveFor, livePose } from '../livePose';
import { REF_TARGET, frameTarget } from './frameOps';
import { getImage, offImage } from './imageCache';
import { drawThumb, thumbCocoKeypoints, thumbKeypoints } from './thumbDraw';

const props = withDefaults(defineProps<{
  doc: DocHandle;
  /** null = the pinned REF slot. */
  frame?: FrameData | null;
  /** 1-based frame number (ignored for REF). */
  index?: number;
  /** Playback target (highlight). */
  active?: boolean;
  /** CSS px; the width follows the canvas aspect. */
  height?: number;
}>(), { frame: null, index: 0, height: THUMB_HEIGHT });

const emit = defineEmits<{ select: [target: FrameTarget]; menu: [e: MouseEvent, target: FrameTarget] }>();

/** Opacity of the reference image behind a frame that has no image of its own. */
const GHOST_ALPHA = 0.28;

const canvasEl = ref<HTMLCanvasElement | null>(null);
const target = computed<FrameTarget>(() => props.frame ? frameTarget(props.frame.uid) : REF_TARGET);
const isRef = computed(() => props.frame === null);
// Primitive inputs first: a new state object then only re-renders this thumbnail when the canvas size really changed
const refW = computed(() => props.doc.state.value.reference.width);
const refH = computed(() => props.doc.state.value.reference.height);
const size = computed(() => ({ w: Math.max(8, Math.round(props.height * refW.value / refH.value)), h: props.height }));

let raf = 0;
let disposed = false;
/** Image uids this thumbnail waits for (unsubscribed on unmount). */
const waiting = new Set<string>();
/** Last committed-pose projection (live poses are never cached: the editor mutates its scratch pose in place). */
let kpCache: { pose: Readonly<Pose>; s: UndoableState; kps: Keypoint[] } | null = null;

const onImageLoaded = (): void => schedule();

function schedule(): void {
  if (!raf && !disposed)
    raf = requestAnimationFrame(draw);
}

function image(uid: string): HTMLImageElement | null {
  const url = assetUrl(animImageRel(props.doc.charRel.value, props.doc.name.value, uid));
  const img = getImage(uid, url, onImageLoaded);
  if (img)
    waiting.delete(uid);
  else
    waiting.add(uid);
  return img;
}

/** Same projection inputs as the cached entry (copy-on-write state: unchanged parts keep their identity). */
function sameProjection(a: UndoableState, b: UndoableState): boolean {
  return a.rig === b.rig && a.projection === b.projection && a.direction === b.direction && a.pitchDeg === b.pitchDeg &&
    a.reference.width === b.reference.width && a.reference.height === b.reference.height;
}

function keypoints(pose: Readonly<Pose>, s: UndoableState): Keypoint[] {
  if (kpCache && kpCache.pose === pose && sameProjection(kpCache.s, s))
    return kpCache.kps;
  const kps = thumbKeypoints(pose, s);
  kpCache = { pose, s, kps };
  return kps;
}

function draw(): void {
  raf = 0;
  const cv = canvasEl.value;
  if (!cv || disposed)
    return;
  const s = props.doc.state.value;
  const r = s.reference;
  const lp = livePose.value;
  const live = isLiveFor(lp, props.doc.id, target.value) ? lp : null;
  const pose = props.frame ? props.frame.pose : r.pose;
  let kps: Keypoint[] | null = null;
  if (live?.coco)
    kps = thumbCocoKeypoints(live.coco, s); // COCO edit drag on REF: the dragged points, before the recalibration
  else if (live?.pose)
    kps = thumbKeypoints(live.pose, s);
  else if (pose)
    kps = keypoints(pose, s);
  const own = props.frame ? props.frame.image : r.image;
  let img: HTMLImageElement | null = null;
  let alpha = 1;
  if (own)
    img = image(own);
  else if (props.frame && r.image) {
    img = image(r.image);
    alpha = GHOST_ALPHA;
  }
  drawThumb(cv, { width: size.value.w, height: size.value.h, image: img, imageAlpha: alpha, keypoints: kps, label: props.frame ? String(props.index) : 'REF' });
}

// Multi-source watch: each source is compared by identity, so unrelated state changes cost one getter call each
const st = (): UndoableState => props.doc.state.value;
watch([
  () => props.doc,
  () => props.frame,
  () => props.frame ? st().reference.image : st().reference,
  () => st().direction,
  () => st().view,
  () => st().pitchDeg,
  () => st().projection,
  () => st().rig,
  () => size.value.w,
  () => size.value.h,
  () => props.index,
  () => props.doc.name.value,
  () => props.doc.charRel.value,
  dprTick
], schedule);

watch(livePose, (lp, old) => {
  if (isLiveFor(lp, props.doc.id, target.value) || isLiveFor(old, props.doc.id, target.value))
    schedule();
});

onMounted(() => {
  watchDpr();
  draw();
});

onBeforeUnmount(() => {
  disposed = true;
  if (raf)
    cancelAnimationFrame(raf);
  for (const uid of waiting)
    offImage(uid, onImageLoaded);
  waiting.clear();
});
</script>

<template>
  <div
    v-tooltip="isRef ? 'Reference pose (sent as the first frame)' : null"
    class="frame-thumb checker"
    :class="{ 'is-active': active, 'is-ref': isRef }"
    :style="{ width: `${size.w}px`, height: `${size.h}px` }"
    :data-frame="frame?.uid ?? 'ref'"
    role="option"
    :aria-selected="active"
    :aria-label="isRef ? 'Reference' : `Frame ${index}`"
    @click="emit('select', target)"
    @contextmenu.prevent.stop="emit('menu', $event, target)"
  >
    <canvas
      ref="canvasEl"
      class="frame-thumb-canvas"
      :style="{ width: `${size.w}px`, height: `${size.h}px` }"
    />
    <span
      v-if="frame?.imageStale"
      v-tooltip="'The pose was edited after this image was generated'"
      class="badge badge-warning frame-thumb-stale"
    >stale</span>
  </div>
</template>

<style scoped>
/* The brief's lighter grey checker (shared .checker pattern) under the transparent canvas */
.frame-thumb {
  --checker-a: var(--thumb-checker-a);
  --checker-b: var(--thumb-checker-b);
  position: relative;
  flex: 0 0 auto;
  border-radius: var(--radius-sm);
  box-shadow: 0 0 0 1px var(--border-strong);
  overflow: hidden;
}

.frame-thumb:hover {
  box-shadow: 0 0 0 1px var(--control-border-hover);
}

.frame-thumb.is-ref {
  box-shadow: 0 0 0 1px var(--accent-muted);
}

.frame-thumb.is-active {
  box-shadow: 0 0 0 2px var(--accent);
}

.frame-thumb-canvas {
  pointer-events: none;
}

.frame-thumb-stale {
  position: absolute;
  top: 3px;
  right: 3px;
  height: 15px;
  padding: 0 4px;
  background: var(--warning-bg);
}
</style>
