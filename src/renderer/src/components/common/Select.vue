<script setup lang="ts" generic="T extends string | number">
// Styled native <select>. Options are { value, label, disabled? } or plain values. The model keeps its exact type
// (options are matched by value, rendered by index). A value missing from the options shows `placeholder` (or itself).
import { computed } from 'vue';
import type { SelectOption } from './types';

const props = defineProps<{
  modelValue: T;
  options: readonly (SelectOption<T> | T)[];
  disabled?: boolean;
  size?: 'sm' | 'md';
  placeholder?: string;
  /** Accessible name (when no visible <label> points at the select). */
  label?: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: T]; change: [value: T] }>();

const items = computed<SelectOption<T>[]>(() => props.options.map((o) =>
  typeof o === 'object' ? o : { value: o, label: String(o) }));
const selectedIndex = computed(() => items.value.findIndex((o) => o.value === props.modelValue));

function onChange(e: Event): void {
  const el = e.target as HTMLSelectElement;
  const opt = items.value[Number(el.value)];
  if (!opt)
    return;
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  // Controlled: re-sync when the parent keeps the old value
  if (opt.value !== props.modelValue)
    el.value = String(selectedIndex.value);
}
</script>

<template>
  <select
    class="select"
    :class="{ 'input-sm': size === 'sm' }"
    :disabled="disabled"
    :aria-label="label"
    @change="onChange"
  >
    <option
      v-if="selectedIndex < 0"
      value="-1"
      disabled
      selected
      hidden
    >
      {{ placeholder ?? String(modelValue) }}
    </option>
    <option
      v-for="(o, i) in items"
      :key="String(o.value)"
      :value="String(i)"
      :disabled="o.disabled"
      :selected="i === selectedIndex"
    >
      {{ o.label }}
    </option>
  </select>
</template>
