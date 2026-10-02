<script setup lang="ts">
// Renders services/toasts (mounted once in App.vue): bottom-right stack, newest at the bottom. Hover pauses the
// auto-dismiss timer (toasts.hold / release); the action button runs and dismisses.
import type { Component } from 'vue';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from '@lucide/vue';
import { toasts, type ToastKind } from '../../services/toasts';
import IconButton from './IconButton.vue';

const ICONS: Record<ToastKind, Component> = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };
</script>

<template>
  <TransitionGroup
    tag="div"
    name="toast"
    class="toast-stack"
    aria-live="polite"
    data-zone-ignore
  >
    <div
      v-for="t in toasts.list"
      :key="t.id"
      class="toast"
      :class="`toast-${t.kind}`"
      :role="t.kind === 'error' || t.kind === 'warning' ? 'alert' : 'status'"
      @pointerenter="toasts.hold(t.id)"
      @pointerleave="toasts.release(t.id)"
    >
      <component
        :is="ICONS[t.kind]"
        class="toast-icon"
        :size="16"
      />
      <div class="toast-content">
        <div class="toast-title">
          {{ t.title }}
        </div>
        <div
          v-if="t.message"
          class="toast-message"
        >
          {{ t.message }}
        </div>
        <div
          v-if="t.action"
          class="toast-actions"
        >
          <button
            type="button"
            class="btn btn-sm"
            @mousedown.prevent
            @click="toasts.runAction(t.id)"
          >
            {{ t.action.label }}
          </button>
        </div>
      </div>
      <IconButton
        :icon="X"
        size="sm"
        tooltip="Dismiss"
        tooltip-placement="left"
        @click="toasts.dismiss(t.id)"
      />
    </div>
  </TransitionGroup>
</template>
