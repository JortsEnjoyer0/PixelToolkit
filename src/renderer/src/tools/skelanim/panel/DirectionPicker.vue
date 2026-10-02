<script setup lang="ts">
// 8-way facing picker as a 3×3 compass (north up, south = facing the viewer). v-model: Direction.
import type { Component } from 'vue';
import { ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ArrowUpRight } from '@lucide/vue';
import type { Direction } from '@shared/pixellab';
import IconButton from '../../../components/common/IconButton.vue';

defineProps<{ modelValue: Direction; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Direction] }>();

interface Cell { dir: Direction; icon: Component; abbr: string }

/** Row-major compass; null = the centre cell. */
const GRID: readonly (Cell | null)[] = [
  { dir: 'north-west', icon: ArrowUpLeft, abbr: 'NW' },
  { dir: 'north', icon: ArrowUp, abbr: 'N' },
  { dir: 'north-east', icon: ArrowUpRight, abbr: 'NE' },
  { dir: 'west', icon: ArrowLeft, abbr: 'W' },
  null,
  { dir: 'east', icon: ArrowRight, abbr: 'E' },
  { dir: 'south-west', icon: ArrowDownLeft, abbr: 'SW' },
  { dir: 'south', icon: ArrowDown, abbr: 'S' },
  { dir: 'south-east', icon: ArrowDownRight, abbr: 'SE' }
];

const abbr = (d: Direction): string => GRID.find((c) => c?.dir === d)?.abbr ?? '';
const title = (d: Direction): string => `Facing ${d}${d === 'south' ? ' (toward the viewer)' : d === 'north' ? ' (away from the viewer)' : ''}`;
</script>

<template>
  <div
    class="direction-picker"
    role="group"
    aria-label="Direction"
  >
    <template
      v-for="(cell, i) in GRID"
      :key="i"
    >
      <IconButton
        v-if="cell"
        :icon="cell.icon"
        size="sm"
        variant="default"
        :tooltip="title(cell.dir)"
        :active="cell.dir === modelValue"
        :disabled="disabled"
        @click="emit('update:modelValue', cell.dir)"
      />
      <span
        v-else
        class="direction-picker-centre text-xs text-dim"
      >{{ abbr(modelValue) }}</span>
    </template>
  </div>
</template>

<style scoped>
.direction-picker {
  display: grid;
  grid-template-columns: repeat(3, var(--toolbar-button-size-sm));
  grid-auto-rows: var(--toolbar-button-size-sm);
  gap: 2px;
}

.direction-picker-centre {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: var(--font-weight-bold);
}
</style>
