<script setup lang="ts">
// The character's base images as checker thumbnails (pick one as the animation's reference) plus "Import PNG…".
// Picking only emits; the panel copies the file into the animation and applies the new reference. When the character
// failed to load, an error with Retry replaces the loading row.
import { ImageUp, RefreshCw } from '@lucide/vue';
import { assetUrl } from '@shared/api';
import { baseImageRel } from '@shared/dataPaths';
import type { BaseImage, CharacterMeta } from '../../../core/model';
import Spinner from '../../../components/common/Spinner.vue';

defineProps<{
  charRel: string;
  /** null while the character json loads (or when it failed). */
  character: CharacterMeta | null;
  /** Loading the character failed (shows the error and Retry instead of the loading row). */
  failed?: boolean;
  /** reference.sourceBaseUid (highlighted). */
  selectedUid: string | null;
  disabled?: boolean;
  /** A pick / import is in progress. */
  busy?: boolean;
}>();

const emit = defineEmits<{ pick: [base: BaseImage]; import: []; retry: [] }>();

const tip = (b: BaseImage, i: number): string =>
  `${b.label || `Base image ${i + 1}`} · ${b.width}×${b.height}${b.direction ? ` · facing ${b.direction}` : ''}`;
</script>

<template>
  <div class="reference-picker col gap-2">
    <div
      v-if="character && character.baseImages.length"
      class="reference-picker-grid"
      role="listbox"
      aria-label="Character base images"
    >
      <button
        v-for="(b, i) in character.baseImages"
        :key="b.uid"
        v-tooltip="tip(b, i)"
        type="button"
        class="reference-tile"
        :class="{ 'is-selected': b.uid === selectedUid }"
        role="option"
        :aria-selected="b.uid === selectedUid"
        :disabled="disabled || busy"
        @click="emit('pick', b)"
      >
        <span class="reference-tile-image checker">
          <img
            class="pixelated"
            :src="assetUrl(baseImageRel(charRel, b.uid))"
            :alt="b.label"
            draggable="false"
          >
        </span>
        <span class="reference-tile-label truncate">{{ b.label || `#${i + 1}` }}</span>
      </button>
    </div>
    <p
      v-else-if="character"
      class="form-hint"
    >
      This character has no base images yet (add them in the character dialog), or import a PNG.
    </p>
    <div
      v-else-if="failed"
      class="row gap-2 items-center"
    >
      <span class="form-error flex-1">Could not load the character's base images.</span>
      <button
        type="button"
        class="btn btn-sm"
        @click="emit('retry')"
      >
        <RefreshCw :size="14" />
        Retry
      </button>
    </div>
    <div
      v-else
      class="row gap-2 text-faint text-sm"
    >
      <Spinner :size="12" />
      Loading base images…
    </div>
    <div class="row gap-2">
      <button
        type="button"
        class="btn btn-sm"
        :disabled="disabled || busy"
        @click="emit('import')"
      >
        <ImageUp :size="14" />
        Import PNG…
      </button>
      <Spinner
        v-if="busy"
        :size="12"
      />
    </div>
  </div>
</template>

<style scoped>
.reference-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
  gap: var(--space-1);
}

.reference-tile {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  min-width: 0;
  padding: 3px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-dim);
}

.reference-tile:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.reference-tile.is-selected {
  border-color: var(--accent);
  background: var(--accent-dim);
  color: var(--text);
}

.reference-tile:disabled {
  opacity: var(--disabled-opacity);
}

.reference-tile-image {
  display: block;
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.reference-tile-image > img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.reference-tile-label {
  font-size: var(--font-size-xs);
  text-align: center;
}
</style>
