// Tabs store (TabsStoreApi): the open docIds in tab order and the active one. Everything else a tab shows is derived
// from its DocHandle (TabInfo). A doc that leaves the documents store (unload, explorer delete) loses its tab at once.
// The tab list and active tab are persisted into the workspace. Also exported from here:
// - restoreWorkspace(): reopen the saved tabs that still exist (call after settings load);
// - installDocumentShortcuts(isActive): Ctrl+S, Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z on the active doc while isActive() (Skel
//   Anim is the shown tool); call once, App level.
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { charNameFromRel } from '@shared/dataPaths';
import { dialogs, isModalOpen } from '../services/dialogs';
import { cancelEditorInteraction, editorInteracting } from '../services/editorState';
import { mouseNotify } from '../services/mouseNotify';
import { blurTextField, shortcuts, type ShortcutHandler } from '../services/shortcuts';
import { useDocumentsStore } from './documents';
import { useWorkspaceStore } from './workspace';
import type { DocHandle, TabInfo, TabsStoreApi } from './types';
import { deps } from './doc/deps';

export const useTabsStore = defineStore('tabs', () => {
  const documents = useDocumentsStore();
  const workspace = useWorkspaceStore();
  const order = ref<string[]>([]);
  const activeDocId = ref<string | null>(null);
  const activeDoc = computed<DocHandle | null>(() => activeDocId.value === null ? null : documents.get(activeDocId.value) ?? null);
  const closing = new Map<string, Promise<boolean>>();
  /** Bumped by every activation, also of the already active tab (the explorer reveals the animation again). */
  const activations = ref(0);
  /** restoreWorkspace() is reopening tabs: don't persist the partial list. */
  let restoring = false;

  const tabs = computed<TabInfo[]>(() => {
    const jobs = deps.jobs();
    const open = order.value.map((id) => documents.get(id)).filter((d): d is DocHandle => d !== undefined);
    const counts = new Map<string, number>();
    for (const d of open)
      counts.set(d.name.value.toLowerCase(), (counts.get(d.name.value.toLowerCase()) ?? 0) + 1);
    return open.map((d): TabInfo => ({
      docId: d.id,
      label: d.name.value,
      charName: charNameFromRel(d.charRel.value),
      showCharSuffix: (counts.get(d.name.value.toLowerCase()) ?? 0) > 1,
      active: d.id === activeDocId.value,
      dirty: d.dirty.value,
      busy: jobs.busy(d.id),
      missingOnDisk: d.missingOnDisk.value
    }));
  });

  /** Drop a tab; when it was active, its right neighbour (else the left one) becomes active. */
  function remove(docId: string): void {
    const i = order.value.indexOf(docId);
    if (i < 0)
      return;
    order.value.splice(i, 1);
    if (activeDocId.value === docId)
      activeDocId.value = order.value[Math.min(i, order.value.length - 1)] ?? null;
  }

  // Before the panel switches to another doc, a focused field commits into the doc it was typed for (fields apply on
  // blur; tab clicks and toast actions keep the focus where it was). A modal holds the focus itself: leave it alone.
  watch(activeDocId, () => {
    if (!isModalOpen())
      blurTextField();
  }, { flush: 'sync' });

  // Docs unloaded elsewhere (explorer deletes) close their tab without a prompt
  watch(() => order.value.filter((id) => !documents.docs.has(id)), (gone) => {
    for (const id of gone)
      remove(id);
  }, { flush: 'sync' });

  async function openRel(rel: string, activate: boolean): Promise<DocHandle> {
    const doc = await documents.load(rel);
    if (!documents.docs.has(doc.id))
      throw new Error(`"${doc.name.value}" was closed while opening`);
    if (!order.value.includes(doc.id))
      order.value.push(doc.id);
    if (activate) {
      activeDocId.value = doc.id;
      activations.value++;
    }
    return doc;
  }

  /** Open (loading if needed) or activate the tab of an animation json. */
  function open(rel: string): Promise<DocHandle> {
    return openRel(rel, true);
  }

  function activate(docId: string): void {
    if (!order.value.includes(docId))
      return;
    activeDocId.value = docId;
    activations.value++;
  }

  async function closeNow(docId: string): Promise<boolean> {
    const doc = documents.get(docId);
    if (!doc) {
      remove(docId);
      return true;
    }
    if (docId === activeDocId.value) {
      cancelEditorInteraction();
      blurTextField(); // the panel shows this doc: a focused field's edit lands in it before dirty is read
    }
    if (doc.dirty.value) {
      const choice = await dialogs.choice({
        title: 'Unsaved changes',
        message: `Save changes to "${doc.name.value}" before closing?`,
        detail: 'Your changes will be lost if you don\'t save them.',
        buttons: [
          { id: 'save', label: 'Save', kind: 'primary' },
          { id: 'discard', label: 'Don\'t Save', kind: 'danger' },
          { id: 'cancel', label: 'Cancel' }
        ],
        cancelId: 'cancel'
      });
      if (choice === 'cancel')
        return false;
      if (choice === 'save' && documents.get(docId) && !await documents.save(docId))
        return false;
    }
    remove(docId);
    await documents.unload(docId);
    return true;
  }

  /** Close a tab; a dirty doc prompts Save / Don't Save / Cancel. Resolves false when cancelled (or the save failed). */
  function close(docId: string): Promise<boolean> {
    let p = closing.get(docId);
    if (!p) {
      p = closeNow(docId).finally(() => closing.delete(docId));
      closing.set(docId, p);
    }
    return p;
  }

  /** Drag reorder: move the tab at index `from` to index `to`. */
  function move(from: number, to: number): void {
    const list = order.value;
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length)
      return;
    const [id] = list.splice(from, 1);
    list.splice(to, 0, id);
  }

  /** Reopen saved tabs (in order, skipping ones that no longer exist or fail to load), then activate one. */
  async function restore(rels: readonly string[], activeRel: string | null): Promise<void> {
    restoring = true;
    try {
      for (const rel of rels) {
        try {
          if (await window.api.fs.exists(rel))
            await openRel(rel, false);
        } catch (e) {
          console.warn(`[tabs] could not reopen "${rel}"`, e);
        }
      }
      const target = activeRel === null ? undefined : documents.findByRel(activeRel);
      const id = target && order.value.includes(target.id) ? target.id : order.value[0] ?? null;
      if (id !== null && activeDocId.value === null)
        activeDocId.value = id;
    } finally {
      restoring = false;
    }
    persist();
  }

  const persisted = computed(() => ({
    tabs: order.value.map((id) => documents.get(id)?.rel.value).filter((r): r is string => r !== undefined),
    activeRel: activeDoc.value?.rel.value ?? null
  }));

  function persist(): void {
    if (!restoring)
      workspace.update(persisted.value);
  }

  watch(persisted, persist);

  return { order, activeDocId, activeDoc, activations, tabs, open, activate, close, move, restore };
});

/** The store typed as its public API (also a compile-time check that it satisfies TabsStoreApi). */
export function useTabsApi(): TabsStoreApi {
  return useTabsStore();
}

/** Reopen the workspace's saved tabs that still exist (missing ones are skipped silently). Call once after settings load. */
export async function restoreWorkspace(): Promise<void> {
  const workspace = useWorkspaceStore();
  await workspace.whenLoaded();
  const { tabs, activeRel } = workspace.state;
  await useTabsStore().restore(tabs, activeRel);
}

function undoRedo(kind: 'undo' | 'redo'): void {
  if (editorInteracting.value)
    return;
  const doc = useTabsStore().activeDoc;
  if (!doc)
    return;
  cancelEditorInteraction();
  const label = kind === 'undo' ? doc.undo() : doc.redo();
  if (label === null)
    mouseNotify(kind === 'undo' ? 'Nothing to undo' : 'Nothing to redo');
  else
    mouseNotify(`${kind === 'undo' ? 'Undo' : 'Redo'} ${label}`.trim());
}

let uninstallShortcuts: (() => void) | null = null;

/**
 * Global document shortcuts (idempotent; returns the uninstall function). Ctrl+S saves the active doc, also from text
 * fields (the field is blurred first so it commits). Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z undo / redo the active doc; text
 * fields keep their native undo, and they are skipped while the editor drags. Modals suppress all of them. While
 * `isActive()` is false (another tool is shown) they all decline, so the keys go to that tool or the browser.
 */
export function installDocumentShortcuts(isActive: () => boolean): () => void {
  if (uninstallShortcuts)
    return uninstallShortcuts;
  // Create the stores now: the documents store installs autosave, the close handler and the beforeunload guard
  useTabsStore();
  const gated = (fn: () => void): ShortcutHandler => () => {
    if (!isActive())
      return false;
    fn();
    return true;
  };
  const offs = [
    shortcuts.register('global', 'ctrl+s', gated(() => {
      const doc = useTabsStore().activeDoc;
      if (doc)
        void useDocumentsStore().save(doc.id);
    }), { allowInInputs: true, noRepeat: true }),
    shortcuts.register('global', 'ctrl+z', gated(() => undoRedo('undo')), { blockWhileInteracting: true }),
    shortcuts.register('global', 'ctrl+y', gated(() => undoRedo('redo')), { blockWhileInteracting: true }),
    shortcuts.register('global', 'ctrl+shift+z', gated(() => undoRedo('redo')), { blockWhileInteracting: true })
  ];
  uninstallShortcuts = () => {
    for (const off of offs)
      off();
    uninstallShortcuts = null;
  };
  return uninstallShortcuts;
}
