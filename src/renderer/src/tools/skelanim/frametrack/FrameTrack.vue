<script setup lang="ts">
// Frame track (data-zone="frametrack"): FrameToolbar over the strip [REF] 1 2 … N [+]. Click selects the playback
// target, the context menu clones / deletes, '+' appends. Keys: Delete (frametrack zone) deletes the active frame,
// Left / Right (editor + frametrack zones) step. The strip keeps the active thumbnail scrolled into view.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { Copy, Plus, Trash2 } from '@lucide/vue';
import { sameTarget } from '../../../core/docState';
import type { FrameTarget } from '../../../core/model';
import { contextMenu } from '../../../services/contextMenu';
import { shortcuts } from '../../../services/shortcuts';
import { usePlaybackStore } from '../../../stores/playback';
import { useTabsStore } from '../../../stores/tabs';
import type { DocHandle } from '../../../stores/types';
import FrameThumb from './FrameThumb.vue';
import FrameToolbar from './FrameToolbar.vue';
import { REF_TARGET, addFrame, canClone, cloneTarget, deleteFrame } from './frameOps';

const props = withDefaults(defineProps<{
  doc: DocHandle;
  /** Thumbnail height, CSS px (width follows the canvas aspect). */
  thumbHeight?: number;
}>(), { thumbHeight: 104 });

const playback = usePlaybackStore();
const tabs = useTabsStore();

const strip = ref<HTMLElement | null>(null);
const frames = computed(() => props.doc.state.value.frames);
const active = computed(() => playback.target(props.doc.id));
const activeKey = computed(() => active.value.kind === 'ref' ? 'ref' : active.value.uid);

const isActive = (t: FrameTarget): boolean => sameTarget(active.value, t);

function select(t: FrameTarget | null): void {
  if (t)
    playback.setTarget(props.doc.id, t);
}

function onSelect(t: FrameTarget): void {
  if (playback.playing)
    playback.pause();
  select(t);
}

function removeFrame(t: FrameTarget): void {
  if (t.kind === 'frame')
    select(deleteFrame(props.doc, t.uid));
}

function onMenu(e: MouseEvent, t: FrameTarget): void {
  onSelect(t);
  const s = props.doc.state.value;
  contextMenu.open(e, [
    { label: t.kind === 'ref' ? 'Clone as Frame 1' : 'Clone', icon: Copy, disabled: !canClone(s, t), action: () => select(cloneTarget(props.doc, t)) },
    { label: 'Delete', icon: Trash2, shortcut: 'Del', danger: t.kind !== 'ref', disabled: t.kind === 'ref', action: () => removeFrame(t) }
  ]);
}

function onStripMenu(e: MouseEvent): void {
  contextMenu.open(e, [{ label: 'Add Frame', icon: Plus, action: () => select(addFrame(props.doc)) }]);
}

/** Vertical wheel scrolls the strip sideways. */
function onWheel(e: WheelEvent): void {
  const box = strip.value;
  if (!box || Math.abs(e.deltaY) <= Math.abs(e.deltaX))
    return;
  box.scrollLeft += e.deltaY;
  e.preventDefault();
}

/** Scroll only the strip (never its ancestors) so the active thumbnail is fully visible. */
function revealActive(): void {
  const box = strip.value;
  const el = box?.querySelector<HTMLElement>('.frame-thumb.is-active');
  if (!box || !el)
    return;
  const pad = 8;
  const left = el.offsetLeft - pad;
  const right = el.offsetLeft + el.offsetWidth + pad;
  if (left < box.scrollLeft)
    box.scrollLeft = left;
  else if (right > box.scrollLeft + box.clientWidth)
    box.scrollLeft = right - box.clientWidth;
}

watch([activeKey, () => frames.value.length, () => props.doc.id], () => {
  void nextTick(revealActive);
}, { immediate: true });

// Keys act on the doc this track shows only while it is the active tab (another instance may be kept alive)
const isCurrent = (): boolean => tabs.activeDocId === props.doc.id;

const offKeys = [
  shortcuts.register('frametrack', 'delete', () => {
    if (!isCurrent() || active.value.kind !== 'frame')
      return false;
    removeFrame(active.value);
    return true;
  }),
  // Blocked mid-drag: changing the target would cancel the gizmo / COCO drag (Escape is the only way to cancel it)
  ...(['editor', 'frametrack'] as const).flatMap((zone) => [
    shortcuts.register(zone, 'left', () => {
      if (!isCurrent())
        return false;
      playback.step(-1);
      return true;
    }, { blockWhileInteracting: true }),
    shortcuts.register(zone, 'right', () => {
      if (!isCurrent())
        return false;
      playback.step(1);
      return true;
    }, { blockWhileInteracting: true })
  ])
];

onBeforeUnmount(() => {
  for (const off of offKeys)
    off();
});
</script>

<template>
  <section
    class="frame-track"
    data-zone="frametrack"
  >
    <FrameToolbar :doc="doc" />
    <div
      ref="strip"
      class="frame-strip"
      role="listbox"
      aria-label="Frames"
      aria-orientation="horizontal"
      @wheel="onWheel"
      @contextmenu="onStripMenu"
    >
      <FrameThumb
        :doc="doc"
        :frame="null"
        :height="thumbHeight"
        :active="isActive(REF_TARGET)"
        @select="onSelect"
        @menu="onMenu"
      />
      <div class="frame-strip-divider" />
      <FrameThumb
        v-for="(f, i) in frames"
        :key="f.uid"
        :doc="doc"
        :frame="f"
        :index="i + 1"
        :height="thumbHeight"
        :active="isActive({ kind: 'frame', uid: f.uid })"
        @select="onSelect"
        @menu="onMenu"
      />
      <button
        v-tooltip="frames.length ? 'Add frame (copy of the last frame)' : 'Add frame'"
        type="button"
        class="btn btn-ghost frame-add"
        :style="{ height: `${thumbHeight}px` }"
        aria-label="Add frame"
        @mousedown.prevent
        @click="select(addFrame(doc))"
      >
        <Plus :size="20" />
      </button>
    </div>
  </section>
</template>

<style scoped>
.frame-track {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  min-width: 0;
  background: var(--bg-2);
  border-top: 1px solid var(--border);
}

.frame-strip {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  overflow-x: auto;
  overflow-y: hidden;
}

.frame-strip-divider {
  flex: 0 0 auto;
  align-self: stretch;
  width: 1px;
  margin: 0 var(--space-1);
  background: var(--border-strong);
}

.frame-add {
  flex: 0 0 auto;
  width: 40px;
  border: 1px dashed var(--border-strong);
}
</style>
