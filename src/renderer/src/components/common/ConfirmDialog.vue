<script setup lang="ts">
// Built-in dialogs.confirm() view (rendered by DialogHost).
import { ref } from 'vue';
import { TriangleAlert } from '@lucide/vue';
import type { ConfirmOptions, ConfirmResult } from '../../services/dialogs';
import Checkbox from './Checkbox.vue';
import DialogFrame from './DialogFrame.vue';

const props = defineProps<{ options: ConfirmOptions }>();
const emit = defineEmits<{ resolve: [value: ConfirmResult]; cancel: [] }>();

const checked = ref(props.options.checkbox?.value ?? false);
</script>

<template>
  <DialogFrame
    :title="options.title"
    :icon="options.danger ? TriangleAlert : undefined"
    icon-tone="danger"
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
    <Checkbox
      v-if="options.checkbox"
      v-model="checked"
      :label="options.checkbox.label"
    />
    <template #footer>
      <button
        type="button"
        class="btn"
        :class="options.danger ? 'btn-danger' : 'btn-primary'"
        data-dialog-primary
        @click="emit('resolve', { ok: true, checked })"
      >
        {{ options.okLabel ?? 'OK' }}
      </button>
      <button
        type="button"
        class="btn"
        @click="emit('cancel')"
      >
        {{ options.cancelLabel ?? 'Cancel' }}
      </button>
    </template>
  </DialogFrame>
</template>
