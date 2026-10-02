<script setup lang="ts">
// Masked secret field with a reveal toggle. Secrets never reach the renderer: when one is stored (the settings store
// holds SECRET_MASK) the field starts empty with a "saved" placeholder. Typing replaces the key; the × button marks
// the stored key for removal (v-model:cleared), the undo button keeps it again. The caller turns this into a patch:
// value !== '' → value, cleared → '', otherwise leave the key out (keeps the stored one).
import { computed, ref } from 'vue';
import { Eye, EyeOff, RotateCcw, X } from '@lucide/vue';
import IconButton from './IconButton.vue';

const props = defineProps<{
  modelValue: string;
  /** A value is stored (masked). */
  stored: boolean;
  cleared: boolean;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string]; 'update:cleared': [value: boolean] }>();

const revealed = ref(false);
const keepsStored = computed(() => props.stored && !props.cleared);
const placeholderText = computed(() => {
  if (keepsStored.value)
    return '•••••••••••• saved (type to replace)';
  return props.stored ? 'Will be removed on save' : (props.placeholder ?? 'Not set');
});

function clear(): void {
  emit('update:modelValue', '');
  emit('update:cleared', true);
}
</script>

<template>
  <div
    class="input-affix"
    style="--affix-count: 2"
  >
    <input
      :id="id"
      class="input input-mono"
      :type="revealed ? 'text' : 'password'"
      :value="modelValue"
      :placeholder="placeholderText"
      :disabled="disabled"
      autocomplete="off"
      spellcheck="false"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    >
    <div class="input-affix-end">
      <IconButton
        :icon="revealed ? EyeOff : Eye"
        size="sm"
        :tooltip="revealed ? 'Hide' : 'Show'"
        :active="revealed"
        :disabled="disabled || modelValue === ''"
        @click="revealed = !revealed"
      />
      <IconButton
        v-if="keepsStored"
        :icon="X"
        size="sm"
        tooltip="Remove the saved key"
        danger-hover
        :disabled="disabled"
        @click="clear"
      />
      <IconButton
        v-else-if="stored"
        :icon="RotateCcw"
        size="sm"
        tooltip="Keep the saved key"
        :disabled="disabled"
        @click="emit('update:cleared', false)"
      />
    </div>
  </div>
</template>
