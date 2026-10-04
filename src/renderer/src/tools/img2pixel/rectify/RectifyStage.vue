<script setup lang="ts">
// Rectify To Grid's stage (docs/img2pixel/img2pixel.md "UI"; data-zone="img2pixel-stage", focusable): the source image
// with the grid overlay in a GridStageView (MMB pan, wheel zoom, LMB drag moves the grid). Arrow keys nudge the grid by
// 1 image px; an image file dropped here becomes the new source. Overlays: "Fit to view" (top right), a HUD (zoom, image
// px and cell under the cursor) with control hints, and the empty state. Reads and writes only the rectify store. Kept
// alive with the tool: the arrow keys are bound only while it is shown.
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { FolderOpen, ImagePlus, Scan } from '@lucide/vue';
import IconButton from '../../../components/common/IconButton.vue';
import Spinner from '../../../components/common/Spinner.vue';
import { reportError } from '../../../services/errors';
import { shortcuts } from '../../../services/shortcuts';
import { useRectifyStore } from '../../../stores/rectify';
import { pickDroppedFile } from '../imageSources';
import type { CanvasView } from '../view/CanvasView';
import { GridStageView, type GridCursor } from './GridStageView';

const store = useRectifyStore();

const rootEl = ref<HTMLElement | null>(null);
const hostEl = ref<HTMLElement | null>(null);
const zoomText = ref('');
const cursorText = ref('');
/** dragenter / dragleave also fire for children: count them. */
const dragDepth = ref(0);

// Non-reactive: the canvas view
let stage: GridStageView | null = null;

function formatZoom(zoom: number): string {
  const pct = zoom * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function onViewChange(v: CanvasView): void {
  zoomText.value = v.hasContent ? formatZoom(v.zoom) : '';
}

function onCursor(c: GridCursor | null): void {
  if (!c) {
    cursorText.value = '';
    return;
  }
  const cell = c.col !== null && c.row !== null ? ` · cell ${c.col}, ${c.row}` : '';
  cursorText.value = `${c.x}, ${c.y} px${cell}`;
}

watch(() => store.source, (src) => stage?.setSource(src?.bitmap ?? null));
watch(() => ({ ...store.grid }), (g) => stage?.setGrid(g));

onMounted(() => {
  const s = new GridStageView({
    gridDrag: (offsetX, offsetY) => store.setGrid({ offsetX, offsetY }),
    cursor: onCursor,
    viewChange: onViewChange
  });
  s.mount(hostEl.value!);
  s.setGrid(store.grid);
  s.setSource(store.source?.bitmap ?? null);
  stage = s;
});

onBeforeUnmount(() => {
  stage?.dispose();
  stage = null;
});

function fit(): void {
  stage?.view.fitView();
}

function openFile(): void {
  store.openFile().catch((e: unknown) => reportError(e, 'Could not open the image'));
}

// ---------- keyboard and focus ----------

const NUDGES = [['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1]] as const;
let offKeys: (() => void)[] = [];

/** Arrows nudge the grid by 1 image px (declined without an image, so they fall through; ignored mid-drag). */
function bindKeys(): void {
  if (offKeys.length)
    return;
  offKeys = NUDGES.map(([key, dx, dy]) => shortcuts.register('img2pixel-stage', key, () => {
    if (!store.source)
      return false;
    if (!stage?.view.interacting)
      store.nudge(dx, dy);
    return true;
  }));
}

function unbindKeys(): void {
  for (const off of offKeys.splice(0))
    off();
}

// onActivated does not run for a stage mounted inside an already active KeepAlive tree: onMounted covers it
onMounted(bindKeys);
onActivated(() => {
  bindKeys();
  stage?.view.invalidate();
});
onDeactivated(() => {
  unbindKeys();
  stage?.view.cancelGesture();
  dragDepth.value = 0;
});
onBeforeUnmount(unbindKeys);

/**
 * Any press focuses the stage, so the arrows work at once: the mousedown default does it (mouse focus shows no ring),
 * except for MMB, whose default the view prevents (no autoscroll).
 */
function onPointerDown(e: PointerEvent): void {
  const root = rootEl.value;
  if (e.button === 1 && root && document.activeElement !== root)
    root.focus({ preventScroll: true });
}

// ---------- drop an image file ----------

const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files');

function onDragEnter(e: DragEvent): void {
  if (!carriesFiles(e))
    return;
  e.preventDefault();
  dragDepth.value++;
}

function onDragOver(e: DragEvent): void {
  if (!carriesFiles(e))
    return;
  e.preventDefault();
  if (e.dataTransfer)
    e.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(e: DragEvent): void {
  if (carriesFiles(e))
    dragDepth.value = Math.max(0, dragDepth.value - 1);
}

function onDrop(e: DragEvent): void {
  if (!carriesFiles(e))
    return;
  e.preventDefault();
  dragDepth.value = 0;
  const file = pickDroppedFile(e.dataTransfer?.files);
  if (file)
    store.loadBlob(file, file.name).catch((err: unknown) => reportError(err, `Could not open "${file.name}"`));
}
</script>

<template>
  <section
    ref="rootEl"
    class="canvas-view rectify-stage"
    :class="{ 'is-dragover': dragDepth > 0 }"
    data-zone="img2pixel-stage"
    tabindex="0"
    aria-label="Source image with the pixel grid"
    @pointerdown="onPointerDown"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div
      ref="hostEl"
      class="abs-fill"
    />
    <div
      v-if="!store.source"
      class="empty-state abs-fill"
    >
      <ImagePlus
        :size="32"
        :stroke-width="1.5"
      />
      <span class="empty-state-title">No image</span>
      <span>Open an image, drop one here or paste one with Ctrl+V</span>
      <button
        type="button"
        class="btn mt-2"
        :class="{ 'is-loading': store.loading }"
        :disabled="store.loading"
        @click="openFile"
      >
        <FolderOpen :size="14" />
        <span>Open Image…</span>
        <Spinner
          v-if="store.loading"
          class="btn-spinner"
          :size="14"
        />
      </button>
    </div>
    <template v-else>
      <div class="view-overlay view-overlay-tr">
        <IconButton
          class="view-float"
          :icon="Scan"
          tooltip="Fit to view"
          tooltip-placement="left"
          variant="default"
          size="sm"
          @click="fit"
        />
      </div>
      <div class="view-overlay view-overlay-bottom">
        <span
          v-if="zoomText"
          class="view-hud"
        >{{ zoomText }}</span>
        <span
          v-if="cursorText"
          class="view-hud"
        >{{ cursorText }}</span>
        <span class="view-hint">LMB drag moves the grid · MMB pan · Wheel zoom · Arrows nudge 1 px</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.rectify-stage {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
</style>
