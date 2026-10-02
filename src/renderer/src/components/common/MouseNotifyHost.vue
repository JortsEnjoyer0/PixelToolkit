<script setup lang="ts">
// Renders services/mouseNotify (mounted once in App.vue): a small pill just above-right of the pointer that rises
// ~24 px over NOTE_LIFETIME_MS and fades out near the end. Notes created close together stack: older ones are
// bumped up one slot per newer neighbour, so they never overlap. Kept inside the viewport; pointer-events none.
import { computed } from 'vue';
import { clamp } from '../../core/util/math';
import { mouseNotifyState, NOTE_LIFETIME_MS, type MouseNote } from '../../services/mouseNotify';

const SLOT_PX = 24;
const NEAR_PX = 64;
const OFFSET_X = 12;
const MARGIN_PX = 6;
/** Rise distance plus the gap to the pointer: the room a note needs above its anchor. */
const HEADROOM_PX = 24 + 8;

const near = (a: MouseNote, b: MouseNote): boolean => Math.abs(a.x - b.x) < NEAR_PX * 2 && Math.abs(a.y - b.y) < NEAR_PX;

const items = computed(() => {
  const notes = mouseNotifyState.notes;
  return notes.map((note, i) => {
    let slot = 0;
    for (let j = i + 1; j < notes.length; j++) {
      if (near(note, notes[j]))
        slot++;
    }
    return { note, slot };
  });
});

/** Function ref: keep the pill inside the viewport once its size is known. */
function clampNote(el: unknown, note: MouseNote): void {
  if (!(el instanceof HTMLElement))
    return;
  const pill = el.firstElementChild as HTMLElement | null;
  const w = pill?.offsetWidth ?? 0;
  const h = pill?.offsetHeight ?? 0;
  // The low bounds win when the pill does not fit (it stays on screen at the top-left)
  const minTop = h + HEADROOM_PX + MARGIN_PX;
  const left = clamp(note.x + OFFSET_X, MARGIN_PX, window.innerWidth - MARGIN_PX - w);
  const top = clamp(note.y, minTop, window.innerHeight - MARGIN_PX);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
</script>

<template>
  <div
    class="mouse-note-layer"
    aria-live="polite"
  >
    <div
      v-for="{ note, slot } in items"
      :key="note.id"
      :ref="(el) => clampNote(el, note)"
      class="mouse-note-anchor"
      :style="{ transform: `translateY(${-slot * SLOT_PX}px)` }"
    >
      <div
        class="mouse-note"
        :style="{ animationDuration: `${NOTE_LIFETIME_MS}ms` }"
      >
        {{ note.text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.mouse-note-layer {
  position: fixed;
  inset: 0;
  z-index: var(--z-mouse-notify);
  overflow: hidden;
  pointer-events: none;
}

.mouse-note-anchor {
  position: absolute;
  width: 0;
  height: 0;
  transition: transform 140ms var(--ease);
}

.mouse-note {
  position: absolute;
  left: 0;
  bottom: 8px;
  padding: 3px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-round);
  background: var(--note-bg);
  backdrop-filter: blur(6px);
  box-shadow: var(--shadow-sm);
  color: var(--text);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  line-height: 1.35;
  white-space: nowrap;
  animation-name: ptk-mouse-note;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

@keyframes ptk-mouse-note {
  0% {
    opacity: 0;
    transform: translateY(2px);
  }

  8% {
    opacity: 1;
  }

  70% {
    opacity: 1;
  }

  100% {
    opacity: 0;
    transform: translateY(-24px);
  }
}
</style>
