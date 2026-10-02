<script setup lang="ts">
// Renders services/contextMenu (mounted once in App.vue). Opens at the pointer, flipped / clamped into the viewport.
// Keys (captured on window while open, so DOM focus and the focus zone stay where they were): Up / Down / Home / End
// move, Enter / Space run, Escape / Tab close; every other key is swallowed. Closes on outside pointerdown, window
// blur, scroll, resize and Escape.
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { clamp } from '../../core/util/math';
import { contextMenu, isSeparator, type MenuEntry, type MenuItem } from '../../services/contextMenu';
import { hideTooltip } from './tooltip';

const MARGIN_PX = 4;

const state = contextMenu.state;
const menuEl = ref<HTMLElement | null>(null);
const activeIndex = ref(-1);
const pos = ref({ x: 0, y: 0 });
const placed = ref(false);
let listening = false;

const isEnabledItem = (e: MenuEntry | undefined): e is MenuItem => !!e && !isSeparator(e) && !e.disabled;

function place(): void {
  const el = menuEl.value;
  if (!el)
    return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = state.x;
  let y = state.y;
  // Flip to the other side of the pointer when it does not fit, then clamp (a menu larger than the viewport keeps its
  // top-left corner on screen)
  if (x + w > vw - MARGIN_PX)
    x = x - w;
  if (y + h > vh - MARGIN_PX)
    y = y - h;
  x = clamp(x, MARGIN_PX, vw - MARGIN_PX - w);
  y = clamp(y, MARGIN_PX, vh - MARGIN_PX - h);
  pos.value = { x: Math.round(x), y: Math.round(y) };
}

function onPointerDown(e: PointerEvent): void {
  if (!menuEl.value?.contains(e.target as Node))
    contextMenu.close();
}

function onScroll(e: Event): void {
  if (!menuEl.value?.contains(e.target as Node))
    contextMenu.close();
}

function onClose(): void {
  contextMenu.close();
}

function move(delta: 1 | -1, from = activeIndex.value): void {
  const n = state.items.length;
  for (let k = 1; k <= n; k++) {
    const i = ((from + delta * k) % n + n) % n;
    if (isEnabledItem(state.items[i])) {
      activeIndex.value = i;
      return;
    }
  }
}

function onKeydown(e: KeyboardEvent): void {
  // System combos (Alt+F4, Alt+Tab, Win) close the menu and pass through
  if (e.altKey || e.metaKey) {
    contextMenu.close();
    return;
  }
  // Like a native menu, the menu owns the keyboard while open (no editor fly keys, no shortcuts)
  e.preventDefault();
  e.stopPropagation();
  switch (e.key) {
    case 'ArrowDown':
      move(1);
      break;
    case 'ArrowUp':
      move(-1, activeIndex.value < 0 ? 0 : activeIndex.value);
      break;
    case 'Home':
      move(1, -1);
      break;
    case 'End':
      move(-1, 0);
      break;
    case 'Enter':
    case ' ': {
      const item = state.items[activeIndex.value];
      if (isEnabledItem(item))
        contextMenu.run(item);
      break;
    }
    case 'Escape':
    case 'Tab':
      contextMenu.close();
      break;
  }
}

function listen(on: boolean): void {
  if (on === listening)
    return;
  listening = on;
  if (on) {
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
  } else {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('blur', onClose);
    window.removeEventListener('resize', onClose);
  }
}

watch(() => [state.open, state.x, state.y, state.items] as const, async ([open]) => {
  activeIndex.value = -1;
  if (!open) {
    listen(false);
    return;
  }
  hideTooltip();
  placed.value = false;
  pos.value = { x: state.x, y: state.y };
  await nextTick();
  if (!state.open)
    return;
  place();
  placed.value = true;
  listen(true);
});

onBeforeUnmount(() => listen(false));

function hover(i: number): void {
  activeIndex.value = isEnabledItem(state.items[i]) ? i : -1;
}

function run(entry: MenuItem): void {
  if (!entry.disabled)
    contextMenu.run(entry);
}
</script>

<template>
  <div
    v-if="state.open"
    ref="menuEl"
    class="menu"
    role="menu"
    data-zone-ignore
    :style="{ left: `${pos.x}px`, top: `${pos.y}px`, visibility: placed ? 'visible' : 'hidden' }"
    @mousedown.prevent
    @contextmenu.prevent
    @pointerleave="activeIndex = -1"
  >
    <template
      v-for="(entry, i) in state.items"
      :key="i"
    >
      <div
        v-if="isSeparator(entry)"
        class="menu-separator"
        role="separator"
      />
      <div
        v-else
        class="menu-item"
        role="menuitem"
        :aria-disabled="entry.disabled || undefined"
        :class="{ 'is-active': i === activeIndex, 'is-disabled': entry.disabled, 'is-danger': entry.danger }"
        @pointermove="hover(i)"
        @click="run(entry)"
      >
        <span class="menu-icon">
          <component
            :is="entry.icon"
            v-if="entry.icon"
            :size="16"
          />
        </span>
        <span class="menu-label">{{ entry.label }}</span>
        <span class="menu-shortcut">{{ entry.shortcut }}</span>
      </div>
    </template>
  </div>
</template>
