<script setup lang="ts">
// Icon button (toolbars, rows, dialogs). Never takes focus on mouse press (@mousedown.prevent), so keyboard focus
// stays where the user works (editor, fields). `active` = toggled state; `loading` overlays a spinner and blocks clicks.
import { computed, type Component } from 'vue';
import Spinner from './Spinner.vue';
import type { TooltipPlacement, TooltipValue } from './tooltip';
import type { ButtonVariant, ControlSize } from './types';

const props = withDefaults(defineProps<{
  icon: Component;
  size?: ControlSize;
  /** Tooltip text (also the aria-label). */
  tooltip?: string;
  /** Shortcut hint shown in the tooltip, e.g. 'Ctrl+S'. */
  shortcut?: string;
  tooltipPlacement?: TooltipPlacement;
  /** Optional visible text after the icon. */
  label?: string;
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
  /** Ghost button that turns red on hover (remove / delete). */
  dangerHover?: boolean;
}>(), { size: 'md', variant: 'ghost' });

const emit = defineEmits<{ click: [e: MouseEvent] }>();

const ICON_PX: Record<ControlSize, number> = { sm: 14, md: 16, lg: 18 };

const iconPx = computed(() => ICON_PX[props.size]);
const classes = computed(() => [
  props.variant === 'default' ? '' : `btn-${props.variant}`,
  props.size === 'md' ? '' : `btn-${props.size}`,
  {
    'is-active': props.active,
    'is-loading': props.loading,
    'is-danger': props.dangerHover,
    'has-label': !!props.label
  }
]);
const tip = computed<TooltipValue>(() => props.tooltip
  ? { text: props.tooltip, shortcut: props.shortcut, placement: props.tooltipPlacement }
  : null);

function onClick(e: MouseEvent): void {
  if (props.loading || props.disabled)
    return;
  emit('click', e);
}
</script>

<template>
  <button
    v-tooltip="tip"
    type="button"
    class="btn btn-icon"
    :class="classes"
    :disabled="disabled"
    :aria-label="tooltip ?? label"
    :aria-pressed="active || undefined"
    :aria-busy="loading || undefined"
    @mousedown.prevent
    @click="onClick"
  >
    <component
      :is="icon"
      :size="iconPx"
    />
    <span v-if="label">{{ label }}</span>
    <Spinner
      v-if="loading"
      class="btn-spinner"
      :size="iconPx"
    />
  </button>
</template>
