<script setup lang="ts">
// "Rectified Image" dialog (opened by previewDialog.ts): the rectified pixel art in a 'pow2' CanvasView (wheel zooms
// 1×, 2×, 4× … device px per image px, MMB pans in whole device px, so an output pixel is never cut), the reset button
// (top right, only while the view is not the default 1×, centred), an info line (size, colours, zoom) and Save…, which
// writes a PNG through files.savePng. The dialog stays open after a save: the path shows in the footer; a failed save
// shows its error there.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { RotateCcw } from '@lucide/vue';
import DialogFrame from '../../../components/common/DialogFrame.vue';
import IconButton from '../../../components/common/IconButton.vue';
import Spinner from '../../../components/common/Spinner.vue';
import type { RectifyResult } from '../../../core/pixelart/rectify';
import { errorMessage } from '../../../services/errors';
import { mouseNotify } from '../../../services/mouseNotify';
import { CanvasView, imageCanvas } from '../view/CanvasView';

const props = defineProps<{ result: RectifyResult; sourceName: string }>();
const emit = defineEmits<{ cancel: [] }>();

const hostEl = ref<HTMLElement | null>(null);
const zoom = ref(1);
const atHome = ref(true);
const saving = ref(false);
const savedPath = ref('');
const saveError = ref('');

// Non-reactive: the canvas view
let view: CanvasView | null = null;

const image = computed(() => props.result.image);
const colorText = computed(() => `${props.result.colorCount} colour${props.result.colorCount === 1 ? '' : 's'}`);
const suggestedName = computed(() => {
  const base = props.sourceName.replace(/\.[^.\\/]+$/, '') || 'image';
  return `${base}_${image.value.width}x${image.value.height}.png`;
});

onMounted(() => {
  const v = new CanvasView({
    policy: 'pow2',
    home: 'actual',
    viewChange: (cv) => {
      zoom.value = cv.zoom;
      atHome.value = cv.isHomeView();
    }
  });
  v.mount(hostEl.value!);
  const img = image.value;
  v.setContent(imageCanvas(img), img.width, img.height);
  view = v;
});

onBeforeUnmount(() => {
  view?.dispose();
  view = null;
});

function resetView(): void {
  view?.resetView();
}

async function save(): Promise<void> {
  if (saving.value)
    return;
  saving.value = true;
  saveError.value = '';
  try {
    const img = image.value;
    const path = await window.api.files.savePng({ width: img.width, height: img.height, data: img.data.slice() }, suggestedName.value);
    if (path) {
      savedPath.value = path;
      mouseNotify('Saved');
    }
  } catch (e) {
    saveError.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <DialogFrame
    title="Rectified Image"
    size="xl"
    @close="emit('cancel')"
  >
    <div class="canvas-view rectify-preview-view">
      <div
        ref="hostEl"
        class="abs-fill"
      />
      <div class="view-overlay view-overlay-tr">
        <IconButton
          v-if="!atHome"
          class="view-float"
          :icon="RotateCcw"
          tooltip="Reset view (1×, centred)"
          tooltip-placement="left"
          variant="default"
          size="sm"
          @click="resetView"
        />
      </div>
    </div>
    <div class="row gap-3 text-sm text-dim tabular">
      <span>{{ image.width }} × {{ image.height }} px</span>
      <span>{{ colorText }}</span>
      <span>{{ zoom }}×</span>
      <span class="view-hint">Wheel zoom · MMB pan</span>
    </div>
    <template #footer>
      <div class="dialog-footer-start">
        <span
          v-if="saveError"
          class="text-sm text-danger break-anywhere"
        >{{ saveError }}</span>
        <span
          v-else-if="savedPath"
          v-tooltip="savedPath"
          class="text-sm text-dim truncate"
        >Saved to {{ savedPath }}</span>
      </div>
      <button
        type="button"
        class="btn btn-primary"
        :class="{ 'is-loading': saving }"
        data-dialog-primary
        :disabled="saving"
        @click="save"
      >
        <span>Save…</span>
        <Spinner
          v-if="saving"
          class="btn-spinner"
          :size="14"
        />
      </button>
      <button
        type="button"
        class="btn"
        @click="emit('cancel')"
      >
        Close
      </button>
    </template>
  </DialogFrame>
</template>

<style scoped>
.rectify-preview-view {
  height: min(70vh, 640px);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
</style>
