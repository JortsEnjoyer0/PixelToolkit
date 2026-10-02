<script setup lang="ts">
// Text input / textarea that edits locally and commits ONCE per edit (one undo entry or one rename): Enter or blur
// commits (Shift+Enter is a newline in multiline mode), Escape reverts. While not focused it follows `value`
// (undo / redo / doc switch). `validate` marks the field invalid live; committing an invalid value reverts it and
// emits 'invalid' with the message. `error` shows an external message (e.g. a failed rename) until the next edit.
import { computed, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  value: string;
  multiline?: boolean;
  rows?: number;
  maxlength?: number;
  placeholder?: string;
  disabled?: boolean;
  /** Accessible name (when no <label for> points at the field). */
  label?: string;
  id?: string;
  validate?: (value: string) => string | null;
  /** External error text (cleared by the parent; 'edit' fires on the first keystroke of an edit). */
  error?: string | null;
  /** Show "n / maxlength" while focused, right-aligned on the label's line above the field (no layout shift). */
  counter?: boolean;
}>(), { rows: 3 });

const emit = defineEmits<{ commit: [value: string]; invalid: [message: string]; edit: [] }>();

const el = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
const text = ref(props.value);
const focused = ref(false);
let edited = false;

const liveError = computed(() => props.validate && text.value !== props.value ? props.validate(text.value) : null);
const shownError = computed(() => liveError.value ?? props.error ?? null);

watch(() => props.value, (v) => {
  if (!focused.value)
    text.value = v;
});

/** Put the field back to `value` (also used by parents when a commit was refused). */
function revert(): void {
  text.value = props.value;
}

function commit(): void {
  edited = false;
  if (text.value === props.value)
    return;
  const err = props.validate?.(text.value) ?? null;
  if (err) {
    revert();
    emit('invalid', err);
    return;
  }
  emit('commit', text.value);
}

function onInput(e: Event): void {
  text.value = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
  if (!edited) {
    edited = true;
    emit('edit');
  }
}

function onFocus(): void {
  focused.value = true;
}

function onBlur(): void {
  focused.value = false;
  commit();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.isComposing)
    return;
  if (e.key === 'Enter' && !(props.multiline && e.shiftKey)) {
    e.preventDefault();
    el.value?.blur();
  } else if (e.key === 'Escape') {
    if (text.value === props.value)
      return;
    e.preventDefault();
    e.stopPropagation();
    revert();
    edited = false;
  }
}

defineExpose({ revert, focus: (): void => el.value?.focus() });
</script>

<template>
  <div class="field commit-field">
    <textarea
      v-if="multiline"
      :id="id"
      ref="el"
      class="textarea"
      :rows="rows"
      :value="text"
      :maxlength="maxlength"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-label="label"
      :aria-invalid="shownError ? true : undefined"
      spellcheck="false"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <input
      v-else
      :id="id"
      ref="el"
      class="input"
      type="text"
      :value="text"
      :maxlength="maxlength"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-label="label"
      :aria-invalid="shownError ? true : undefined"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    >
    <span
      v-if="counter && maxlength && focused"
      class="form-hint commit-field-counter tabular"
      aria-live="polite"
    >
      {{ text.length }} / {{ maxlength }}
    </span>
    <p
      v-if="shownError"
      class="form-error"
    >
      {{ shownError }}
    </p>
  </div>
</template>

<style scoped>
/* The root's top edge is the field's top edge: the counter hangs above it, on the label's line, out of the flow */
.commit-field {
  position: relative;
}

.commit-field-counter {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--space-1));
  white-space: nowrap;
  pointer-events: none;
}
</style>
