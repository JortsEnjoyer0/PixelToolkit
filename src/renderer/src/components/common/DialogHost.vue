<script setup lang="ts">
// Renders services/dialogs (mounted once in App.vue). Every entry gets a modal layer; only the top one is live.
// - Built-ins: confirm (optional checkbox, danger styling), prompt (live validation), choice (N buttons).
// - Custom: dialogs.open(Component, props); the component emits 'resolve' (value) or 'cancel' and usually renders
//   <DialogFrame>. Mark the default button with data-dialog-primary and the first field with data-autofocus.
// Keys: Enter = click [data-dialog-primary] (unless a button / textarea / select / link has focus or the event was
// handled), Escape = dismiss (cancel value), Tab is trapped inside the top dialog. Backdrop click dismisses built-ins
// only (custom dialogs may hold unsaved form state). While open: <html class="modal-open">, the context menu and
// tooltip close, and services/shortcuts is suppressed (isModalOpen). dialogs.resolve() restores focus after close.
import { computed, nextTick, onBeforeUnmount, watch, type Component } from 'vue';
import { dialogs, type DialogEntry } from '../../services/dialogs';
import { contextMenu } from '../../services/contextMenu';
import { focusZone, type Zone } from '../../services/focusZone';
import ChoiceDialog from './ChoiceDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import PromptDialog from './PromptDialog.vue';
import { hideTooltip } from './tooltip';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), '
  + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
const NATIVE_ENTER = new Set(['BUTTON', 'TEXTAREA', 'SELECT', 'A']);

const stack = computed(() => dialogs.stack);
const top = computed<DialogEntry | null>(() => stack.value[stack.value.length - 1] ?? null);
const layers = new Map<number, HTMLElement>();
let pressedOnBackdrop: number | null = null;
/** Focus zone when the first dialog opened (dialogs live outside every zone). */
let zoneBefore: Zone | null = null;

const BUILTIN: Record<Exclude<DialogEntry['kind'], 'custom'>, Component> = {
  confirm: ConfirmDialog,
  prompt: PromptDialog,
  choice: ChoiceDialog
};

const componentOf = (e: DialogEntry): Component => e.kind === 'custom' ? e.component : BUILTIN[e.kind];
const propsOf = (e: DialogEntry): Record<string, unknown> => e.kind === 'custom' ? e.props : { options: e.options };

function setLayer(id: number, el: unknown): void {
  if (el instanceof HTMLElement)
    layers.set(id, el);
  else
    layers.delete(id);
}

const visible = (el: HTMLElement): boolean => el.getClientRects().length > 0;

function focusables(layer: HTMLElement): HTMLElement[] {
  return [...layer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

function focusInitial(layer: HTMLElement): void {
  const auto = [...layer.querySelectorAll<HTMLElement>('[data-autofocus], [autofocus]')].find(visible);
  const target = auto ?? layer.querySelector<HTMLElement>('.dialog, [role="dialog"]') ?? focusables(layer)[0];
  target?.focus({ preventScroll: true });
}

function trapTab(e: KeyboardEvent, layer: HTMLElement): void {
  const list = focusables(layer);
  if (list.length === 0) {
    e.preventDefault();
    return;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  const inside = active instanceof HTMLElement && list.includes(active);
  if (e.shiftKey && (!inside || active === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

function onKeydown(e: KeyboardEvent, entry: DialogEntry): void {
  const layer = layers.get(entry.id);
  if (e.defaultPrevented || !layer || entry !== top.value || e.isComposing)
    return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    dialogs.dismiss(entry.id);
  } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    const target = e.target as HTMLElement;
    if (NATIVE_ENTER.has(target.tagName) || target.isContentEditable)
      return;
    const primary = layer.querySelector<HTMLButtonElement>('[data-dialog-primary]');
    if (primary && !primary.disabled) {
      e.preventDefault();
      primary.click();
    }
  } else if (e.key === 'Tab') {
    trapTab(e, layer);
  }
}

function onBackdropDown(e: MouseEvent, entry: DialogEntry): void {
  pressedOnBackdrop = e.target === e.currentTarget ? entry.id : null;
}

function onBackdropClick(e: MouseEvent, entry: DialogEntry): void {
  const pressed = pressedOnBackdrop;
  pressedOnBackdrop = null;
  if (e.target !== e.currentTarget || pressed !== entry.id || entry !== top.value)
    return;
  if (entry.kind === 'custom') {
    // Nudge focus back into the dialog instead of discarding a form
    const layer = layers.get(entry.id);
    if (layer && !layer.contains(document.activeElement))
      focusInitial(layer);
    return;
  }
  dialogs.dismiss(entry.id);
}

/** Keys while focus fell out of every dialog to <body> (e.g. its focused button got disabled): the top dialog's. */
function onStrayKeydown(e: KeyboardEvent): void {
  const entry = top.value;
  const layer = entry ? layers.get(entry.id) : undefined;
  const active = document.activeElement;
  if (entry && layer && (active === null || active === document.body))
    onKeydown(e, entry);
}

/** Keep focus inside the top dialog (context menus opened from inside a dialog are allowed). */
function onFocusIn(e: FocusEvent): void {
  const entry = top.value;
  const layer = entry ? layers.get(entry.id) : undefined;
  const target = e.target as HTMLElement | null;
  if (!layer || !target || layer.contains(target) || target.closest('.menu'))
    return;
  focusInitial(layer);
}

watch(() => top.value?.id ?? null, async (id, prevId) => {
  const open = id !== null;
  document.documentElement.classList.toggle('modal-open', open);
  if (open) {
    if (prevId === null || prevId === undefined)
      zoneBefore = focusZone.get();
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('keydown', onStrayKeydown);
    contextMenu.close();
    hideTooltip();
  } else {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('keydown', onStrayKeydown);
    // dialogs.resolve() restored focus; when that was <body> (no focusin), restore the zone the user was in
    const active = document.activeElement;
    focusZone.set(active && active !== document.body ? focusZone.zoneOf(active) : zoneBefore);
    zoneBefore = null;
  }
  await nextTick();
  if (id === null || top.value?.id !== id)
    return;
  const layer = layers.get(id);
  if (!layer)
    return;
  // A new dialog gets its initial focus; a revealed lower one keeps the focus dialogs.resolve() restored
  const opened = prevId === null || prevId === undefined || stack.value.some((e) => e.id === prevId);
  if (opened || !layer.contains(document.activeElement))
    focusInitial(layer);
}, { flush: 'post' });

onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn, true);
  document.removeEventListener('keydown', onStrayKeydown);
  document.documentElement.classList.remove('modal-open');
});
</script>

<template>
  <div
    v-for="(entry, i) in stack"
    :key="entry.id"
    :ref="(el) => setLayer(entry.id, el)"
    class="dialog-layer"
    :class="{ 'is-covered': i < stack.length - 1 }"
    @mousedown="onBackdropDown($event, entry)"
    @click="onBackdropClick($event, entry)"
    @keydown="onKeydown($event, entry)"
  >
    <component
      :is="componentOf(entry)"
      v-bind="propsOf(entry)"
      @resolve="(value?: unknown) => dialogs.resolve(entry.id, value)"
      @cancel="dialogs.dismiss(entry.id)"
    />
  </div>
</template>
