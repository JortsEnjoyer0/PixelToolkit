<script setup lang="ts">
// Slider over a fixed list of values that need not be evenly spaced (e.g. 0, 8 … 64, 128, 256), with the current value
// shown beside it (`format`, default the number). The range input moves over list indices; arrow keys and dragging
// step one entry. v-model updates live; 'commit' fires once per finished change. A model value not in the list shows
// at the nearest entry.
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: number;
  /** The selectable values, in slider order. */
  values: readonly number[];
  /** Text shown for a value (default: the number). */
  format?: (value: number) => string;
  disabled?: boolean;
  /** Accessible name of the slider (when no visible <label> points at it). */
  label?: string;
}>(), { format: (v: number) => String(v) });

const emit = defineEmits<{ 'update:modelValue': [value: number]; commit: [value: number] }>();

const index = computed(() => {
  let best = 0;
  props.values.forEach((v, i) => {
    if (Math.abs(v - props.modelValue) < Math.abs(props.values[best] - props.modelValue))
      best = i;
  });
  return best;
});
const last = computed(() => Math.max(1, props.values.length - 1));
const fill = computed(() => `${(index.value / last.value) * 100}%`);
const text = computed(() => props.format(props.values[index.value] ?? props.modelValue));

function valueAt(e: Event): number {
  return props.values[Number((e.target as HTMLInputElement).value)] ?? props.modelValue;
}

function onInput(e: Event): void {
  const v = valueAt(e);
  if (v !== props.modelValue)
    emit('update:modelValue', v);
}

function onChange(e: Event): void {
  emit('commit', valueAt(e));
}
</script>

<template>
  <div class="step-slider">
    <input
      class="range"
      type="range"
      min="0"
      :max="values.length - 1"
      step="1"
      :value="index"
      :disabled="disabled"
      :aria-label="label"
      :aria-valuetext="text"
      :style="{ '--fill': fill }"
      @input="onInput"
      @change="onChange"
    >
    <span class="step-slider-value tabular">{{ text }}</span>
  </div>
</template>
