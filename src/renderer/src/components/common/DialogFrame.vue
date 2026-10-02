<script setup lang="ts">
// Dialog chrome for DialogHost entries (built-in and custom dialogs): title row with optional icon and close button,
// scrollable body (default slot), footer slot. Mark the default action with data-dialog-primary (Enter clicks it)
// and the element to focus first with data-autofocus.
import { computed, useId, type Component } from 'vue';
import { X } from '@lucide/vue';
import IconButton from './IconButton.vue';

const props = withDefaults(defineProps<{
  title: string;
  icon?: Component;
  iconTone?: 'danger' | 'warning' | 'default';
  size?: 'sm' | 'default' | 'md' | 'lg';
  /** Show the × button (emits 'close'). */
  closable?: boolean;
}>(), { iconTone: 'default', size: 'default', closable: true });

const emit = defineEmits<{ close: [] }>();

const titleId = useId();
const sizeClass = computed(() => props.size === 'default' ? '' : `dialog-${props.size}`);
</script>

<template>
  <div
    class="dialog"
    :class="sizeClass"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    tabindex="-1"
  >
    <header class="dialog-header">
      <component
        :is="icon"
        v-if="icon"
        class="dialog-title-icon"
        :class="{ 'is-danger': iconTone === 'danger', 'is-warning': iconTone === 'warning' }"
        :size="18"
      />
      <h2
        :id="titleId"
        class="dialog-title"
      >
        {{ title }}
      </h2>
      <IconButton
        v-if="closable"
        :icon="X"
        size="sm"
        tooltip="Close"
        shortcut="Esc"
        @click="emit('close')"
      />
    </header>
    <div class="dialog-body">
      <slot />
    </div>
    <footer
      v-if="$slots.footer"
      class="dialog-footer"
    >
      <slot name="footer" />
    </footer>
  </div>
</template>
