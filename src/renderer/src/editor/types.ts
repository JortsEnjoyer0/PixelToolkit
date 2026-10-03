// Editor contracts (docs/skelanim/skelanim.md "UI"). editor/ is three.js, non-reactive, and imports no stores: the app
// (EditorPane) and the testbed drive the same EditorViewport class through these interfaces.
import type { BoneName, FrameTarget, Pose, UndoableState, Vec3 } from '../core/model';
import { clamp } from '../core/util/math';

/** What the viewport reads and writes. Implemented by EditorPane (from a DocHandle) and by the testbed. */
export interface DocSource {
  /** Doc id: keys the per-doc texture cache (disposed when the doc closes). */
  readonly id: string;
  getState(): UndoableState;
  /** Changes whenever getState() content changes; refresh() compares it to skip work. */
  getVersion(): number;
  /** Image uid → loadable URL (ptk-asset://… in the app). */
  imageUrl(uid: string): string;
  /** One undo entry per gesture, on pointerup (e.g. "Rotate Left Forearm", "Move Hips"). */
  commitPose(target: FrameTarget, pose: Pose, label: string): void;
  /** COCO edit commit (REF only): 18 points, NECK ignored / re-derived; the doc recalibrates. */
  commitCoco(coco: Vec3[], label: string): void;
  /** Optional mirror of the 'livePose' event (rAF-throttled scratch pose during a drag). */
  onLivePose?(target: FrameTarget, pose: Pose): void;
}

/** A camera placement (orbit target + position + zoom). */
export interface CameraPose { pos: Vec3; target: Vec3; zoom: number }

/** Per-doc camera memory (kept by EditorPane in a non-reactive Map<docId, ViewState>). */
export interface ViewState {
  /** Camera that produced pos / zoom (DisplayOptions.ortho decides which camera is live). */
  mode: 'ortho' | 'perspective';
  pos: Vec3;
  target: Vec3;
  zoom: number;
  /** Explicit flag: set by align, cleared by orbit start, wheel, pan and fly keys. Never inferred from matrices. */
  aligned: boolean;
  /** The custom view to return to from the aligned view. */
  prevCustom: CameraPose | null;
}

/** Global toolbar toggles (persisted in the workspace; cocoEdit is never restored). */
export interface DisplayOptions {
  showFloor: boolean;
  /** Frame (or reference) image on the projection plane (same name as settings.editor.showFrameImage). */
  showFrameImage: boolean;
  showCoco: boolean;
  /** Our rig skeleton (bones, joints, anchor). Hidden: no rig picking and no gizmo. */
  showSkeleton: boolean;
  /** Onion skin: our rig at GhostView's GHOST_OPACITY for the `ghostCount` track frames before the shown one (independent of showSkeleton; never picked). */
  showGhosts: boolean;
  /** Ghost frames shown while showGhosts is on: an integer in 0..GHOST_COUNT_MAX. */
  ghostCount: number;
  /** Ghost tint, '#rrggbb' (bones; joints a little lighter, end sites a little darker). */
  ghostColor: string;
  /** COCO edit mode: REF only; picking switches to COCO points (NECK excluded). */
  cocoEdit: boolean;
  /** 'translate' only applies to Hips; other bones are rotate-only. */
  gizmoMode: 'rotate' | 'translate';
  gizmoSpace: 'local' | 'world';
  /** Orthographic (default; aligned view matches PixelLab exactly) vs perspective. */
  ortho: boolean;
}

/** Default ghost tint (a muted red, distinct from the blue-grey active skeleton). */
export const DEFAULT_GHOST_COLOR = '#874040';

export const DEFAULT_DISPLAY: Readonly<DisplayOptions> = {
  showFloor: true, showFrameImage: true, showCoco: true, showSkeleton: true, showGhosts: false, ghostCount: 1,
  ghostColor: DEFAULT_GHOST_COLOR, cocoEdit: false, gizmoMode: 'rotate', gizmoSpace: 'local', ortho: true
};

/** Most ghost frames the onion skin shows. */
export const GHOST_COUNT_MAX = 15;

/** A valid DisplayOptions.ghostCount: rounded and clamped to 0..GHOST_COUNT_MAX; a non-number or NaN → `fallback`. */
export const sanitizeGhostCount = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), 0, GHOST_COUNT_MAX) : fallback;

/** A valid DisplayOptions.ghostColor: '#rrggbb' lower-cased; anything else → `fallback`. */
export const sanitizeGhostColor = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback;

export interface EditorEvents {
  /** Bone selection changed (clicking a joint selects the bone whose head it is). */
  select: (bone: BoneName | null) => void;
  /** Scratch pose during a drag, rAF-throttled (drives the active thumbnail only). */
  livePose: (target: FrameTarget, pose: Pose) => void;
  /** COCO edit drag (REF only): a copy of the 18 dragged points, rAF-throttled, before the doc recalibrates (REF thumbnail). */
  liveCoco: (coco: Vec3[]) => void;
  alignedChange: (aligned: boolean) => void;
  /** A gizmo / COCO drag started (true) or ended or was cancelled (false). */
  interaction: (active: boolean) => void;
  /** The viewport changed display options itself (Hips click toggles gizmoMode; leaving REF ends cocoEdit). */
  displayChange: (display: DisplayOptions) => void;
}

export type EditorEventName = keyof EditorEvents;

export interface IEditorViewport {
  /** Create the renderer inside `container` (focusable; handles WASD / Space / C itself). Call once. */
  mount(container: HTMLElement): void;
  /** Release GPU resources, listeners and texture caches. */
  dispose(): void;
  /** Swap documents (cancels any interaction first). `view` restores a saved camera; omitted → aligned. Returns the outgoing doc's ViewState (null if none). */
  setDocument(src: DocSource | null, view?: ViewState | null): ViewState | null;
  /** The doc closed: dispose its texture cache (and forget it if it is the current one). */
  forgetDocument(docId: string): void;
  /** Re-read the current DocSource after its version changed (undo, redo, job result, panel edit). */
  refresh(): void;
  /** Show and edit the REF slot or a track frame. */
  setTarget(target: FrameTarget): void;
  setDisplay(opts: Partial<DisplayOptions>): void;
  getDisplay(): DisplayOptions;
  /** WASD fly speed in world units per second (settings.editor.flySpeed; Shift multiplies it). */
  setFlySpeed(unitsPerSec: number): void;
  /** Not aligned → align to the projection plane; aligned → return to the previous custom view (if any). */
  toggleAlign(): void;
  isAligned(): boolean;
  /** A previous custom view exists (the align button then reads "Return to previous view"). */
  hasPreviousView(): boolean;
  /** Abort a drag (TransformControls reset, scratch pose discarded). Call before a swap, undo, redo or job apply. */
  cancelInteraction(): void;
  isInteracting(): boolean;
  getViewState(): ViewState | null;
  /** Subscribe; returns the unsubscribe function. */
  on<K extends EditorEventName>(event: K, cb: EditorEvents[K]): () => void;
}
