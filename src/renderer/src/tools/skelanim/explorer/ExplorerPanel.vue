<script setup lang="ts">
// Skel Anim explorer (docs/skelanim/skelanim.md "UI"): toolbar (New Character / New Animation / New Folder / Refresh /
// Collapse), the folder → character → animation tree, context menus, keyboard (explorer zone), inline rename, rescans
// on window focus. Fills its container; the tool layout sizes it (WorkspaceState.explorerWidth).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ChevronsDownUp, Clapperboard, Copy, FolderPlus, FolderSearch, PencilLine, PersonStanding, RefreshCw,
  SquarePen, Trash2, Wrench
} from '@lucide/vue';
import IconButton from '../../../components/common/IconButton.vue';
import ToolbarSpacer from '../../../components/common/ToolbarSpacer.vue';
import { clamp } from '../../../core/util/math';
import { SEPARATOR, contextMenu, type MenuEntry } from '../../../services/contextMenu';
import { reportError } from '../../../services/errors';
import { shortcuts } from '../../../services/shortcuts';
import { isAtOrBelow, isContainer, relKey, useExplorerStore } from '../../../stores/explorer';
import type { ExplorerNode as Node } from '../../../stores/types';
import ExplorerNode from './ExplorerNode.vue';
import * as ops from './explorerOps';
import { NewAnimationIcon, NewCharacterIcon } from './icons';

const explorer = useExplorerStore();

const treeEl = ref<HTMLElement | null>(null);
const rowEls = new Map<string, HTMLElement>();

const rows = computed(() => explorer.rows);
const selected = computed(() => explorer.selected);
const activeDescendant = computed(() => selected.value ? rowId(selected.value.rel) : undefined);

/** Stable DOM ids per node key (aria-activedescendant), so inserting a row does not re-render the rows below it. */
const ids = new Map<string, string>();
function rowId(rel: string): string {
  const key = relKey(rel);
  let id = ids.get(key);
  if (id === undefined) {
    id = `explorer-row-${ids.size + 1}`;
    ids.set(key, id);
  }
  return id;
}

/** The container whose indent guide is highlighted: the selected expanded container, else the selection's parent. */
const activeContainer = computed<Node | null>(() => {
  const s = selected.value;
  if (!s)
    return null;
  return isContainer(s) && s.expanded ? s : explorer.node(s.parentRel);
});

function activeGuideOf(row: Node): number {
  const c = activeContainer.value;
  return c && row.depth > c.depth && isAtOrBelow(row.rel, c.rel) ? c.depth : -1;
}

function setRowEl(rel: string, el: unknown): void {
  const node = el && typeof el === 'object' && '$el' in el ? (el as { $el: unknown }).$el : el;
  if (node instanceof HTMLElement)
    rowEls.set(relKey(rel), node);
  else
    rowEls.delete(relKey(rel));
}

/** Run a UI action; failures become an error toast with `title`. */
function run(title: string, action: () => Promise<unknown> | void): void {
  Promise.resolve().then(action).catch((e: unknown) => reportError(e, title));
}

/** Focus the tree (keeps focus already inside it unless `force`, e.g. when the focused rename field goes away). */
function focusTree(force = false): void {
  if (treeEl.value && (force || !treeEl.value.contains(document.activeElement)))
    treeEl.value.focus({ preventScroll: true });
}

// ---------- toolbar ----------

const newCharacter = (): void => run('Could not create the character', ops.newCharacter);
const newAnimation = (): void => run('Could not create the animation', ops.newAnimation);
const newFolder = (): void => run('Could not create the folder', ops.newFolder);
const refresh = (): void => run('Could not rescan the data folder', explorer.refresh);
const canNewAnimation = computed(() => explorer.targetCharacterRel !== null);

// ---------- row events ----------

function onSelect(node: Node): void {
  focusTree();
  explorer.select(node.rel);
  if (node.kind === 'animation')
    run('Could not open the animation', () => ops.openAnimation(node.rel));
}

function onActivate(node: Node): void {
  if (node.kind === 'animation')
    return; // the click already opened it
  const title = node.kind === 'character' ? 'Could not open the character' : node.kind === 'brokenCharacter' ? 'Could not repair the character' : 'Something went wrong';
  run(title, () => ops.activateNode(node));
}

function onToggle(node: Node): void {
  focusTree();
  explorer.select(node.rel);
  explorer.toggle(node.rel);
}

function deleteNode(node: Node): void {
  run(`Could not delete "${node.name}"`, () => ops.deleteNode(node));
}

const NEW_CHARACTER: MenuEntry = { label: 'New Character', icon: NewCharacterIcon, action: newCharacter };
const NEW_ANIMATION: MenuEntry = { label: 'New Animation', icon: NewAnimationIcon, action: newAnimation };
/** Always at the root (folders exist only there), whichever row was right-clicked. */
const NEW_FOLDER: MenuEntry = { label: 'New Folder', icon: FolderPlus, action: newFolder };

function menuFor(node: Node | null): MenuEntry[] {
  const reveal = { label: 'Reveal in File Explorer', icon: FolderSearch, action: () => run('Could not reveal', () => ops.revealNode(node)) };
  if (node === null) {
    return [
      NEW_CHARACTER,
      NEW_FOLDER,
      SEPARATOR,
      { label: 'Refresh', icon: RefreshCw, action: refresh },
      reveal
    ];
  }
  const rename = { label: 'Rename', icon: PencilLine, shortcut: 'F2', action: () => ops.startRename(node) };
  const del = { label: 'Delete', icon: Trash2, shortcut: 'Del', danger: true, action: () => deleteNode(node) };
  switch (node.kind) {
    case 'folder':
      return [NEW_CHARACTER, NEW_FOLDER, SEPARATOR, rename, del, SEPARATOR, reveal];
    case 'character':
      return [
        NEW_ANIMATION,
        NEW_FOLDER,
        { label: 'Edit Character…', icon: SquarePen, action: () => run('Could not open the character', () => ops.editCharacter(node.rel)) },
        SEPARATOR, rename, del, SEPARATOR, reveal
      ];
    case 'animation':
      return [
        { label: 'Open', icon: Clapperboard, shortcut: 'Enter', action: () => run('Could not open the animation', () => ops.openAnimation(node.rel)) },
        // Right-click selected the row, so New Animation goes to this animation's character
        NEW_ANIMATION,
        { label: 'Duplicate', icon: Copy, action: () => run(`Could not duplicate "${node.name}"`, () => ops.duplicateAnimation(node)) },
        SEPARATOR, rename, del, SEPARATOR, reveal
      ];
    default:
      return [
        { label: 'Repair', icon: Wrench, action: () => run('Could not repair the character', () => ops.repairNode(node)) },
        SEPARATOR, del, SEPARATOR, reveal
      ];
  }
}

function onRowMenu(node: Node, e: MouseEvent): void {
  focusTree();
  explorer.select(node.rel);
  contextMenu.open(e, menuFor(node));
}

/** Right-click on empty space (or the keyboard menu key: the selected row's menu at the row). */
function onTreeMenu(e: MouseEvent): void {
  const sel = selected.value;
  if (e.button !== 2 && sel) {
    const r = rowEls.get(relKey(sel.rel))?.getBoundingClientRect();
    e.preventDefault();
    contextMenu.open(r ? { x: r.left + 24, y: r.bottom } : e, menuFor(sel));
    return;
  }
  focusTree();
  explorer.select(null);
  contextMenu.open(e, menuFor(null));
}

/** Pointer down on empty tree space clears the selection (so New Character goes to the root). */
function onTreeMouseDown(e: MouseEvent): void {
  if (e.button !== 0 || (e.target instanceof Element && e.target.closest('.explorer-row')))
    return;
  const tree = treeEl.value;
  if (tree && e.target === tree && e.offsetX >= tree.clientWidth)
    return; // the scrollbar
  explorer.select(null);
}

// ---------- keyboard (explorer zone) ----------

function moveTo(index: number): void {
  const list = rows.value;
  if (list.length === 0)
    return;
  explorer.select(list[clamp(index, 0, list.length - 1)].rel, { reveal: true });
}

function move(delta: number): void {
  const i = selected.value ? rows.value.indexOf(selected.value) : -1;
  moveTo(i < 0 ? (delta > 0 ? 0 : rows.value.length - 1) : i + delta);
}

function pageRows(): number {
  const h = treeEl.value?.clientHeight ?? 0;
  const rowH = rowEls.values().next().value?.offsetHeight ?? 22;
  return Math.max(1, Math.floor(h / rowH) - 1);
}

function collapseOrParent(): void {
  const s = selected.value;
  if (!s)
    return move(1);
  if (isContainer(s) && s.expanded)
    explorer.setExpanded(s.rel, false);
  else if (s.parentRel !== null)
    explorer.select(s.parentRel, { reveal: true });
}

function expandOrChild(): void {
  const s = selected.value;
  if (!s)
    return move(1);
  if (!isContainer(s))
    return;
  if (!s.expanded)
    explorer.setExpanded(s.rel, true);
  else if (s.children.length > 0)
    explorer.select(s.children[0].rel, { reveal: true });
}

/** Keys aimed at a focused toolbar button stay with the button. */
const fromButton = (e: KeyboardEvent): boolean => e.target instanceof HTMLButtonElement;

const withSelection = (fn: (n: Node) => void) => (e: KeyboardEvent): boolean | void => {
  if (fromButton(e) || !selected.value)
    return false;
  fn(selected.value);
};

const offShortcuts: (() => void)[] = [];

function registerShortcuts(): void {
  const on = (combo: string, handler: (e: KeyboardEvent) => boolean | void): void => {
    offShortcuts.push(shortcuts.register('explorer', combo, handler));
  };
  on('up', () => move(-1));
  on('down', () => move(1));
  on('home', () => moveTo(0));
  on('end', () => moveTo(rows.value.length - 1));
  on('pageup', () => move(-pageRows()));
  on('pagedown', () => move(pageRows()));
  on('left', collapseOrParent);
  on('right', expandOrChild);
  on('enter', withSelection((n) => run('Could not open', () => ops.activateNode(n))));
  on('f2', withSelection((n) => {
    if (n.kind !== 'brokenCharacter')
      ops.startRename(n);
  }));
  on('delete', withSelection(deleteNode));
}

// ---------- rename ----------

/** After Enter / Escape in the rename field, keyboard focus goes back to the tree (a blur keeps the new focus). */
function onCommit(node: Node, name: string, byKey: boolean): void {
  if (byKey)
    focusTree(true);
  void ops.commitRename(node, name);
}

function onCancel(node: Node, byKey: boolean): void {
  if (byKey)
    focusTree(true);
  ops.cancelRename(node);
}

// ---------- scroll the selection into view ----------

let pendingScroll = false;

async function scrollSelectionIntoView(): Promise<void> {
  await nextTick();
  const rel = explorer.selectedRel;
  const el = rel === null ? undefined : rowEls.get(relKey(rel));
  if (!el)
    return;
  pendingScroll = false;
  el.scrollIntoView({ block: 'nearest' });
}

watch(() => explorer.revealSeq, () => {
  pendingScroll = true;
  void scrollSelectionIntoView();
});

// A reveal that arrived before its row existed (new node, scan pending) scrolls once the row renders
watch(rows, () => {
  if (pendingScroll)
    void scrollSelectionIntoView();
});

// ---------- lifecycle ----------

const onWindowFocus = (): void => explorer.scheduleRescan();

onMounted(() => {
  registerShortcuts();
  window.addEventListener('focus', onWindowFocus);
  refresh();
});

onBeforeUnmount(() => {
  for (const off of offShortcuts.splice(0))
    off();
  window.removeEventListener('focus', onWindowFocus);
});
</script>

<template>
  <section
    class="panel explorer"
    data-zone="explorer"
  >
    <header class="panel-header explorer-header">
      <span class="explorer-title">Explorer</span>
      <ToolbarSpacer />
      <div
        class="explorer-actions"
        role="toolbar"
        aria-label="Explorer actions"
      >
        <IconButton
          :icon="NewCharacterIcon"
          size="sm"
          tooltip="New Character"
          @click="newCharacter"
        />
        <IconButton
          :icon="NewAnimationIcon"
          size="sm"
          :tooltip="canNewAnimation ? 'New Animation' : 'New Animation (select a character first)'"
          :disabled="!canNewAnimation"
          @click="newAnimation"
        />
        <IconButton
          :icon="FolderPlus"
          size="sm"
          tooltip="New Folder"
          @click="newFolder"
        />
        <IconButton
          :icon="RefreshCw"
          size="sm"
          tooltip="Refresh"
          @click="refresh"
        />
        <IconButton
          :icon="ChevronsDownUp"
          size="sm"
          tooltip="Collapse All"
          @click="explorer.collapseAll()"
        />
      </div>
    </header>
    <div
      ref="treeEl"
      class="panel-body list explorer-tree"
      role="tree"
      tabindex="0"
      aria-label="Characters and animations"
      :aria-activedescendant="activeDescendant"
      @mousedown="onTreeMouseDown"
      @contextmenu="onTreeMenu"
    >
      <ExplorerNode
        v-for="row in rows"
        :key="relKey(row.rel)"
        :ref="(el) => setRowEl(row.rel, el)"
        :node="row"
        :row-id="rowId(row.rel)"
        :active-guide="activeGuideOf(row)"
        :validate="ops.renameError"
        @select="onSelect"
        @activate="onActivate"
        @toggle="onToggle"
        @menu="onRowMenu"
        @repair="(n) => run('Could not repair the character', () => ops.repairNode(n))"
        @commit="onCommit"
        @cancel="onCancel"
      />
      <div
        v-if="explorer.loaded && rows.length === 0"
        class="empty-state explorer-empty"
      >
        <PersonStanding
          :size="28"
          class="text-faint"
        />
        <div class="empty-state-title">
          No characters yet
        </div>
        <p class="text-sm">
          A character groups the animations of one sprite. Folders are optional.
        </p>
        <div class="row gap-2 mt-2">
          <button
            type="button"
            class="btn btn-primary btn-sm"
            @click="newCharacter"
          >
            New Character
          </button>
          <button
            type="button"
            class="btn btn-sm"
            @click="newFolder"
          >
            <FolderPlus :size="14" />
            New Folder
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.explorer {
  width: 100%;
  height: 100%;
}

.explorer-header {
  gap: 0;
  padding-right: var(--space-1);
}

.explorer-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.explorer-actions {
  display: flex;
  align-items: center;
  gap: 1px;
}

.explorer-tree {
  padding: 2px 0 var(--space-4);
}

.explorer-empty {
  height: auto;
  padding-top: var(--space-6);
}
</style>

<style>
/* Kind icon with a plus badge (explorer/icons.ts withPlus); global because it renders inside IconButton / menus */
.icon-plus {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
}

.icon-plus-badge {
  position: absolute;
  right: -1px;
  bottom: -1px;
  display: inline-flex;
  color: var(--accent-hover);
}
</style>
