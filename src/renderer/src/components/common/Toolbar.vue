<script setup lang="ts">
// Horizontal (default) or vertical strip of controls. position 'bottom' draws the border on top instead.
defineProps<{ vertical?: boolean; position?: 'top' | 'bottom'; plain?: boolean; label?: string }>();
</script>

<template>
  <div
    class="toolbar"
    role="toolbar"
    :aria-label="label"
    :aria-orientation="vertical ? 'vertical' : 'horizontal'"
    :class="{ 'toolbar-vertical': vertical, 'toolbar-bottom': position === 'bottom', 'toolbar-plain': plain }"
  >
    <slot />
  </div>
</template>
