<script setup lang="ts">
// Left vertical tool bar: one icon-over-label button per registered tool (v-model = active tool id) and the
// Settings button pinned at the bottom.
import { Settings } from '@lucide/vue';
import { TOOLS } from '../../tools/registry';
import { openSettings } from './openSettings';

const active = defineModel<string>({ required: true });
</script>

<template>
  <nav
    class="navbar"
    aria-label="Tools"
  >
    <button
      v-for="tool in TOOLS"
      :key="tool.id"
      type="button"
      class="nav-item"
      :class="{ 'is-active': tool.id === active }"
      :aria-current="tool.id === active ? 'page' : undefined"
      @mousedown.prevent
      @click="active = tool.id"
    >
      <component
        :is="tool.icon"
        :size="20"
        :stroke-width="1.75"
      />
      <span class="nav-label">{{ tool.label }}</span>
    </button>
    <div class="nav-spacer" />
    <button
      v-tooltip.right="{ text: 'Settings', shortcut: 'Ctrl+,' }"
      type="button"
      class="nav-item"
      @mousedown.prevent
      @click="openSettings()"
    >
      <Settings
        :size="20"
        :stroke-width="1.75"
      />
      <span class="nav-label">Settings</span>
    </button>
  </nav>
</template>

<style scoped>
.navbar {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  width: var(--navbar-width);
  padding: var(--space-1) 0;
  background: var(--nav-bg);
  border-right: 1px solid var(--border);
}

.nav-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: var(--nav-item-height);
  margin: 2px 6px;
  padding: 0 2px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-faint);
  font-size: var(--font-size-xs);
  transition: color var(--speed-fast) var(--ease), background-color var(--speed-fast) var(--ease);
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.nav-item.is-active {
  background: var(--bg-active);
  color: var(--text);
}

.nav-item.is-active :deep(svg) {
  color: var(--accent-hover);
}

/* Active indicator bar on the bar's left edge */
.nav-item.is-active::before {
  content: '';
  position: absolute;
  top: 12px;
  bottom: 12px;
  left: -6px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
}

/* Long labels wrap to two centred lines (clamped); a word longer than the bar breaks */
.nav-label {
  display: -webkit-box;
  max-width: 100%;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  line-height: 1.1;
  text-align: center;
  overflow-wrap: anywhere;
}

.nav-spacer {
  flex: 1 1 auto;
}
</style>
