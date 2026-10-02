<script setup lang="ts">
// Drag handle between two panels. Drags resize the panel on `side` of the handle:
// - 'left' / 'right' (vertical handle in a flex row): the panel before it (dragging right widens it) / after it;
// - 'top' / 'bottom' (horizontal handle in a flex column): the panel above it (dragging down grows it) / below it.
// `width` is the panel's size along the drag axis (its height for top / bottom). v-model:width updates live while
// dragging; 'commit' fires once on release (persist it then). Keyboard: arrows ±16 px (Shift ±64). Double-click
// resets to defaultWidth when given.
import { computed, ref } from 'vue';
import { clamp } from '../../core/util/math';

const props = withDefaults(defineProps<{
  width: number;
  min?: number;
  max?: number;
  side?: 'left' | 'right' | 'top' | 'bottom';
  defaultWidth?: number;
}>(), { min: 120, max: 800, side: 'left' });

/** Horizontal handle (resizes a height). */
const horizontal = computed(() => props.side === 'top' || props.side === 'bottom');
/** Dragging toward +x / +y grows the panel. */
const grows = computed(() => props.side === 'left' || props.side === 'top');

const emit = defineEmits<{ 'update:width': [width: number]; commit: [width: number] }>();

const dragging = ref(false);
let start = 0;
let startWidth = 0;
let current = 0;

function set(w: number): void {
  const next = Math.round(clamp(w, props.min, props.max));
  if (next === current)
    return;
  current = next;
  emit('update:width', next);
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0)
    return;
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  start = horizontal.value ? e.clientY : e.clientX;
  startWidth = props.width;
  current = props.width;
  dragging.value = true;
  document.documentElement.classList.add(horizontal.value ? 'is-resizing-row' : 'is-resizing');
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value)
    return;
  const d = (horizontal.value ? e.clientY : e.clientX) - start;
  set(startWidth + (grows.value ? d : -d));
}

function end(): void {
  if (!dragging.value)
    return;
  dragging.value = false;
  document.documentElement.classList.remove('is-resizing', 'is-resizing-row');
  if (current !== startWidth)
    emit('commit', current);
}

function onKeydown(e: KeyboardEvent): void {
  const [less, more] = horizontal.value ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  if (e.key !== less && e.key !== more)
    return;
  e.preventDefault();
  const dir = (e.key === more ? 1 : -1) * (grows.value ? 1 : -1);
  current = props.width;
  set(props.width + dir * (e.shiftKey ? 64 : 16));
  emit('commit', current);
}

function onDoubleClick(): void {
  if (props.defaultWidth === undefined)
    return;
  current = props.width;
  set(props.defaultWidth);
  emit('commit', current);
}
</script>

<template>
  <div
    class="splitter"
    :class="{ 'is-dragging': dragging, 'splitter-horizontal': horizontal }"
    role="separator"
    :aria-orientation="horizontal ? 'horizontal' : 'vertical'"
    tabindex="0"
    :aria-valuenow="width"
    :aria-valuemin="min"
    :aria-valuemax="max"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="end"
    @pointercancel="end"
    @lostpointercapture="end"
    @keydown="onKeydown"
    @dblclick="onDoubleClick"
  />
</template>
