<script setup lang="ts">
// Styled native checkbox with an optional label (prop or default slot). v-model + 'change' (after the update).
const props = defineProps<{ modelValue: boolean; label?: string; disabled?: boolean; indeterminate?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; change: [value: boolean] }>();

function onChange(e: Event): void {
  const checked = (e.target as HTMLInputElement).checked;
  emit('update:modelValue', checked);
  emit('change', checked);
  // Controlled: if the parent did not take the new value, the box follows the prop again
  if (checked !== props.modelValue)
    (e.target as HTMLInputElement).checked = props.modelValue;
}
</script>

<template>
  <label
    class="checkbox"
    :class="{ 'is-disabled': disabled }"
  >
    <input
      type="checkbox"
      class="checkbox-input"
      :checked="modelValue"
      :disabled="disabled"
      :indeterminate="indeterminate"
      @change="onChange"
    >
    <span
      v-if="label || $slots.default"
      class="checkbox-label"
    >
      <slot>{{ label }}</slot>
    </span>
  </label>
</template>
