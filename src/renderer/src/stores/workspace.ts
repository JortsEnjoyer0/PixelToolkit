// Workspace store (WorkspaceStoreApi; docs/architecture.md "Workspace"): data/.ptk/workspace.json holds the open tabs,
// the active tab, explorer expansion and width, the frame-track thumbnail height and the editor toolbar toggles (with
// the ghost frame count). It is read once when the store is created and written debounced (createDirs, since .ptk may
// not exist yet). Nothing is written before the read finished, so early update() calls never clobber the file; they are
// merged on top of it instead.
// restoreWorkspace() (reopening the saved tabs) lives in stores/tabs.ts.
import { defineStore } from 'pinia';
import { onScopeDispose, ref, shallowRef } from 'vue';
import { WORKSPACE_REL } from '@shared/dataPaths';
import { isObj, plainCopy } from '@shared/json';
import { deepFreeze } from '../core/util/freeze';
import { DEFAULT_DISPLAY, sanitizeGhostColor, sanitizeGhostCount, type DisplayOptions } from '../editor/types';
import { useSettingsStore } from './settings';
import type { WorkspaceState, WorkspaceStoreApi } from './types';

export const DEFAULT_EXPLORER_WIDTH = 260;
/** Frame-track thumbnail height, CSS px: the default and the range its splitter allows. */
export const THUMB_HEIGHT = 104;
export const THUMB_HEIGHT_MIN = 56;
export const THUMB_HEIGHT_MAX = 240;
const WRITE_DELAY_MS = 400;

type WorkspacePatch = Partial<Omit<WorkspaceState, 'version'>>;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Defaults: no tabs, editor toggles from settings.editor. */
function defaultWorkspace(): WorkspaceState {
  const ed = useSettingsStore().settings.editor;
  return {
    version: 1,
    tabs: [],
    activeRel: null,
    expanded: [],
    display: { ...DEFAULT_DISPLAY, showFloor: ed.showFloor, showFrameImage: ed.showFrameImage, showCoco: ed.showCoco },
    explorerWidth: DEFAULT_EXPLORER_WIDTH,
    thumbHeight: THUMB_HEIGHT
  };
}

const strings = (v: unknown): string[] | null => Array.isArray(v) && v.every((s) => typeof s === 'string') ? [...v] : null;

function parseDisplay(v: unknown, d: DisplayOptions): DisplayOptions {
  const raw = isObj(v) ? v : {};
  const bool = (k: keyof DisplayOptions): boolean => typeof raw[k] === 'boolean' ? raw[k] as boolean : d[k] as boolean;
  return {
    showFloor: bool('showFloor'),
    showFrameImage: bool('showFrameImage'),
    showCoco: bool('showCoco'),
    showSkeleton: bool('showSkeleton'),
    showGhosts: bool('showGhosts'),
    ghostCount: sanitizeGhostCount(raw.ghostCount, d.ghostCount),
    ghostColor: sanitizeGhostColor(raw.ghostColor, d.ghostColor),
    cocoEdit: false,
    gizmoMode: raw.gizmoMode === 'translate' ? 'translate' : 'rotate',
    gizmoSpace: raw.gizmoSpace === 'world' ? 'world' : 'local',
    ortho: bool('ortho')
  };
}

/** Validates workspace.json; anything missing or malformed falls back to `d`. cocoEdit is never restored. */
export function parseWorkspace(v: unknown, d: WorkspaceState): WorkspaceState {
  const raw = isObj(v) ? v : {};
  const width = raw.explorerWidth;
  const thumb = raw.thumbHeight;
  return {
    version: 1,
    tabs: strings(raw.tabs) ?? d.tabs,
    activeRel: typeof raw.activeRel === 'string' ? raw.activeRel : null,
    expanded: strings(raw.expanded) ?? d.expanded,
    display: parseDisplay(raw.display, d.display),
    explorerWidth: typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : d.explorerWidth,
    thumbHeight: typeof thumb === 'number' && thumb >= THUMB_HEIGHT_MIN && thumb <= THUMB_HEIGHT_MAX ? thumb : d.thumbHeight
  };
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const state = shallowRef<WorkspaceState>(deepFreeze(defaultWorkspace()));
  /** The file was read (or found missing / unreadable); writes are allowed from now on. */
  const loaded = ref(false);
  const early: WorkspacePatch[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingWrite = false;
  let writing: Promise<void> = Promise.resolve();

  const ready: Promise<void> = (async () => {
    let next = defaultWorkspace();
    try {
      if (await window.api.fs.exists(WORKSPACE_REL))
        next = parseWorkspace(await window.api.fs.readJson(WORKSPACE_REL), next);
    } catch (e) {
      console.warn('[workspace] could not read workspace.json; using defaults', e);
    }
    for (const patch of early)
      next = { ...next, ...patch };
    state.value = deepFreeze(plainCopy(next));
    loaded.value = true;
    if (early.length > 0)
      schedule();
    early.length = 0;
  })();

  function write(): Promise<void> {
    pendingWrite = false;
    const data = plainCopy(state.value);
    writing = writing.then(async () => {
      await window.api.fs.writeJson(WORKSPACE_REL, data, { createDirs: true });
    }).catch((e: unknown) => console.warn('[workspace] could not write workspace.json', e));
    return writing;
  }

  function schedule(): void {
    pendingWrite = true;
    if (timer !== null)
      clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, WRITE_DELAY_MS);
  }

  /** Merge and schedule a debounced write (no-op when nothing changes). */
  function update(patch: WorkspacePatch): void {
    const copy = plainCopy(patch); // patches may hold reactive arrays; IPC cannot clone proxies
    const next = { ...state.value, ...copy };
    if (sameJson(next, state.value))
      return;
    state.value = deepFreeze(next);
    if (!loaded.value) {
      early.push(copy);
      return;
    }
    schedule();
  }

  /** Write a pending change now (app close) and wait for in-flight writes. */
  async function flush(): Promise<void> {
    await ready;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingWrite)
      await write();
    await writing;
  }

  /** Resolves once workspace.json was read (restoreWorkspace waits for it). */
  function whenLoaded(): Promise<void> {
    return ready;
  }

  onScopeDispose(() => {
    if (timer !== null)
      clearTimeout(timer);
  });

  return { state, loaded, update, flush, whenLoaded };
});

/** The store typed as its public API (also a compile-time check that it satisfies WorkspaceStoreApi). */
export function useWorkspaceApi(): WorkspaceStoreApi {
  return useWorkspaceStore();
}
