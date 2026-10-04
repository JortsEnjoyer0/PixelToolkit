<script setup lang="ts">
// Rectify To Grid panel (docs/img2pixel/img2pixel.md "UI"), below Img2PixelTool's sub-tool select: Image
// (ImageInput: open dialog or drop; Ctrl+V pastes while this panel is shown), Pixel Grid (estimate, pixel size with
// ½ / ×2, offsets wrapped into [0, size), output size), Output (the rectify options incl. Max colours, persisted in the
// workspace) and the pinned footer whose Rectify Image opens the output preview (previewDialog.ts). Everything lives in
// the rectify store.
import { computed, ref } from 'vue';
import { Grid2x2Check, Info, ScanSearch } from '@lucide/vue';
import { MAX_IMAGE_SIDE } from '@shared/image';
import Checkbox from '../../../components/common/Checkbox.vue';
import NumberSlider from '../../../components/common/NumberSlider.vue';
import Spinner from '../../../components/common/Spinner.vue';
import StepSlider from '../../../components/common/StepSlider.vue';
import { MAX_GRID_SIZE, MIN_GRID_SIZE, OFFSET_DECIMALS, SIZE_DECIMALS } from '../../../core/pixelart/grid';
import { COLOR_LIMITS } from '../../../core/pixelart/quantize';
import { reportError } from '../../../services/errors';
import { mouseNotify } from '../../../services/mouseNotify';
import { useRectifyStore } from '../../../stores/rectify';
import ImageInput from '../ImageInput.vue';
import { useImagePaste } from '../imageSources';
import { openRectifyPreview } from './previewDialog';

/** Field steps (the last kept decimal) and the coarser arrow-key / wheel steps (Shift ×10). */
const SIZE_STEP = 10 ** -SIZE_DECIMALS;
const SIZE_NUDGE = 0.1;
const OFFSET_STEP = 10 ** -OFFSET_DECIMALS;
const OFFSET_NUDGE = 1;

const formatColorLimit = (n: number): string => n === 0 ? '∞' : String(n);

const store = useRectifyStore();
const root = ref<HTMLElement | null>(null);

// ---------- image ----------

const inputImage = computed(() => {
  const src = store.source;
  return src ? { url: src.url, name: src.name, width: src.image.width, height: src.image.height } : null;
});

function load(blob: Blob, name: string, note?: string): void {
  store.loadBlob(blob, name).then(() => {
    if (note)
      mouseNotify(note);
  }, (e: unknown) => reportError(e, `Could not open "${name}"`));
}

function browse(): void {
  store.openFile().catch((e: unknown) => reportError(e, 'Could not open the image'));
}

function onDropped(file: File): void {
  load(file, file.name);
}

useImagePaste(root, (file) => load(file, file.name || 'Pasted image', 'Pasted image'));

// ---------- pixel grid ----------

const estimateTip = computed(() => store.source
  ? 'Find the fake-pixel size and the grid offset'
  : 'Open an image first');

function estimate(): void {
  store.runEstimate().then(() => {
    const est = store.lastEstimate;
    if (est)
      mouseNotify(`Pixel size ${store.grid.size.toFixed(SIZE_DECIMALS)} px`);
  }, (e: unknown) => reportError(e, 'Could not estimate the pixel grid'));
}

/** The estimator found no grid at all (confidence 0 = its fallback size); otherwise confidence is only relative. */
const noGridFound = computed(() => store.lastEstimate?.confidence === 0);

/** ×2 / ½: the one-click fix when the estimate locked onto half or twice the fake-pixel size. */
function scaleSize(factor: number): void {
  store.setGrid({ size: store.grid.size * factor });
}

const outputText = computed(() => {
  const out = store.outputSize;
  return out ? `${out.width} × ${out.height} px` : 'no image';
});

// ---------- rectify ----------

const hasCells = computed(() => !!store.outputSize && store.outputSize.width > 0 && store.outputSize.height > 0);
const rectifyTip = computed(() => {
  if (!store.source)
    return 'Open an image first';
  if (!hasCells.value)
    return 'The grid has no cells inside the image';
  return 'One pixel per grid cell; opens the result';
});

function rectifyNow(): void {
  const src = store.source;
  if (!src)
    return;
  store.rectify().then((result) => result ? openRectifyPreview(result, src.name) : undefined)
    .catch((e: unknown) => reportError(e, `Could not rectify "${src.name}"`));
}
</script>

<template>
  <div
    ref="root"
    class="col flex-1"
  >
    <div class="panel-body">
      <!-- Image -->
      <section class="section">
        <div class="section-header">
          Image
        </div>
        <div class="section-body">
          <ImageInput
            :image="inputImage"
            :loading="store.loading"
            @browse="browse"
            @file="onDropped"
          />
        </div>
      </section>

      <!-- Pixel grid -->
      <section class="section">
        <div class="section-header">
          Pixel Grid
        </div>
        <div class="section-body">
          <button
            v-tooltip="estimateTip"
            type="button"
            class="btn w-full"
            :class="{ 'is-loading': store.estimating }"
            :disabled="!store.source || store.estimating"
            :aria-busy="store.estimating || undefined"
            @click="estimate"
          >
            <ScanSearch :size="14" />
            <span>Estimate pixel grid</span>
            <Spinner
              v-if="store.estimating"
              class="btn-spinner"
              :size="14"
            />
          </button>
          <div
            v-if="noGridFound"
            class="notice notice-info"
          >
            <Info :size="14" />
            <span>No pixel grid found in this image. Set the pixel size by hand.</span>
          </div>
          <div class="form-grid">
            <span class="form-label">Pixel size</span>
            <div class="form-control">
              <NumberSlider
                :model-value="store.grid.size"
                :min="MIN_GRID_SIZE"
                :max="MAX_GRID_SIZE"
                :step="SIZE_STEP"
                :nudge="SIZE_NUDGE"
                :precision="SIZE_DECIMALS"
                :slider="false"
                :input-width="64"
                wheel
                label="Pixel size in image px"
                @update:model-value="store.setGrid({ size: $event })"
              />
              <span class="text-sm text-dim">px</span>
              <div class="btn-group ml-auto">
                <button
                  v-tooltip="'Halve the pixel size'"
                  type="button"
                  class="btn btn-sm btn-icon"
                  :disabled="store.grid.size / 2 < MIN_GRID_SIZE"
                  @click="scaleSize(0.5)"
                >
                  ½
                </button>
                <button
                  v-tooltip="'Double the pixel size'"
                  type="button"
                  class="btn btn-sm btn-icon"
                  :disabled="store.grid.size * 2 > MAX_GRID_SIZE"
                  @click="scaleSize(2)"
                >
                  ×2
                </button>
              </div>
            </div>
            <span class="form-label">Offset X</span>
            <div class="form-control">
              <NumberSlider
                :model-value="store.grid.offsetX"
                :min="-MAX_IMAGE_SIDE"
                :max="MAX_IMAGE_SIDE"
                :step="OFFSET_STEP"
                :nudge="OFFSET_NUDGE"
                :precision="OFFSET_DECIMALS"
                :slider="false"
                :input-width="64"
                wheel
                label="Grid offset X in image px"
                @update:model-value="store.setGrid({ offsetX: $event })"
              />
              <span class="text-sm text-dim">px</span>
            </div>
            <span class="form-label">Offset Y</span>
            <div class="form-control">
              <NumberSlider
                :model-value="store.grid.offsetY"
                :min="-MAX_IMAGE_SIDE"
                :max="MAX_IMAGE_SIDE"
                :step="OFFSET_STEP"
                :nudge="OFFSET_NUDGE"
                :precision="OFFSET_DECIMALS"
                :slider="false"
                :input-width="64"
                wheel
                label="Grid offset Y in image px"
                @update:model-value="store.setGrid({ offsetY: $event })"
              />
              <span class="text-sm text-dim">px</span>
            </div>
            <span class="form-label">Output</span>
            <span
              class="text-sm tabular"
              :class="{ 'text-faint': !store.outputSize }"
            >{{ outputText }}</span>
          </div>
          <p class="form-hint">
            Drag the grid or use the arrow keys in the view.
          </p>
        </div>
      </section>

      <!-- Output -->
      <section class="section">
        <div class="section-header">
          Output
        </div>
        <div class="section-body col gap-1">
          <Checkbox
            v-tooltip="'Make every cell of the detected solid background colour transparent'"
            :model-value="store.options.removeBackground"
            label="Remove background"
            @update:model-value="store.setOptions({ removeBackground: $event })"
          />
          <Checkbox
            v-tooltip="'Merge near-identical shades (noise) into one colour'"
            :model-value="store.options.mergeColors"
            label="Merge similar colours"
            @update:model-value="store.setOptions({ mergeColors: $event })"
          />
          <Checkbox
            v-tooltip="'Let each cell follow nearby fake-pixel edges, for sprites offset from the grid (sprite sheets); the output size stays the same'"
            :model-value="store.options.snapToEdges"
            label="Snap to pixel edges"
            @update:model-value="store.setOptions({ snapToEdges: $event })"
          />
          <Checkbox
            v-tooltip="'Pad the output to a square with the background colour (transparent when removing it)'"
            :model-value="store.options.makeSquare"
            label="Make square"
            @update:model-value="store.setOptions({ makeSquare: $event })"
          />
          <div
            v-tooltip="'Reduce the output to at most this many colours (∞ keeps them all); a kept background colour counts'"
            class="field mt-2"
          >
            <span class="field-label">Max colours</span>
            <StepSlider
              :model-value="store.options.maxColors"
              :values="COLOR_LIMITS"
              :format="formatColorLimit"
              label="Max colours"
              @update:model-value="store.setOptions({ maxColors: $event })"
            />
          </div>
        </div>
      </section>
    </div>
    <footer class="panel-footer">
      <button
        v-tooltip="rectifyTip"
        type="button"
        class="btn btn-primary btn-lg w-full"
        :disabled="!hasCells || store.rectifying"
        :aria-busy="store.rectifying || undefined"
        @click="rectifyNow"
      >
        <Spinner
          v-if="store.rectifying"
          :size="14"
        />
        <Grid2x2Check
          v-else
          :size="15"
        />
        <span>Rectify Image</span>
      </button>
    </footer>
  </div>
</template>
