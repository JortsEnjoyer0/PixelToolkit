<script setup lang="ts">
// Open animation tabs (data-zone="tabs"), from useTabsStore().tabs. Drag to reorder (vue-draggable-plus; the library
// reverts its own DOM move and the store order re-renders the strip), click activates, × / middle-click close (a dirty
// doc prompts in tabs.close), '*' marks unsaved changes, a spinner shows pending API calls. The active tab is kept
// scrolled into view; the vertical wheel scrolls the strip sideways.
import { computed, nextTick, ref, watch } from 'vue';
import { FileX, X } from '@lucide/vue';
import { useDraggable, type DraggableEvent } from 'vue-draggable-plus';
import Spinner from '../../../components/common/Spinner.vue';
import { contextMenu, SEPARATOR } from '../../../services/contextMenu';
import { useTabsStore } from '../../../stores/tabs';
import type { TabInfo } from '../../../stores/types';

const tabs = useTabsStore();

const bar = ref<HTMLElement | null>(null);
/** A fresh copy. The library reverts its own DOM move and writes a reordered copy back here, which is ignored. */
const items = computed<TabInfo[]>({ get: () => [...tabs.tabs], set: () => undefined });

const tooltip = (t: TabInfo): string =>
  `${t.charName} / ${t.label}${t.missingOnDisk ? '\nMissing on disk: saving recreates it' : ''}`;

function onReorder(e: DraggableEvent): void {
  const from = e.oldDraggableIndex ?? e.oldIndex;
  const to = e.newDraggableIndex ?? e.newIndex;
  if (from !== undefined && to !== undefined && from !== to)
    tabs.move(from, to);
}

useDraggable(bar, items, {
  animation: 150,
  direction: 'horizontal',
  filter: '.tab-close',
  preventOnFilter: false,
  ghostClass: 'is-drag-ghost',
  onUpdate: onReorder
});

function close(docId: string): void {
  void tabs.close(docId);
}

function onAuxClick(e: MouseEvent, docId: string): void {
  if (e.button === 1)
    close(docId);
}

/** Close several tabs in order; stops at the first Cancel. */
async function closeMany(ids: string[]): Promise<void> {
  for (const id of ids) {
    if (!await tabs.close(id))
      return;
  }
}

function onMenu(e: MouseEvent, t: TabInfo): void {
  const ids = tabs.tabs.map((x) => x.docId);
  const at = ids.indexOf(t.docId);
  contextMenu.open(e, [
    { label: 'Close', shortcut: 'Middle-click', action: () => close(t.docId) },
    { label: 'Close Others', disabled: ids.length < 2, action: () => void closeMany(ids.filter((id) => id !== t.docId)) },
    { label: 'Close to the Right', disabled: at === ids.length - 1, action: () => void closeMany(ids.slice(at + 1)) },
    SEPARATOR,
    { label: 'Close All', action: () => void closeMany(ids) }
  ]);
}

function onWheel(e: WheelEvent): void {
  const el = bar.value;
  if (!el || Math.abs(e.deltaY) <= Math.abs(e.deltaX))
    return;
  el.scrollLeft += e.deltaY;
  e.preventDefault();
}

/** Scroll the strip (only) so the active tab is fully visible. */
function revealActive(): void {
  const el = bar.value;
  const tab = el?.querySelector<HTMLElement>('.tab.is-active');
  if (!el || !tab)
    return;
  if (tab.offsetLeft < el.scrollLeft)
    el.scrollLeft = tab.offsetLeft;
  else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth)
    el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth;
}

watch([() => tabs.activeDocId, () => tabs.tabs.length], () => {
  void nextTick(revealActive);
}, { immediate: true });
</script>

<template>
  <div
    ref="bar"
    class="tabs tab-bar"
    data-zone="tabs"
    role="tablist"
    aria-label="Open animations"
    @wheel="onWheel"
  >
    <div
      v-for="t in items"
      :key="t.docId"
      v-tooltip="tooltip(t)"
      class="tab"
      :class="{ 'is-active': t.active, 'is-missing': t.missingOnDisk }"
      role="tab"
      :aria-selected="t.active"
      @click="tabs.activate(t.docId)"
      @mousedown.middle.prevent
      @auxclick="onAuxClick($event, t.docId)"
      @contextmenu="onMenu($event, t)"
    >
      <FileX
        v-if="t.missingOnDisk"
        class="tab-missing"
        :size="13"
      />
      <span class="tab-label">{{ t.dirty ? '*' : '' }}{{ t.label }}</span>
      <span
        v-if="t.showCharSuffix"
        class="tab-suffix"
      >{{ t.charName }}</span>
      <Spinner
        v-if="t.busy"
        class="tab-spinner"
        :size="12"
        label="API call pending"
      />
      <button
        type="button"
        class="tab-close"
        aria-label="Close tab"
        @mousedown.prevent
        @click.stop="close(t.docId)"
      >
        <X :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Positioned, so the tabs' offsetLeft is relative to the strip (revealActive) */
.tab-bar {
  position: relative;
  min-width: 0;
}

.tab-suffix {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-faint);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
}

.tab-missing {
  flex: 0 0 auto;
  color: var(--warning-text);
}

.tab.is-missing .tab-label {
  font-style: italic;
}

.tab-spinner {
  color: var(--accent);
}

.tab.is-drag-ghost {
  opacity: 0.4;
}
</style>
