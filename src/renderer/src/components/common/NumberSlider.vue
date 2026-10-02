<script setup lang="ts">
// Range slider + number entry. v-model updates live (slider drag, valid typing, arrow keys); 'commit' fires once per
// finished edit: slider change (release / key), Enter or blur in the field. Undo-coalescing callers apply on
// update:modelValue with a mergeKey and seal on commit. Values are clamped to [min, max] and snapped to step.
// Field keys: Up / Down step (Shift ×10), Enter commits, Escape reverts to the value at focus.
import { computed, ref, watch } from 'vue';
import { clamp } from '../../core/util/math';

const props = withDefaults(defineProps<{
  modelValue: number;
  min: number;
  max: number;
  step?: number;
  /** Decimals shown in the field (default: from step). */
  precision?: number;
  disabled?: boolean;
  /** false = number field only. */
  slider?: boolean;
  /** Field width, CSS px. */
  inputWidth?: number;
  size?: 'sm' | 'md';
  /** Accessible name of both inputs (when no visible <label> points at them). */
  label?: string;
}>(), { step: 1, slider: true, size: 'md' });

const emit = defineEmits<{ 'update:modelValue': [value: number]; commit: [value: number] }>();

const decimals = computed(() => {
  if (props.precision !== undefined)
    return props.precision;
  const s = String(props.step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
});

const format = (v: number): string => (Number.isFinite(v) ? v : props.min).toFixed(decimals.value);

/** Clamp, snap to step (relative to min) and drop float noise. */
function normalize(v: number): number {
  const clamped = clamp(v, props.min, props.max);
  const snapped = props.step > 0 ? props.min + Math.round((clamped - props.min) / props.step) * props.step : clamped;
  return clamp(Number(snapped.toFixed(decimals.value)), props.min, props.max);
}

const text = ref(format(props.modelValue));
const editing = ref(false);
/** Last value we emitted (props lag one render behind emits). */
let last = props.modelValue;
/** Value when the current edit started (field focus). */
let start = props.modelValue;
/** update:modelValue was emitted since the last commit. */
let dirty = false;

watch(() => props.modelValue, (v) => {
  last = v;
  if (!editing.value)
    text.value = format(v);
});

const fill = computed(() => {
  const span = props.max - props.min;
  const t = span > 0 ? (props.modelValue - props.min) / span : 0;
  return `${clamp(t * 100, 0, 100)}%`;
});

function update(v: number): void {
  const n = normalize(v);
  if (n === last)
    return;
  last = n;
  dirty = true;
  emit('update:modelValue', n);
}

function commit(): void {
  if (!dirty)
    return;
  dirty = false;
  emit('commit', last);
}

// ---- slider ----

function onRangeInput(e: Event): void {
  update(Number((e.target as HTMLInputElement).value));
  if (!editing.value)
    text.value = format(last);
}

// ---- number field ----

const parse = (s: string): number => Number.parseFloat(s.trim().replace(',', '.'));

function onFocus(e: FocusEvent): void {
  editing.value = true;
  start = last;
  (e.target as HTMLInputElement).select();
}

function onInput(e: Event): void {
  text.value = (e.target as HTMLInputElement).value;
  const v = parse(text.value);
  // Live only while the typed number is in range ("6" on the way to "60" with min 10 waits for the commit)
  if (Number.isFinite(v) && v >= props.min && v <= props.max)
    update(v);
}

function commitField(): void {
  const v = parse(text.value);
  if (Number.isFinite(v))
    update(v);
  text.value = format(last);
  commit();
}

function onKeydown(e: KeyboardEvent): void {
  const input = e.target as HTMLInputElement;
  if (e.key === 'Enter') {
    commitField();
    start = last;
    input.select();
  } else if (e.key === 'Escape') {
    if (format(start) === text.value && !dirty)
      return;
    // Revert this edit; keep the Escape from closing a surrounding dialog
    e.stopPropagation();
    e.preventDefault();
    text.value = format(start);
    update(start);
    commit();
    input.select();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const base = Number.isFinite(parse(text.value)) ? parse(text.value) : last;
    const delta = (e.key === 'ArrowUp' ? 1 : -1) * props.step * (e.shiftKey ? 10 : 1);
    update(base + delta);
    text.value = format(last);
  }
}

function onBlur(): void {
  commitField();
  editing.value = false;
}
</script>

<template>
  <div class="number-slider">
    <input
      v-if="slider"
      class="range"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="modelValue"
      :disabled="disabled"
      :aria-label="label"
      :style="{ '--fill': fill }"
      @input="onRangeInput"
      @change="commit"
    >
    <input
      class="input input-number"
      :class="{ 'input-sm': size === 'sm' }"
      type="text"
      inputmode="decimal"
      autocomplete="off"
      spellcheck="false"
      :value="text"
      :disabled="disabled"
      :aria-label="label"
      :style="inputWidth ? { width: `${inputWidth}px` } : undefined"
      @focus="onFocus"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
    >
  </div>
</template>
