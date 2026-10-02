<script setup lang="ts">
// Built-in dialogs.prompt() view (rendered by DialogHost). validate() runs live; its message shows once the user
// typed (or pressed Enter) and disables OK.
import { computed, onMounted, ref } from 'vue';
import type { PromptOptions } from '../../services/dialogs';
import DialogFrame from './DialogFrame.vue';

const props = defineProps<{ options: PromptOptions }>();
const emit = defineEmits<{ resolve: [value: string]; cancel: [] }>();

const value = ref(props.options.value ?? '');
const touched = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const error = computed(() => props.options.validate?.(value.value) ?? null);

function submit(): void {
  touched.value = true;
  if (!error.value)
    emit('resolve', value.value);
}

function onEnter(e: KeyboardEvent): void {
  // Handled here (not by the host's data-dialog-primary click) so an invalid value shows its message
  e.preventDefault();
  submit();
}

onMounted(() => inputEl.value?.select());
</script>

<template>
  <DialogFrame
    :title="options.title"
    size="sm"
    @close="emit('cancel')"
  >
    <p
      v-if="options.message"
      class="dialog-message"
    >
      {{ options.message }}
    </p>
    <div class="field">
      <input
        ref="inputEl"
        v-model="value"
        class="input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        data-autofocus
        :class="{ 'is-invalid': touched && error }"
        :placeholder="options.placeholder"
        :aria-invalid="touched && !!error"
        @input="touched = true"
        @keydown.enter="onEnter"
      >
      <p
        v-if="touched && error"
        class="form-error"
      >
        {{ error }}
      </p>
    </div>
    <template #footer>
      <button
        type="button"
        class="btn btn-primary"
        data-dialog-primary
        :disabled="!!error"
        @click="submit"
      >
        {{ options.okLabel ?? 'OK' }}
      </button>
      <button
        type="button"
        class="btn"
        @click="emit('cancel')"
      >
        Cancel
      </button>
    </template>
  </DialogFrame>
</template>
