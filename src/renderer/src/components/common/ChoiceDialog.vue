<script setup lang="ts">
// Built-in dialogs.choice() view (rendered by DialogHost): N buttons left to right, e.g. Save / Don't Save / Cancel.
// Enter = the first 'primary' button; Escape / × = options.cancelId (handled by the host's dismiss).
import { computed } from 'vue';
import type { ChoiceButton, ChoiceOptions } from '../../services/dialogs';
import DialogFrame from './DialogFrame.vue';

const props = defineProps<{ options: ChoiceOptions }>();
const emit = defineEmits<{ resolve: [value: string]; cancel: [] }>();

const primaryId = computed(() => props.options.buttons.find((b) => b.kind === 'primary')?.id ?? null);
const btnClass = (b: ChoiceButton): string => b.kind === 'primary' ? 'btn-primary' : b.kind === 'danger' ? 'btn-danger' : '';
</script>

<template>
  <DialogFrame
    :title="options.title"
    @close="emit('cancel')"
  >
    <p class="dialog-message">
      {{ options.message }}
    </p>
    <p
      v-if="options.detail"
      class="dialog-detail"
    >
      {{ options.detail }}
    </p>
    <template #footer>
      <button
        v-for="b in options.buttons"
        :key="b.id"
        type="button"
        class="btn"
        :class="btnClass(b)"
        :data-dialog-primary="b.id === primaryId || undefined"
        @click="emit('resolve', b.id)"
      >
        {{ b.label }}
      </button>
    </template>
  </DialogFrame>
</template>
