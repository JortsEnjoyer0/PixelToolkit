<script setup lang="ts">
// Image input box for Img to PixelArt sub-tools: the image thumbnail (pixelated, contained, on the checkerboard) or a
// placeholder, with name and size below. Never touches window.api: a click (Enter / Space) emits 'browse', a dropped
// file emits 'file' (the first image among the dropped files). Drag-over highlight; `loading` shows a spinner over it.
// Ctrl+V pasting is the owner's (imageSources.ts useImagePaste), as it works anywhere in the tool.
import { computed, ref } from 'vue';
import { ImagePlus } from '@lucide/vue';
import Spinner from '../../components/common/Spinner.vue';
import { pickDroppedFile } from './imageSources';

const props = withDefaults(defineProps<{
  /** The image shown: an <img> URL, its name and size in px. */
  image: { url: string; name: string; width: number; height: number } | null;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
}>(), { placeholder: 'Click to open, drop or paste an image' });

const emit = defineEmits<{ browse: []; file: [file: File] }>();

/** dragenter / dragleave also fire for the box's children: count them. */
const dragDepth = ref(0);
const dragOver = computed(() => dragDepth.value > 0);
const tooltip = computed(() => props.image ? 'Open another image (or drop / paste one)' : '');

const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files');

/** Known non-image types are refused while dragging; an unknown type is let through (decoding says why). */
function acceptable(e: DragEvent): boolean {
  if (props.disabled || !carriesFiles(e))
    return false;
  const items = [...e.dataTransfer?.items ?? []].filter((i) => i.kind === 'file');
  return items.length === 0 || items.some((i) => i.type === '' || i.type.startsWith('image/'));
}

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
    e.dataTransfer.dropEffect = acceptable(e) ? 'copy' : 'none';
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
  if (props.disabled)
    return;
  const file = pickDroppedFile(e.dataTransfer?.files);
  if (file)
    emit('file', file);
}
</script>

<template>
  <div class="image-input col gap-1">
    <button
      v-tooltip="tooltip"
      type="button"
      class="image-input-box"
      :class="{ checker: !!image, 'is-empty': !image, 'is-dragover': dragOver }"
      :disabled="disabled"
      :aria-busy="loading || undefined"
      :aria-label="image ? `Image ${image.name}: open another` : placeholder"
      @click="emit('browse')"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <img
        v-if="image"
        class="pixelated"
        :src="image.url"
        :alt="image.name"
        draggable="false"
      >
      <span
        v-else
        class="image-input-placeholder col items-center gap-2"
      >
        <ImagePlus
          :size="24"
          :stroke-width="1.5"
        />
        <span>{{ placeholder }}</span>
      </span>
      <span
        v-if="loading"
        class="image-input-busy"
      >
        <Spinner
          :size="20"
          label="Loading image"
        />
      </span>
    </button>
    <div
      v-if="image"
      class="row gap-2 text-xs"
    >
      <span
        v-tooltip="image.name"
        class="truncate"
      >{{ image.name }}</span>
      <span class="ml-auto shrink-0 tabular text-dim">{{ image.width }} × {{ image.height }} px</span>
    </div>
  </div>
</template>

<style scoped>
.image-input-box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 168px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--speed-fast) var(--ease), background-color var(--speed-fast) var(--ease);
}

.image-input-box.is-empty {
  border-style: dashed;
  border-color: var(--border-strong);
  background: var(--bg-0);
  color: var(--text-faint);
}

.image-input-box:hover:not(:disabled) {
  border-color: var(--control-border-hover);
}

.image-input-box.is-empty:hover:not(:disabled) {
  color: var(--text-dim);
}

.image-input-box.is-dragover {
  border-style: solid;
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.image-input-box.is-empty.is-dragover {
  background: var(--accent-dim);
  color: var(--text);
}

.image-input-box:disabled {
  cursor: default;
  opacity: var(--disabled-opacity);
}

.image-input-box > img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.image-input-placeholder {
  max-width: 180px;
  font-size: var(--font-size-sm);
  line-height: 1.35;
  pointer-events: none;
}

.image-input-busy {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-overlay);
  color: var(--text);
}
</style>
