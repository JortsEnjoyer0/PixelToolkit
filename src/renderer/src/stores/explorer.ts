// Explorer state (PLAN §6 Explorer): the scanned data tree as ExplorerNodes, expansion (persisted through the
// workspace), selection, inline rename, rescans (Refresh, window focus) and the serial queue that explorer filesystem
// operations run on (tools/skelanim/explorer/explorerOps.ts). Nodes are keyed by rel (case-insensitive), so expansion
// and selection survive rescans; unchanged nodes keep their object identity across recomputes (cheap re-renders).
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import type { ScanNode } from '@shared/api';
import { parentRel } from '@shared/dataPaths';
import { isAtOrBelow, relKey, remapRel } from '../core/util/relPath';
import { reportError } from '../services/errors';
import { lifecycle } from '../services/lifecycle';
import { useDocumentsStore } from './documents';
import { useJobsStore } from './jobs';
import { useTabsStore } from './tabs';
import { useWorkspaceStore } from './workspace';
import type { ExplorerNode } from './types';

export { isAtOrBelow, relKey, remapRel };

/** The scan node at `rel` (case-insensitive), searching the whole tree. */
export function findScanNode(nodes: readonly ScanNode[], rel: string): ScanNode | null {
  const key = relKey(rel);
  for (const n of nodes) {
    const k = relKey(n.rel);
    if (k === key)
      return n;
    if (key.startsWith(k + '/')) {
      const hit = findScanNode(n.children, rel);
      if (hit)
        return hit;
    }
  }
  return null;
}

/** Folders and characters have children (shown with a twisty, even when empty). */
export const isContainer = (n: { kind: ExplorerNode['kind'] }): boolean => n.kind === 'folder' || n.kind === 'character';

/** The data-root-relative ancestors of a rel, nearest first ("F/C/A.json" → ["F/C", "F"]). */
export function ancestorRels(rel: string): string[] {
  const out: string[] = [];
  for (let p = parentRel(rel); p !== ''; p = parentRel(p))
    out.push(p);
  return out;
}

const FOCUS_RESCAN_MS = 300;
const BUSY_RETRY_MS = 500;
const BUSY_RETRIES = 10;

function sameNode(a: ExplorerNode, b: ExplorerNode): boolean {
  if (a.kind !== b.kind || a.name !== b.name || a.rel !== b.rel || a.parentRel !== b.parentRel || a.depth !== b.depth
    || a.mtimeMs !== b.mtimeMs || a.expanded !== b.expanded || a.selected !== b.selected || a.renaming !== b.renaming
    || a.open !== b.open || a.dirty !== b.dirty || a.busy !== b.busy || a.children.length !== b.children.length)
    return false;
  return a.children.every((c, i) => c === b.children[i]);
}

interface TreeModel { roots: readonly ExplorerNode[]; byKey: ReadonlyMap<string, ExplorerNode> }

export const useExplorerStore = defineStore('explorer', () => {
  const documents = useDocumentsStore();
  const tabs = useTabsStore();
  const jobs = useJobsStore();
  const workspace = useWorkspaceStore();

  /** Last scanData() result. */
  const scan = shallowRef<readonly ScanNode[]>([]);
  /** The first scan finished. */
  const loaded = ref(false);
  const scanning = ref(false);
  /** Expanded nodes: key → rel as last seen (persisted as WorkspaceState.expanded). */
  const expanded = shallowRef<ReadonlyMap<string, string>>(toExpandedMap(workspace.state.expanded));
  const selectedRel = ref<string | null>(null);
  /** Node in inline rename (F2), or null. */
  const renamingRel = ref<string | null>(null);
  /** Bumped when the selected row should be scrolled into view (keyboard moves, tab reveal, new nodes). */
  const revealSeq = ref(0);
  /** Explorer filesystem operations running (focus rescans wait for them). */
  const opsRunning = ref(0);

  function toExpandedMap(list: readonly string[] | undefined): Map<string, string> {
    return new Map((list ?? []).map((rel) => [relKey(rel), rel]));
  }

  // ---------- derived tree ----------

  /** Docs with an open tab: key + dirty (drives the open / dirty flags, aggregated on containers). */
  const openDocs = computed(() => {
    const out: { key: string; dirty: boolean }[] = [];
    for (const id of tabs.order) {
      const doc = documents.get(id);
      if (doc)
        out.push({ key: relKey(doc.rel.value), dirty: doc.dirty.value });
    }
    return out;
  });

  let memo = new Map<string, ExplorerNode>();

  const model = computed<TreeModel>(() => {
    const open = openDocs.value;
    const exp = expanded.value;
    const sel = selectedRel.value === null ? null : relKey(selectedRel.value);
    const ren = renamingRel.value === null ? null : relKey(renamingRel.value);
    const next = new Map<string, ExplorerNode>();
    const build = (list: readonly ScanNode[], parent: string | null, depth: number): ExplorerNode[] => list.map((s) => {
      const children = build(s.children, s.rel, depth + 1);
      const key = relKey(s.rel);
      let isOpen = false;
      let isDirty = false;
      for (const d of open) {
        if (s.kind === 'animation' ? d.key === key : d.key.startsWith(key + '/')) {
          isOpen = true;
          isDirty ||= d.dirty;
        }
      }
      const node: ExplorerNode = {
        kind: s.kind, name: s.name, rel: s.rel, parentRel: parent, depth, mtimeMs: s.mtimeMs, children,
        expanded: isContainer(s) && exp.has(key), selected: key === sel, renaming: key === ren,
        open: isOpen, dirty: isDirty, busy: jobs.busyUnder(s.rel)
      };
      const prev = memo.get(key);
      const out = prev && sameNode(prev, node) ? prev : node;
      next.set(key, out);
      return out;
    });
    const roots = build(scan.value, null, 0);
    memo = next;
    return { roots, byKey: next };
  });

  /** Top-level nodes (folders first, then characters and broken characters). */
  const tree = computed(() => model.value.roots);

  /** Visible rows in display order (children of expanded containers inline). */
  const rows = computed<readonly ExplorerNode[]>(() => {
    const out: ExplorerNode[] = [];
    const walk = (list: readonly ExplorerNode[]): void => {
      for (const n of list) {
        out.push(n);
        if (n.expanded)
          walk(n.children);
      }
    };
    walk(model.value.roots);
    return out;
  });

  const node = (rel: string | null): ExplorerNode | null => rel === null ? null : model.value.byKey.get(relKey(rel)) ?? null;

  const selected = computed(() => node(selectedRel.value));

  /** Where New Animation goes: the selected character, or the character of the selected animation. */
  const targetCharacterRel = computed<string | null>(() => {
    const n = selected.value;
    if (n?.kind === 'character')
      return n.rel;
    if (n?.kind === 'animation')
      return n.parentRel;
    return null;
  });

  /** Where New Character goes: the selected folder or the folder of the selected item, else the root (''). */
  const targetFolderRel = computed<string>(() => {
    let n = selected.value;
    while (n && n.kind !== 'folder')
      n = node(n.parentRel);
    return n?.rel ?? '';
  });

  /** Names of the node's siblings (rename validation). */
  function siblingNames(n: ExplorerNode): string[] {
    const list = n.parentRel === null ? model.value.roots : node(n.parentRel)?.children ?? [];
    return list.map((s) => s.name);
  }

  // ---------- expansion ----------

  function setExpandedMap(next: Map<string, string>): void {
    expanded.value = next;
    workspace.update({ expanded: [...next.values()] });
  }

  function setExpanded(rel: string, value: boolean): void {
    const key = relKey(rel);
    if (expanded.value.has(key) === value)
      return;
    const next = new Map(expanded.value);
    if (value)
      next.set(key, rel);
    else
      next.delete(key);
    setExpandedMap(next);
  }

  function toggle(rel: string): void {
    setExpanded(rel, !expanded.value.has(relKey(rel)));
  }

  function collapseAll(): void {
    if (expanded.value.size > 0)
      setExpandedMap(new Map());
    const sel = selected.value;
    if (sel && sel.depth > 0)
      select(ancestorRels(sel.rel).pop() ?? null, { reveal: true });
  }

  /** Adopt the workspace's list when it changes from outside (workspace.json loaded after this store). */
  watch(() => workspace.state.expanded, (list) => {
    const mine = [...expanded.value.values()];
    if (list.length !== mine.length || list.some((r, i) => r !== mine[i]))
      expanded.value = toExpandedMap(list);
  });

  // ---------- selection / reveal ----------

  function select(rel: string | null, opts: { reveal?: boolean } = {}): void {
    selectedRel.value = rel;
    if (opts.reveal && rel !== null)
      revealSeq.value++;
  }

  /** Select `rel`, expand its ancestors and scroll it into view. */
  function reveal(rel: string): void {
    const next = new Map(expanded.value);
    for (const a of ancestorRels(rel))
      next.set(relKey(a), a);
    if (next.size !== expanded.value.size)
      setExpandedMap(next);
    select(rel, { reveal: true });
  }

  // Activating a tab (also the already active one) reveals its animation. When the active doc only moves (its
  // animation, character or folder was renamed), a selection on the old path follows it; a selection elsewhere (e.g.
  // the renamed folder) stays put.
  watch(() => [tabs.activeDocId, tabs.activeDoc?.rel.value ?? null, tabs.activations] as const, ([id, rel, seq], old) => {
    if (rel === null)
      return;
    if (!old || id !== old[0] || seq !== old[2])
      reveal(rel);
    else if (old[1] !== null && selectedRel.value !== null && relKey(selectedRel.value) === relKey(old[1]))
      select(rel, { reveal: true });
  }, { immediate: true });

  // An open doc moved without an explorer operation (the panel's Name field renames through the documents store):
  // rescan when its new path is not in the tree yet
  watch(() => [...documents.docs.values()].map((d) => d.rel.value), (rels) => {
    if (loaded.value && rels.some((rel) => !model.value.byKey.has(relKey(rel))))
      refresh().catch((e: unknown) => reportError(e, 'Could not rescan the data folder'));
  });

  // ---------- inline rename ----------

  let renameResolve: ((rel: string) => void) | null = null;

  /** Start inline rename of `rel`; resolves the node's final rel when the rename is committed, cancelled or replaced. */
  function beginRename(rel: string): Promise<string> {
    const previous = renamingRel.value;
    if (previous !== null)
      takeRename()(previous);
    renamingRel.value = rel;
    select(rel, { reveal: true });
    return new Promise<string>((resolve) => {
      renameResolve = resolve;
    });
  }

  /** End the inline edit and hand back its resolver (call it with the final rel; the original rel on cancel / failure). */
  function takeRename(): (rel: string) => void {
    const resolve = renameResolve;
    renameResolve = null;
    renamingRel.value = null;
    return resolve ?? (() => undefined);
  }

  // ---------- path changes made by explorer operations ----------

  /** A folder / character / animation moved from `from` to `to`: carry expansion, selection and rename state along. */
  function remap(from: string, to: string): void {
    let changed = false;
    const next = new Map<string, string>();
    for (const rel of expanded.value.values()) {
      const r = remapRel(rel, from, to);
      changed ||= r !== rel;
      next.set(relKey(r), r);
    }
    if (changed)
      setExpandedMap(next);
    if (selectedRel.value !== null)
      selectedRel.value = remapRel(selectedRel.value, from, to);
    if (renamingRel.value !== null)
      renamingRel.value = remapRel(renamingRel.value, from, to);
  }

  /** Everything at or below `rel` is gone: drop its expansion (and the selection when it was inside). */
  function forget(rel: string): void {
    const next = new Map([...expanded.value].filter(([, r]) => !isAtOrBelow(r, rel)));
    if (next.size !== expanded.value.size)
      setExpandedMap(next);
    if (selectedRel.value !== null && isAtOrBelow(selectedRel.value, rel))
      selectedRel.value = null;
  }

  // ---------- scanning ----------

  let scanTask: Promise<void> | null = null;
  let scanQueued = false;

  /** Prune expansion of vanished containers; drop a selection / rename whose node vanished. */
  function afterScan(nodes: readonly ScanNode[]): void {
    const containers = new Set<string>();
    const all = new Set<string>();
    const walk = (list: readonly ScanNode[]): void => {
      for (const n of list) {
        all.add(relKey(n.rel));
        if (isContainer(n))
          containers.add(relKey(n.rel));
        walk(n.children);
      }
    };
    walk(nodes);
    const kept = new Map([...expanded.value].filter(([k]) => containers.has(k)));
    if (kept.size !== expanded.value.size)
      setExpandedMap(kept);
    const renaming = renamingRel.value;
    if (renaming !== null && !all.has(relKey(renaming)))
      takeRename()(renaming);
    const activeRel = tabs.activeDoc?.rel.value ?? null;
    if (selectedRel.value !== null && !all.has(relKey(selectedRel.value)) && selectedRel.value !== activeRel)
      selectedRel.value = null;
  }

  /**
   * Rescan the data root (main scanData), then let the documents store reconcile open docs with it. Concurrent calls
   * share the running scan, which runs once more when asked again meanwhile, so every caller sees a scan that started
   * after its call.
   */
  function refresh(): Promise<void> {
    if (scanTask) {
      scanQueued = true;
      return scanTask;
    }
    scanTask = (async () => {
      scanning.value = true;
      try {
        do {
          scanQueued = false;
          const nodes = await window.api.fs.scanData();
          scan.value = nodes;
          loaded.value = true;
          afterScan(nodes);
          await documents.reconcile(nodes);
        } while (scanQueued);
      } finally {
        scanning.value = false;
        scanTask = null;
      }
    })();
    return scanTask;
  }

  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let busyRetries = 0;

  /** Window focus: rescan after FOCUS_RESCAN_MS (debounced), postponed while doc IO or an explorer operation runs. */
  function scheduleRescan(delayMs = FOCUS_RESCAN_MS): void {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      if (lifecycle.isClosing())
        return;
      if (documents.ioBusy || opsRunning.value > 0) {
        if (busyRetries++ < BUSY_RETRIES)
          scheduleRescan(BUSY_RETRY_MS);
        return;
      }
      busyRetries = 0;
      refresh().catch((e: unknown) => reportError(e, 'Could not rescan the data folder'));
    }, delayMs);
  }

  // ---------- operation queue ----------

  let opTail: Promise<unknown> = Promise.resolve();

  /** Run an explorer filesystem operation after the previous ones (never nest: an op must not await another op). */
  function runOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = opTail.then(async () => {
      opsRunning.value++;
      try {
        return await fn();
      } finally {
        opsRunning.value--;
      }
    });
    opTail = run.catch(() => undefined);
    return run;
  }

  return {
    scan, loaded, scanning, selectedRel, renamingRel, revealSeq, opsRunning,
    tree, rows, selected, targetCharacterRel, targetFolderRel,
    node, siblingNames, isExpanded: (rel: string): boolean => expanded.value.has(relKey(rel)),
    setExpanded, toggle, collapseAll, select, reveal, beginRename, takeRename, remap, forget,
    refresh, scheduleRescan, runOp
  };
});
