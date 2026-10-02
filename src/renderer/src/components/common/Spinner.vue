<script setup lang="ts">
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 16, label: 'Loading' });
</script>

<template>
  <span
    class="spinner"
    role="status"
    :aria-label="label"
    :style="{ '--spinner-size': `${size}px` }"
  />
</template>
