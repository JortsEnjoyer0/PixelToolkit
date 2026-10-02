<script setup lang="ts">
// One explorer tree row (the panel renders the visible rows flat): indent guides, twisty, kind icon, name or the
// inline rename field, and badges (dirty dot, busy spinner, repair button). Emits everything; ExplorerPanel acts.
import { computed, nextTick, ref, watch } from 'vue';
import { ChevronRight, Wrench } from '@lucide/vue';
import IconButton from '../../../components/common/IconButton.vue';
import Spinner from '../../../components/common/Spinner.vue';
import { isContainer } from '../../../stores/explorer';
import type { ExplorerNode } from '../../../stores/types';
import { nodeIcon } from './icons';

const props = defineProps<{
  node: ExplorerNode;
  /** DOM id (aria-activedescendant). */
  rowId: string;
  /** Depth of the indent guide to highlight (the selected node's container), or -1. */
  activeGuide: number;
  /** Rename validation: message or null (stable function, so unchanged rows skip re-rendering). */
  validate: (node: ExplorerNode, name: string) => string | null;
}>();

const emit = defineEmits<{
  select: [node: ExplorerNode, e: MouseEvent];
  activate: [node: ExplorerNode, e: MouseEvent];
  toggle: [node: ExplorerNode];
  menu: [node: ExplorerNode, e: MouseEvent];
  repair: [node: ExplorerNode];
  /** `byKey`: Enter / Escape (focus returns to the tree), not a blur. */
  commit: [node: ExplorerNode, name: string, byKey: boolean];
  cancel: [node: ExplorerNode, byKey: boolean];
}>();

const container = computed(() => isContainer(props.node));
const icon = computed(() => nodeIcon(props.node));
/** Containers show their descendants' state only while collapsed (expanded, the children show it). */
const showDirty = computed(() => props.node.dirty && (!container.value || !props.node.expanded));
const showBusy = computed(() => props.node.busy && (!container.value || !props.node.expanded));
const broken = computed(() => props.node.kind === 'brokenCharacter');
const tooltip = computed(() => broken.value ? `The folder of "${props.node.name}" is missing. Repair recreates it.` : null);

// ---------- inline rename ----------

const draft = ref('');
const touched = ref(false);
const input = ref<HTMLInputElement | null>(null);
let finished = false;
const error = computed(() => draft.value === props.node.name ? null : props.validate(props.node, draft.value));

watch(() => props.node.renaming, async (renaming) => {
  if (!renaming)
    return;
  draft.value = props.node.name;
  touched.value = false;
  finished = false;
  await nextTick();
  input.value?.focus({ preventScroll: true });
  input.value?.select();
}, { immediate: true });

function commit(byKey: boolean): void {
  if (finished)
    return;
  touched.value = true;
  if (error.value)
    return;
  finished = true;
  if (draft.value === props.node.name)
    emit('cancel', props.node, byKey);
  else
    emit('commit', props.node, draft.value, byKey);
}

function cancel(byKey: boolean): void {
  if (finished)
    return;
  finished = true;
  emit('cancel', props.node, byKey);
}

/** Blur commits a valid name and drops an invalid one (VS Code behaviour). */
function onBlur(): void {
  if (error.value)
    cancel(false);
  else
    commit(false);
}

function onInputKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    commit(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancel(true);
  }
}

function onTwisty(): void {
  if (container.value)
    emit('toggle', props.node);
}
</script>

<template>
  <div
    :id="rowId"
    v-tooltip="tooltip"
    class="list-row tree-row explorer-row"
    :class="{
      'is-selected': node.selected,
      'is-open': node.open,
      'is-broken': broken,
      'is-renaming': node.renaming,
      [`kind-${node.kind}`]: true
    }"
    role="treeitem"
    :aria-level="node.depth + 1"
    :aria-expanded="container ? node.expanded : undefined"
    :aria-selected="node.selected"
    :aria-label="node.name"
    :style="{ '--depth': node.depth }"
    @click="emit('select', node, $event)"
    @dblclick="emit('activate', node, $event)"
    @contextmenu.stop.prevent="emit('menu', node, $event)"
  >
    <span
      v-for="d in node.depth"
      :key="d"
      class="explorer-guide"
      :class="{ 'is-active': d - 1 === activeGuide }"
      :style="{ '--guide': d - 1 }"
    />
    <span
      class="tree-twisty"
      :class="{ 'is-open': node.expanded, 'is-leaf': !container }"
      @click.stop="onTwisty"
      @dblclick.stop
    >
      <ChevronRight :size="14" />
    </span>
    <component
      :is="icon"
      class="list-row-icon explorer-icon"
      :size="16"
    />
    <template v-if="node.renaming">
      <input
        ref="input"
        v-model="draft"
        class="input input-sm explorer-rename-input"
        :class="{ 'is-invalid': touched && error }"
        :aria-invalid="!!error"
        spellcheck="false"
        autocomplete="off"
        @input="touched = true"
        @keydown="onInputKey"
        @blur="onBlur"
        @click.stop
        @dblclick.stop
        @mousedown.stop
        @contextmenu.stop
      >
      <div
        v-if="touched && error"
        class="explorer-rename-error"
        role="alert"
      >
        {{ error }}
      </div>
    </template>
    <span
      v-else
      class="list-row-label explorer-label"
    >{{ node.name }}</span>
    <span class="explorer-badges">
      <Spinner
        v-if="showBusy"
        :size="12"
        label="Generating"
      />
      <span
        v-if="showDirty"
        v-tooltip="'Unsaved changes'"
        class="dot explorer-dirty"
      />
      <IconButton
        v-if="broken"
        class="explorer-repair"
        :icon="Wrench"
        size="sm"
        tooltip="Repair"
        @click.stop="emit('repair', node)"
      />
    </span>
  </div>
</template>

<style scoped>
/* VS Code-style tree row. Generic row / twisty / selection styling comes from controls.css (.list-row, .tree-row). */
.explorer-row {
  --guide-color: var(--tree-guide);
  height: 22px;
  gap: 4px;
  padding-right: var(--space-1);
  color: var(--text);
}

.explorer-tree:hover .explorer-row {
  --guide-color: var(--tree-guide-hover);
}

/* Keyboard focus on the tree: outline the selected row (mouse focus shows the selection colour only) */
.explorer-tree:focus-visible .explorer-row.is-selected {
  box-shadow: inset 0 0 0 1px var(--focus-ring);
}

.explorer-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  left: calc(var(--space-1) + var(--guide) * var(--tree-indent) + 7.5px);
  width: 1px;
  background: var(--guide-color);
  pointer-events: none;
}

.explorer-guide.is-active {
  background: var(--tree-guide-active);
}

.explorer-row .tree-twisty:not(.is-leaf):hover {
  color: var(--text);
}

/* Kind icons: muted, with a subtle blue bias; an open animation lights up */
.explorer-icon {
  color: var(--text-faint);
  transition: color var(--speed-fast) var(--ease);
}

.kind-folder .explorer-icon {
  color: var(--icon-folder);
}

.kind-character .explorer-icon {
  color: var(--icon-character);
}

.kind-animation .explorer-icon {
  color: var(--text-faint);
}

.kind-animation.is-open .explorer-icon,
.kind-character.is-open:not([aria-expanded='true']) .explorer-icon,
.kind-folder.is-open:not([aria-expanded='true']) .explorer-icon {
  color: var(--accent-hover);
}

.list-row.is-selected .explorer-icon {
  color: inherit;
}

.kind-animation.is-open.is-selected .explorer-icon {
  color: var(--accent-hover);
}

.is-broken .explorer-icon {
  color: var(--warning);
}

.is-broken .explorer-label {
  color: var(--text-dim);
  font-style: italic;
}

.explorer-badges {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--text-dim);
}

.explorer-dirty {
  width: 7px;
  height: 7px;
  margin-right: 4px;
  color: var(--text-dim);
}

.explorer-repair {
  width: 18px;
  height: 18px;
  color: var(--warning-text);
}

/* Inline rename */
.explorer-row.is-renaming {
  overflow: visible;
}

.explorer-rename-input {
  flex: 1 1 auto;
  height: 20px;
  margin-right: 2px;
  padding: 0 4px;
  border-radius: var(--radius-sm);
}

.explorer-rename-error {
  position: absolute;
  top: calc(100% - 1px);
  left: calc(var(--space-1) + var(--depth, 0) * var(--tree-indent) + 40px);
  right: var(--space-2);
  z-index: var(--z-raised);
  padding: 4px 6px;
  border: 1px solid var(--danger);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  background: var(--danger-bg);
  color: var(--danger-text);
  font-size: var(--font-size-xs);
  line-height: 1.35;
  white-space: normal;
  box-shadow: var(--shadow-md);
}
</style>
