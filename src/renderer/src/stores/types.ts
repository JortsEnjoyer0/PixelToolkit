// Store-facing contracts (docs/skelanim/skelanim.md "Documents"). Implementations: stores/documents.ts, tabs.ts,
// jobs.ts, playback.ts, settings.ts, explorer.ts; stores/mockDoc.ts is an in-memory DocHandle for the testbed and node
// tests.
// The *StoreApi interfaces are the stores' public API for the UI and editor: a Pinia setup store implementing one must
// expose at least these members (refs unwrap on the store, so `readonly x: T` is a ref/computed of T inside the store).
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { ScanKind, ScanNode } from '@shared/api';
import type { JobUpdateEvent, SubmitAnimateResult } from '@shared/jobs';
import type { KeypointOut } from '@shared/pixellab';
import type { AppSettings, SettingsPatch } from '@shared/settings';
import type { CharacterMeta, FrameTarget, UndoableState } from '../core/model';
import type { UndoStack } from '../core/undo/UndoStack';
import type { DisplayOptions } from '../editor/types';

// Defined in core so editor/ can use them without importing stores.
export type { FrameTarget, UndoableState };

export interface ApplyOptions {
  /** Consecutive applies with the same key within mergeMs collapse into one undo entry (sliders, scrubbing). */
  mergeKey?: string;
  mergeMs?: number;
}

/** A doc's location at the moment an IO operation runs. Never keep it across awaits: renames change it. */
export interface DocPaths {
  /** Animation json ("Folder/Char/Anim.json"). */
  rel: string;
  /** Character dir ("Folder/Char"). */
  charRel: string;
  /** Animation name (image files are "<name>.<uid>.png"). */
  name: string;
}

/**
 * One open animation document. Everything reactive is shallow: `state` is an immutable, copy-on-write
 * UndoableState (frozen in dev); never mutate it, always go through apply(). UI code relies only on these members.
 * Handles are markRaw'd: keep them in shallowReactive / plain containers, never in reactive() / ref().
 */
export interface DocHandle {
  /** AnimationMeta.id; key of the documents map, tabs and jobs. */
  readonly id: string;
  /** Current json path ("Folder/Char/Anim.json"); the only place the path is stored. */
  rel: Ref<string>;
  /** Character dir ("Folder/Char"). */
  charRel: Ref<string>;
  /** Animation name (json basename). Renames are filesystem operations, not undoable. */
  name: Ref<string>;
  state: ShallowRef<UndoableState>;
  /** Not undoable; change it with setFps() so the doc gets dirty. */
  fps: Readonly<Ref<number>>;
  /** Bumped on every content change (apply, undo, redo, setFps, replaceState). Cheap watch key. */
  version: Readonly<Ref<number>>;
  /** Bumped on non-undoable content changes (fps). */
  metaRev: Readonly<Ref<number>>;
  /** state !== saved state || metaRev !== saved metaRev. Undoing back to the saved state clears it. */
  dirty: ComputedRef<boolean>;
  /** The undo history (named `history` because undo() / redo() below are the commands). */
  history: UndoStack<UndoableState>;
  /** The json vanished from disk; the next save recreates it. */
  missingOnDisk: Ref<boolean>;
  /** Push producer(state) as one undo entry labelled `label`. A producer returning the same object is a no-op. */
  apply(label: string, producer: (s: UndoableState) => UndoableState, opts?: ApplyOptions): void;
  /** Returns the undone entry's label, or null when there is nothing to undo. */
  undo(): string | null;
  redo(): string | null;
  setFps(fps: number): void;
  /** Record the current state + metaRev as saved (after a successful write). */
  markSaved(): void;
  /** Replace the content and clear the history (clean reload from disk). */
  replaceState(state: UndoableState, fps: number): void;
  /**
   * Run `op` on this doc's serial IO queue (saves, renames, image imports and moves, GC;
   * docs/skelanim/skelanim.md "Saving, DocIO and image GC"). `op` receives the paths current at execution time, e.g.
   * `doc.runIo((p) => api.images.importReference(p.charRel, p.name))`.
   */
  runIo<T>(op: (paths: DocPaths) => Promise<T>): Promise<T>;
  /** Register an image uid this doc created this session (reference import / copy, job result): a GC candidate. */
  noteCreatedImage(uid: string): void;
}

/** Explorer tree node: a ScanNode plus UI flags. Keyed by rel, so flags survive a rescan. */
export interface ExplorerNode {
  kind: ScanKind;
  name: string;
  /** Key (see ScanNode.rel): folder dir, character dir, animation json. */
  rel: string;
  /** Parent node rel, null at the root. */
  parentRel: string | null;
  depth: number;
  mtimeMs: number | null;
  children: ExplorerNode[];
  expanded: boolean;
  selected: boolean;
  /** Inline rename (F2) in progress. */
  renaming: boolean;
  /** Animation: has an open tab. Folder / character: any descendant has. */
  open: boolean;
  /** Animation: its doc is dirty. Folder / character: any descendant is. */
  dirty: boolean;
  /** An API call (estimate or job) is pending for it or a descendant. */
  busy: boolean;
}

/** What the TabBar renders for one open doc (tabs store keeps only docIds; the rest is derived). */
export interface TabInfo {
  docId: string;
  /** Animation name. */
  label: string;
  /** For the tooltip "Character / Animation" and the duplicate-name suffix. */
  charName: string;
  /** Another open tab has the same label: show a dim charName suffix. */
  showCharSuffix: boolean;
  active: boolean;
  dirty: boolean;
  busy: boolean;
  missingOnDisk: boolean;
}

// ---------- store APIs ----------

/** stores/documents.ts: open docs, the character cache and the IO-aware entity operations. */
export interface DocumentsStoreApi {
  /** Open docs by id (shallowReactive Map). */
  readonly docs: ReadonlyMap<string, DocHandle>;
  /** Loaded character metas by charRel (shallowReactive Map; values are replaced, never mutated). */
  readonly characters: ReadonlyMap<string, CharacterMeta>;
  /** Some doc IO is queued or running (the explorer skips focus rescans while true). */
  readonly ioBusy: boolean;
  get(docId: string): DocHandle | undefined;
  /** The open doc whose json is `rel` (case-insensitive), if any. */
  findByRel(rel: string): DocHandle | undefined;
  /** Load the animation json, or return the already open doc. UI opens tabs (TabsStoreApi.open), not docs. */
  load(rel: string): Promise<DocHandle>;
  /** Save now (Ctrl+S, close prompts; queued). `auto` = autosave toast wording. false on failure (toast shown). */
  save(docId: string, opts?: { auto?: boolean }): Promise<boolean>;
  /** Drop a doc without prompting: drain its queue, GC, discard the history. (EditorPane then calls viewport.forgetDocument.) */
  unload(docId: string): Promise<void>;
  /**
   * Rename an animation on disk, open or not (images first, then the json; validated against its siblings).
   * Used by the explorer (F2) and the panel's Name field. Resolves the new rel; rejects with a user-facing message.
   */
  renameAnimation(rel: string, newName: string): Promise<string>;
  /**
   * Run an explorer filesystem operation on `rel` (folder or character dir, or an animation json) while the IO queues
   * of the open docs at or below it are drained and paused. Then every affected doc is remapped: `remap(oldDocRel)`
   * returns its new json rel, or null when it was deleted (the doc is unloaded and its tab closes without a prompt).
   * Pending jobs are retargeted the same way (api.jobs.retarget).
   */
  runExclusive<T>(rel: string, op: () => Promise<T>, remap: (docRel: string) => string | null): Promise<T>;
  /** Load (or reload) a character json into `characters`. */
  loadCharacter(charRel: string): Promise<CharacterMeta>;
  /** Serial read-modify-write of a character json (Character dialog edits, estimate cache). Returns the new meta. */
  updateCharacter(charRel: string, producer: (c: CharacterMeta) => CharacterMeta): Promise<CharacterMeta>;
  /** After a rescan: reload clean docs whose json changed on disk, mark vanished ones missingOnDisk, drop stale characters. */
  reconcile(scan: readonly ScanNode[]): Promise<void>;
}

/** stores/tabs.ts. Tabs hold only docIds; paths live in the DocHandle. The explorer watches activeDocId to reveal. */
export interface TabsStoreApi {
  /** Open docIds in tab order. */
  readonly order: readonly string[];
  readonly activeDocId: string | null;
  readonly activeDoc: DocHandle | null;
  /** Derived, in tab order. */
  readonly tabs: readonly TabInfo[];
  /** Open (loading if needed) or activate the tab of an animation json. */
  open(rel: string): Promise<DocHandle>;
  activate(docId: string): void;
  /** Close a tab; a dirty doc prompts Save / Don't Save / Cancel. Resolves false when cancelled. */
  close(docId: string): Promise<boolean>;
  /** Drag reorder: move the tab at index `from` to index `to`. */
  move(from: number, to: number): void;
}

/** stores/jobs.ts: mirrors main's job records (via 'jobs:update') and tracks in-flight estimates. */
export interface JobsStoreApi {
  /** Main's records, without snapshots. */
  readonly records: readonly JobUpdateEvent[];
  /** An estimate or a generation is pending for the doc (disables Estimate / Generate; spinners). */
  busy(docId: string): boolean;
  /** Pending work for an explorer node: an animation json `rel`, or anything below a folder / character dir `rel`. */
  busyUnder(rel: string): boolean;
  /** Unfinished generation jobs at or below `rel` (delete confirmation; cancel each with cancel()). */
  pendingUnder(rel: string): JobUpdateEvent[];
  /** The doc's newest unfinished generation (status line: queued, position, ETA), or null. */
  activeJob(docId: string): JobUpdateEvent | null;
  /**
   * 2D estimate for the doc's current reference image: the source base image's cached estimate unless `force`,
   * otherwise one API call (≈0.1 gen) whose result is cached into the character json. Resolves null when it failed
   * (toast shown) or went stale (doc closed or reference image changed meanwhile). The caller applies withEstimate().
   */
  estimate(docId: string, opts?: { force?: boolean }): Promise<KeypointOut[] | null>;
  /**
   * buildGeneration(current state) → api.jobs.submitAnimate. No dialogs: preflight and the cost confirm are the caller's.
   * A failure with `record` (PixelLab may have accepted and billed it) is already reported by this store's toast.
   */
  submitGenerate(docId: string): Promise<SubmitAnimateResult>;
  cancel(key: string): Promise<void>;
}

/** stores/playback.ts: sole owner of each doc's active target (FrameTarget, never an index). */
export interface PlaybackStoreApi {
  readonly playing: boolean;
  /** The doc's target; REF by default, and a vanished frame uid resolves to the nearest remaining frame. */
  target(docId: string): FrameTarget;
  setTarget(docId: string, target: FrameTarget): void;
  /** Play / pause the active doc over frames 1..N (looping; needs at least one frame). */
  play(): void;
  pause(): void;
  toggle(): void;
  /** Step the active doc's target by ±1 and pause. REF + 1 → frame 1; frame 1 − 1 → REF; no wrap-around. */
  step(delta: 1 | -1): void;
  /** REF. */
  seekStart(): void;
  /** Last frame (REF when the track is empty). */
  seekEnd(): void;
}

/** stores/settings.ts. */
export interface SettingsStoreApi {
  /** Masked settings (a stored secret reads as SECRET_MASK). DEFAULT_SETTINGS until load() resolves. */
  readonly settings: AppSettings;
  readonly loaded: boolean;
  /** settings.pixellab.apiKey is set (Generate preflight, balance button). */
  readonly hasPixelLabKey: boolean;
  load(): Promise<AppSettings>;
  /** api.settings.write(patch), then replaces `settings`. */
  save(patch: SettingsPatch): Promise<AppSettings>;
}

/** data/.ptk/workspace.json (docs/architecture.md "Workspace"): what is restored on launch. Written debounced. */
export interface WorkspaceState {
  version: 1;
  /** Open tabs as animation json rels, in order. */
  tabs: string[];
  activeRel: string | null;
  /** Expanded explorer node rels. */
  expanded: string[];
  /** Editor toolbar toggles (cocoEdit is saved false). */
  display: DisplayOptions;
  /** Explorer panel width, CSS px. */
  explorerWidth: number;
  /** Frame-track thumbnail height, CSS px (56..240). */
  thumbHeight: number;
}

/** stores/workspace.ts. */
export interface WorkspaceStoreApi {
  readonly state: Readonly<WorkspaceState>;
  /** Merge and schedule a debounced write. */
  update(patch: Partial<Omit<WorkspaceState, 'version'>>): void;
}
