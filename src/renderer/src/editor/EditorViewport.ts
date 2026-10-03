// The 3D pose editor (docs/skelanim/skelanim.md "UI"). Framework-free and store-free: EditorPane and the testbed drive
// this same class through IEditorViewport + DocSource.
//
// Rendering is on demand: invalidate() schedules one rAF (drags call it on every change), and frames keep coming while
// the camera damps or fly keys are held. Draw order: floor + image plane, renderer.clearDepth(), then the foreground
// scene (one shared RigLights; the onion-skin ghosts, each ending in a depth reset; the skeleton), the COCO overlay and
// the gizmo helper, so the skeleton is always on top of the image and of the ghosts.
//
// Pointer gestures are decided by a capture-phase pointerdown arbiter that runs before TransformControls and OrbitControls:
// gizmo axis under the pointer → gizmo drag; a joint / bone (or COCO handle) → select (orbit off until pointerup);
// otherwise orbit, where a click (< 4 px of travel) on empty space deselects and leaves the camera untouched.
import * as THREE from 'three';
import { SKELETON_LABELS } from '@shared/pixellab';
import type { BoneName, FrameTarget, Pose, UndoableState, Vec3 } from '../core/model';
import { ghostPoses, referencedImages, sameTarget, targetPose } from '../core/docState';
import { COCO, humanLabel } from '../core/rig/coco';
import { cocoFromFk, createFkResult, fk } from '../core/rig/fk';
import { clonePose } from '../core/rig/poses';
import { alignedView, cameraBasis } from '../core/rig/projection';
import { BONE_INDEX, BONES, HUMAN_NAMES } from '../core/rig/rigDef';
import { CameraRig, CLICK_SLOP, type FlyKey } from './CameraRig';
import { CocoView } from './CocoView';
import { GhostView } from './GhostView';
import { GizmoController, type GizmoAxis } from './GizmoController';
import { Picker, type RigHit } from './Picker';
import { ProjectionPlane } from './ProjectionPlane';
import { RigLights, createRigGeometries, disposeRigGeometries, type RigGeometries } from './RigMeshes';
import { SkeletonView } from './SkeletonView';
import { DocTextureCache, createAnchorTexture, createDiscTexture, createRingTexture } from './textures';
import {
  DEFAULT_DISPLAY, sanitizeGhostColor, sanitizeGhostCount, type DisplayOptions, type DocSource, type EditorEventName, type EditorEvents, type IEditorViewport,
  type ViewState
} from './types';

const CLEAR_COLOR = 0x0a0c10;
/** A track frame without its own image shows the reference image faded. */
const STAND_IN_OPACITY = 0.35;

const FLY_CODES: Readonly<Record<string, FlyKey>> = {
  KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', Space: 'up', KeyC: 'down'
};

const REF: FrameTarget = { kind: 'ref' };

type GestureKind = 'orbit' | 'select' | 'gizmo' | 'coco';

/** One pointer gesture, from the arbiter's pointerdown to pointerup. */
interface Gesture {
  kind: GestureKind;
  button: number;
  pointerId: number;
  x0: number;
  y0: number;
  /** Max distance from the start, CSS px. */
  travel: number;
  /** 'select': bone picked, and whether it was already selected. */
  bone: number;
  wasSelected: boolean;
  /** Escape / cancelInteraction() ended it early: pointerup does nothing. */
  cancelled: boolean;
}

/** COCO edit drag: screen-parallel plane through the point; Alt moves it in depth instead. */
interface CocoDrag {
  index: number;
  pts: Vec3[];
  base: THREE.Vector3;
  offset: THREE.Vector3;
  x0: number;
  y0: number;
  alt: boolean;
  moved: boolean;
}

/** Live viewports, disposed when this module is hot-replaced in dev. */
const live = new Set<EditorViewport>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const v of [...live])
      v.dispose();
  });
}

const isFormTarget = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName));

export class EditorViewport implements IEditorViewport {
  private container: HTMLElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private rig!: CameraRig;
  private gizmo!: GizmoController;
  private plane!: ProjectionPlane;
  private skeleton!: SkeletonView;
  private ghosts!: GhostView;
  private lights!: RigLights;
  private rigGeo: RigGeometries | null = null;
  private coco!: CocoView;
  private picker = new Picker();
  private bgScene = new THREE.Scene();
  private fgScene = new THREE.Scene();
  private cocoScene = new THREE.Scene();
  private helperScene = new THREE.Scene();
  private anchorTex: THREE.Texture | null = null;
  private discTex: THREE.Texture | null = null;
  private ringTex: THREE.Texture | null = null;
  private caches = new Map<string, DocTextureCache>();
  private timer = new THREE.Timer();
  private resizeObserver: ResizeObserver | null = null;
  private cleanups: (() => void)[] = [];

  private src: DocSource | null = null;
  private version = -1;
  private state: UndoableState | null = null;
  private target: FrameTarget = REF;
  private display: DisplayOptions = { ...DEFAULT_DISPLAY };
  private flySpeed = 1.5;
  private pendingView: ViewState | null = null;

  private fkr = createFkResult();
  private hasPose = false;
  /** Inputs of the shown ghosts (states are immutable, so identity means unchanged content). */
  private ghostKey: { state: UndoableState | null; target: FrameTarget; count: number } = { state: null, target: REF, count: 0 };
  private selected = -1;
  private hover = -1;
  private cocoHover = -1;
  private gesture: Gesture | null = null;
  private drag: 'gizmo' | 'coco' | null = null;
  private cocoDrag: CocoDrag | null = null;
  private poseDirty = false;
  private livePending = false;
  private liveCocoPending = false;

  private raf = 0;
  private chained = false;
  private inFrame = false;
  private frames = 0;
  private contextLost = false;
  private disposed = false;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tmpPlane = new THREE.Plane();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private handlers: { [K in EditorEventName]: Set<EditorEvents[K]> } = {
    select: new Set(), livePose: new Set(), liveCoco: new Set(), alignedChange: new Set(), interaction: new Set(), displayChange: new Set()
  };

  // ---------- lifecycle ----------

  mount(container: HTMLElement): void {
    if (this.renderer || this.disposed)
      throw new Error('EditorViewport.mount() may be called once');
    this.container = container;
    if (!container.hasAttribute('tabindex'))
      container.tabIndex = 0;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.autoClear = false;
    renderer.setClearColor(CLEAR_COLOR, 1);
    this.renderer = renderer;
    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    this.canvas = canvas;
    container.appendChild(canvas);

    this.anchorTex = createAnchorTexture();
    this.discTex = createDiscTexture();
    this.ringTex = createRingTexture();
    this.plane = new ProjectionPlane();
    this.rigGeo = createRigGeometries();
    this.lights = new RigLights();
    this.ghosts = new GhostView(this.rigGeo);
    this.skeleton = new SkeletonView(this.anchorTex, this.rigGeo);
    this.coco = new CocoView(this.discTex, this.ringTex);
    this.bgScene.add(this.plane.group);
    this.fgScene.add(this.lights.group, this.ghosts.group, this.skeleton.group);
    this.cocoScene.add(this.coco.group);

    this.rig = new CameraRig({
      alignedChange: (a) => this.emit('alignedChange', a),
      cameraChange: (cam) => this.gizmo?.setCamera(cam),
      change: () => this.invalidate()
    });
    // TransformControls first: its pointerdown listener must run before OrbitControls'
    this.gizmo = new GizmoController(this.rig.camera, canvas, this.fgScene, this.helperScene, {
      dragStart: () => this.onGizmoDragStart(),
      dragChange: () => {
        this.poseDirty = true;
        this.livePending = true;
        this.invalidate();
      },
      dragEnd: () => this.onGizmoDragEnd(),
      draggingChanged: (on) => this.onGizmoDraggingChanged(on),
      change: () => this.invalidate()
    });
    this.rig.connect(canvas);
    this.rig.setFlySpeed(this.flySpeed);
    this.applyDisplay();

    this.listen(container, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent), true);
    this.listen(canvas, 'pointermove', (e) => this.onHoverMove(e as PointerEvent));
    this.listen(canvas, 'pointerleave', () => this.setHover(-1, -1));
    this.listen(window, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(window, 'pointerup', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(window, 'pointercancel', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(container, 'wheel', () => this.onWheel(), true);
    this.listen(container, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(container, 'keyup', (e) => this.onKeyUp(e as KeyboardEvent));
    this.listen(container, 'focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget;
      if (!(next instanceof Node && container.contains(next)))
        this.clearKeys();
    });
    this.listen(window, 'blur', () => this.clearKeys());
    this.listen(document, 'visibilitychange', () => this.clearKeys());
    this.listen(canvas, 'webglcontextlost', (e) => {
      e.preventDefault(); // allows the context to be restored
      this.contextLost = true;
    });
    this.listen(canvas, 'webglcontextrestored', () => {
      // three re-initialises its GL state first (its listener was added earlier); re-apply ours and re-upload textures
      this.contextLost = false;
      renderer.setClearColor(CLEAR_COLOR, 1);
      for (const c of this.caches.values())
        c.markAllDirty();
      for (const t of [this.anchorTex, this.discTex, this.ringTex]) {
        if (t)
          t.needsUpdate = true;
      }
      this.invalidate();
    });

    this.timer.connect(document);
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
    this.watchPixelRatio();
    this.onResize();
    if (this.src) {
      // setDocument() ran before mount()
      this.rebuild();
      this.rig.applyViewState(this.pendingView);
      this.pendingView = null;
    }
    live.add(this);
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed)
      return;
    this.disposed = true;
    live.delete(this);
    if (this.raf)
      cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const off of this.cleanups)
      off();
    this.cleanups = [];
    this.resizeObserver?.disconnect();
    this.timer.dispose();
    for (const c of this.caches.values())
      c.dispose();
    this.caches.clear();
    if (this.renderer) {
      this.gizmo.dispose();
      this.rig.dispose();
      this.plane.dispose();
      this.skeleton.dispose();
      this.ghosts.dispose();
      this.lights.dispose();
      if (this.rigGeo)
        disposeRigGeometries(this.rigGeo);
      this.rigGeo = null;
      this.coco.dispose();
      this.anchorTex?.dispose();
      this.discTex?.dispose();
      this.ringTex?.dispose();
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.canvas?.remove();
    }
    this.renderer = null;
    this.src = null;
    this.state = null;
    this.ghostKey = { state: null, target: REF, count: 0 };
    for (const set of Object.values(this.handlers))
      set.clear();
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, capture = false): void {
    target.addEventListener(type, fn, capture);
    this.cleanups.push(() => target.removeEventListener(type, fn, capture));
  }

  // ---------- events ----------

  on<K extends EditorEventName>(event: K, cb: EditorEvents[K]): () => void {
    const set = this.handlers[event] as Set<EditorEvents[K]>;
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  private emit<K extends EditorEventName>(event: K, ...args: Parameters<EditorEvents[K]>): void {
    for (const cb of this.handlers[event] as Set<(...a: Parameters<EditorEvents[K]>) => void>)
      cb(...args);
  }

  // ---------- documents ----------

  setDocument(src: DocSource | null, view?: ViewState | null): ViewState | null {
    this.cancelInteraction();
    const outgoing = this.getViewState();
    if (this.src && this.src.id !== src?.id)
      this.caches.get(this.src.id)?.releaseGpu(); // background docs keep their bitmaps, not their GPU copies
    this.src = src;
    this.version = -1;
    this.state = null;
    this.target = REF;
    this.setHover(-1, -1);
    this.select(-1);
    if (!src) {
      this.hasPose = false;
      this.skeleton?.setPose(null, null);
      this.updateGhosts();
      this.coco?.update(null);
      this.plane?.setCanvas(null);
      this.plane?.setTexture(null);
      this.gizmo?.attach(-1, 'rotate', null);
      this.rig?.setAlignSpec(null);
      this.invalidate();
      return outgoing;
    }
    if (!this.caches.has(src.id)) {
      const id = src.id;
      this.caches.set(id, new DocTextureCache((uid) => src.imageUrl(uid), () => this.onTextureLoaded(id)));
    }
    this.readState();
    this.rebuild();
    if (this.rig)
      this.rig.applyViewState(view ?? null);
    else
      this.pendingView = view ?? null; // applied by mount()
    this.invalidate();
    return outgoing;
  }

  forgetDocument(docId: string): void {
    if (this.src?.id === docId)
      this.setDocument(null);
    this.caches.get(docId)?.dispose();
    this.caches.delete(docId);
  }

  refresh(): void {
    if (!this.src || this.src.getVersion() === this.version)
      return;
    if (this.isInteracting())
      this.cancelInteraction(); // the content changed under a drag
    this.readState();
    this.rebuild();
  }

  setTarget(target: FrameTarget): void {
    if (sameTarget(target, this.target))
      return;
    if (this.isInteracting())
      this.cancelInteraction();
    this.target = target.kind === 'ref' ? REF : { kind: 'frame', uid: target.uid };
    if (this.display.cocoEdit && target.kind !== 'ref') {
      this.display = { ...this.display, cocoEdit: false };
      this.applyDisplay();
      this.emit('displayChange', this.getDisplay());
    }
    this.rebuild();
  }

  private readState(): void {
    if (!this.src)
      return;
    this.state = this.src.getState();
    this.version = this.src.getVersion();
  }

  /** The target, falling back to REF when its frame no longer exists. */
  private effectiveTarget(): FrameTarget {
    const s = this.state;
    if (this.target.kind === 'frame' && s && !s.frames.some((f) => f.uid === (this.target as { uid: string }).uid))
      return REF;
    return this.target;
  }

  private isRefTarget(): boolean {
    return this.effectiveTarget().kind === 'ref';
  }

  /** The pose on screen: the drag's scratch pose, else the target's stored pose. */
  private displayPose(): Readonly<Pose> | null {
    const scratch = this.gizmo?.pose;
    if (scratch)
      return scratch;
    return this.state ? targetPose(this.state, this.effectiveTarget()) : null;
  }

  private cocoEditActive(): boolean {
    return this.display.cocoEdit && this.isRefTarget();
  }

  /** COCO points on screen: edit mode shows reference.coco (the editable points); otherwise FK of the pose. */
  private displayCoco(): Vec3[] | null {
    if (this.cocoEditActive()) {
      if (this.cocoDrag)
        return this.cocoDrag.pts;
      const c = this.state?.reference.coco;
      if (c)
        return c.map((p): Vec3 => [p[0], p[1], p[2]]);
    }
    return this.hasPose && this.state ? cocoFromFk(this.fkr, this.state.rig) : null;
  }

  /** Re-derive everything shown from state + target (cheap: one FK pass, no allocation of meshes). */
  private rebuild(): void {
    const s = this.state;
    if (!this.renderer || !s) {
      this.invalidate();
      return;
    }
    const canvas = { width: s.reference.width, height: s.reference.height };
    const view = alignedView(canvas, s.projection, cameraBasis(s.direction, s.pitchDeg));
    this.rig.setAlignSpec({ view, canvas });
    this.plane.setCanvas(view);
    const cache = this.src ? this.caches.get(this.src.id) : undefined;
    if (cache) {
      const uids = referencedImages(s);
      cache.retain(uids); // before updateImage() re-assigns the plane map
      cache.preload(uids);
    }
    this.updateImage();
    this.updatePose();
    this.invalidate();
  }

  private updatePose(): void {
    const s = this.state;
    const pose = this.displayPose();
    this.hasPose = !!(pose && s);
    if (pose && s)
      fk(pose, s.rig, this.fkr);
    this.skeleton.setPose(this.hasPose ? this.fkr : null, s?.rig ?? null);
    this.updateGhosts();
    this.coco.update(this.displayCoco());
    this.coco.setEditMode(this.cocoEditActive());
    this.updateStyle();
    if (!this.drag)
      this.attachGizmo();
  }

  /** Onion skin: FK for the ghosts only when the state, the shown frame or the ghost count changed (never during a drag). */
  private updateGhosts(): void {
    if (!this.renderer)
      return;
    const s = this.state;
    const t = this.effectiveTarget();
    const count = s && this.display.showGhosts ? this.display.ghostCount : 0;
    const k = this.ghostKey;
    if (k.state === s && k.count === count && sameTarget(k.target, t))
      return;
    this.ghostKey = { state: s, target: t, count };
    this.ghosts.setPoses(s && count > 0 ? ghostPoses(s, t, count) : [], s?.rig ?? null);
  }

  private updateImage(): void {
    const s = this.state;
    if (!s || !this.src) {
      this.plane.setTexture(null);
      return;
    }
    const t = this.effectiveTarget();
    let uid = s.reference.image;
    let opacity = 1;
    if (t.kind === 'frame') {
      const f = s.frames.find((fr) => fr.uid === t.uid);
      if (f?.image)
        uid = f.image;
      else
        opacity = STAND_IN_OPACITY;
    }
    const tex = uid ? this.caches.get(this.src.id)?.get(uid) ?? null : null;
    this.plane.setTexture(tex, opacity);
  }

  private onTextureLoaded(docId: string): void {
    if (this.src?.id !== docId || !this.renderer)
      return;
    this.updateImage();
    this.invalidate();
  }

  // ---------- display ----------

  setDisplay(opts: Partial<DisplayOptions>): void {
    const prev = this.display;
    const next: DisplayOptions = { ...prev, ...opts };
    next.ghostCount = sanitizeGhostCount(next.ghostCount, prev.ghostCount);
    next.ghostColor = sanitizeGhostColor(next.ghostColor, prev.ghostColor);
    let forced = false;
    if (next.cocoEdit && !this.isRefTarget()) {
      next.cocoEdit = false; // REF only: the caller jumps to REF first
      forced = true;
    }
    const dragSensitive = prev.gizmoMode !== next.gizmoMode || prev.gizmoSpace !== next.gizmoSpace || prev.ortho !== next.ortho;
    const hidingSkeleton = prev.showSkeleton && !next.showSkeleton;
    if (prev.cocoEdit !== next.cocoEdit || ((dragSensitive || hidingSkeleton) && this.drag !== null))
      this.cancelInteraction();
    this.display = next;
    if ((next.cocoEdit && !prev.cocoEdit) || hidingSkeleton)
      this.select(-1);
    this.applyDisplay();
    if (this.state)
      this.updatePose();
    this.invalidate();
    if (forced)
      this.emit('displayChange', this.getDisplay());
  }

  getDisplay(): DisplayOptions {
    return { ...this.display };
  }

  private applyDisplay(): void {
    if (!this.renderer)
      return;
    const d = this.display;
    this.plane.setShowFloor(d.showFloor);
    this.plane.setShowImage(d.showFrameImage);
    this.coco.setVisible(d.showCoco || this.cocoEditActive());
    this.skeleton.setShown(d.showSkeleton);
    this.ghosts.setColor(d.ghostColor);
    this.gizmo.setSpace(d.gizmoSpace);
    this.rig.setOrtho(d.ortho);
    this.updateImage();
  }

  setFlySpeed(unitsPerSec: number): void {
    this.flySpeed = unitsPerSec;
    this.rig?.setFlySpeed(unitsPerSec);
  }

  // ---------- camera ----------

  toggleAlign(): void {
    this.rig?.toggleAlign();
  }

  isAligned(): boolean {
    return this.rig?.isAligned() ?? false;
  }

  hasPreviousView(): boolean {
    return this.rig?.hasPreviousView() ?? false;
  }

  getViewState(): ViewState | null {
    return this.src && this.rig ? this.rig.getViewState() : null;
  }

  // ---------- selection ----------

  private select(bone: number): void {
    if (bone === this.selected)
      return;
    this.selected = bone;
    // A fresh Hips selection (after another bone, a deselect or a doc switch) starts in rotate mode: Move is transient
    if (bone === 0 && this.display.gizmoMode !== 'rotate') {
      this.display = { ...this.display, gizmoMode: 'rotate' };
      this.emit('displayChange', this.getDisplay());
    }
    if (this.renderer) {
      this.attachGizmo();
      this.updateStyle();
    }
    this.emit('select', bone >= 0 ? BONES[bone].name : null);
    this.invalidate();
  }

  private toggleHipsMode(): void {
    this.display = { ...this.display, gizmoMode: this.display.gizmoMode === 'rotate' ? 'translate' : 'rotate' };
    this.attachGizmo();
    this.emit('displayChange', this.getDisplay());
    this.invalidate();
  }

  private attachGizmo(): void {
    const on = this.selected >= 0 && this.hasPose && this.display.showSkeleton && !this.cocoEditActive();
    this.gizmo.attach(on ? this.selected : -1, this.display.gizmoMode, on ? this.fkr : null);
  }

  private setHover(bone: number, cocoIndex: number): void {
    if (bone === this.hover && cocoIndex === this.cocoHover)
      return;
    this.hover = bone;
    this.cocoHover = cocoIndex;
    if (this.canvas)
      this.canvas.style.cursor = bone >= 0 || cocoIndex >= 0 ? 'pointer' : '';
    if (this.renderer) {
      this.updateStyle();
      this.invalidate();
    }
  }

  private updateStyle(): void {
    const edit = this.cocoEditActive();
    this.skeleton.setStyle(edit ? -1 : this.selected, edit ? -1 : this.hover, edit);
    this.coco.setHandles(edit ? this.cocoHover : -1, this.cocoDrag ? this.cocoDrag.index : -1);
  }

  // ---------- pointer arbiter ----------

  private local(e: { clientX: number; clientY: number }): { x: number; y: number; w: number; h: number } {
    const r = this.canvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  private pickRigAt(x: number, y: number, w: number, h: number): RigHit | null {
    if (!this.hasPose || !this.display.showSkeleton || this.cocoEditActive())
      return null;
    return this.picker.pickRig(this.fkr, this.rig.camera, { w, h }, x, y);
  }

  private pickCocoAt(x: number, y: number, w: number, h: number): number {
    const pts = this.cocoEditActive() ? this.displayCoco() : null;
    if (!pts)
      return -1;
    return this.picker.pickPoints(pts, (i) => i !== COCO.NECK, this.rig.camera, { w, h }, x, y);
  }

  private newGesture(kind: GestureKind, e: PointerEvent): Gesture {
    return { kind, button: e.button, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, travel: 0, bone: -1, wasSelected: false, cancelled: false };
  }

  private onPointerDown(e: PointerEvent): void {
    const container = this.container!;
    if (document.activeElement !== container && !(e.target instanceof Node && isFormTarget(e.target)))
      container.focus({ preventScroll: true });
    if (!this.src || e.target !== this.canvas || this.gesture || this.contextLost)
      return;
    if (e.button === 1) {
      this.gesture = this.newGesture('orbit', e); // MMB pan
      this.rig.beginGesture();
      return;
    }
    if (e.button !== 0)
      return;
    const { x, y, w, h } = this.local(e);
    const d = this.arbitrate(x, y, w, h, this.gizmo.axisAt((x / w) * 2 - 1, -(y / h) * 2 + 1));
    if (d.kind === 'gizmo') {
      const g = this.newGesture('gizmo', e);
      g.bone = d.index; // the joint under the press, if any (Hips click toggle)
      this.gesture = g;
      this.rig.setOrbitEnabled(false); // TransformControls' own pointerdown (next) starts the drag
      return;
    }
    if (d.kind === 'coco') {
      this.gesture = this.newGesture('coco', e);
      this.lockControls();
      this.startCocoDrag(d.index, x, y, w, h, e.altKey);
      return;
    }
    if (d.kind === 'select') {
      const g = this.newGesture('select', e);
      g.bone = d.index;
      g.wasSelected = d.index === this.selected;
      this.gesture = g;
      this.lockControls();
      this.select(d.index);
      return;
    }
    this.gesture = this.newGesture('orbit', e);
    this.rig.beginGesture();
  }

  /**
   * Who gets a LMB press at (x, y): a hovered gizmo axis wins, except that its invisible centre pickers (trackball /
   * free move) yield to a click on a different bone's joint; then a COCO handle (edit mode) or a rig joint / bone;
   * otherwise the camera. A visible ring over another bone's joint still takes the gesture, but `index` reports that
   * joint so a click without travel selects it (onGizmoDragEnd). Hover uses the same decision.
   */
  private arbitrate(x: number, y: number, w: number, h: number, axis: GizmoAxis): { kind: 'gizmo' | 'select' | 'coco' | 'orbit'; index: number } {
    if (this.cocoEditActive()) {
      const i = this.pickCocoAt(x, y, w, h);
      return i >= 0 ? { kind: 'coco', index: i } : { kind: 'orbit', index: -1 };
    }
    const hit = this.pickRigAt(x, y, w, h);
    const centre = axis === 'XYZE' || axis === 'XYZ';
    if (axis !== null && !(centre && hit && hit.kind !== 'segment' && hit.bone !== this.selected))
      return { kind: 'gizmo', index: hit && hit.kind !== 'segment' ? hit.bone : -1 };
    return hit ? { kind: 'select', index: hit.bone } : { kind: 'orbit', index: -1 };
  }

  /** Neither control may react to the rest of this gesture (selection click, COCO drag). */
  private lockControls(): void {
    this.rig.setOrbitEnabled(false);
    this.gizmo.clearAxis();
    this.gizmo.setEnabled(false);
  }

  private unlockControls(): void {
    this.gizmo.setEnabled(true);
    this.rig.setOrbitEnabled(!this.gizmo.dragging);
  }

  private onPointerMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId)
      return;
    g.travel = Math.max(g.travel, Math.hypot(e.clientX - g.x0, e.clientY - g.y0));
    if (g.cancelled)
      return;
    if (g.kind === 'orbit')
      this.rig.gestureTravel(g.travel);
    else if (g.kind === 'coco' && this.cocoDrag) {
      const { x, y, w, h } = this.local(e);
      this.moveCocoDrag(x, y, w, h, e.altKey);
    }
  }

  private onHoverMove(e: PointerEvent): void {
    if (this.gesture || e.buttons !== 0 || !this.hasPose)
      return;
    const { x, y, w, h } = this.local(e);
    // TransformControls' own hover listener ran first (registered earlier), so tc.axis is current
    const d = this.arbitrate(x, y, w, h, this.gizmo.hoveredAxis);
    // A joint under a gizmo ring is highlighted too: a click selects it, a drag uses the ring
    const bone = d.kind === 'select' || (d.kind === 'gizmo' && d.index !== this.selected) ? d.index : -1;
    this.setHover(bone, d.kind === 'coco' ? d.index : -1);
  }

  /**
   * A mouse sends one pointerup, when its last button is released, and `button` is that last one (chorded buttons):
   * any pointerup of the gesture's pointer ends it, whichever button started it.
   */
  private onPointerUp(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId)
      return;
    if (g.kind === 'gizmo')
      this.gizmo.release(); // only if TransformControls ignored a non-LMB release; onGizmoDragEnd reads this.gesture
    this.gesture = null;
    if (g.kind === 'orbit') {
      const click = this.rig.endGesture();
      if (click && g.button === 0 && !g.cancelled)
        this.select(-1); // click on empty space deselects
    } else if (g.kind === 'select') {
      if (!g.cancelled && g.travel < CLICK_SLOP && g.wasSelected && g.bone === 0)
        this.toggleHipsMode();
    } else if (g.kind === 'coco' && !g.cancelled)
      this.finishCocoDrag();
    this.unlockControls();
    this.invalidate();
  }

  private onWheel(): void {
    if (this.src && !this.isInteracting() && this.rig.orbit?.enabled)
      this.rig.breakAlign();
  }

  // ---------- gizmo drags ----------

  private onGizmoDragStart(): void {
    const pose = this.displayPose();
    if (!pose || this.gizmo.attachedBone < 0) {
      this.gizmo.cancel();
      return;
    }
    this.gizmo.begin(pose, this.fkr);
    this.drag = 'gizmo';
    this.emit('interaction', true);
  }

  private onGizmoDragEnd(): void {
    if (this.drag !== 'gizmo')
      return;
    const bone = this.gizmo.attachedBone;
    const mode = this.gizmo.effectiveMode;
    const g = this.gesture?.kind === 'gizmo' ? this.gesture : null;
    const travel = g ? g.travel : CLICK_SLOP;
    const changed = this.gizmo.hasChanged;
    // A different bone's joint under the press (a gizmo ring can cover it): a click selects it, a drag still rotates
    const other = g && g.bone >= 0 && g.bone !== bone ? g.bone : -1;
    if (travel < CLICK_SLOP && (bone === 0 || !changed || other >= 0)) {
      // A click, not a drag: nothing to commit. Clicking the selected Hips joint toggles rotate / translate.
      this.gizmo.cancel();
      this.endDrag();
      if (other >= 0)
        this.select(other);
      else if (bone === 0 && g?.bone === 0)
        this.toggleHipsMode();
      return;
    }
    const pose = this.gizmo.take();
    this.endDrag();
    if (pose && changed && travel > 0.5 && this.src) {
      const label = `${mode === 'translate' ? 'Move' : 'Rotate'} ${HUMAN_NAMES[BONES[bone].name]}`;
      this.src.commitPose(this.effectiveTarget(), pose, label);
      this.refresh();
    }
  }

  private onGizmoDraggingChanged(on: boolean): void {
    this.rig.setOrbitEnabled(!on && !(this.gesture && this.gesture.kind !== 'orbit'));
    if (!on && this.hasPose)
      this.gizmo.sync(this.fkr); // never re-synced while dragging; catch up now
    this.invalidate();
  }

  private endDrag(): void {
    const was = this.drag;
    this.drag = null;
    this.poseDirty = false;
    this.livePending = false;
    this.liveCocoPending = false;
    if (was) {
      this.emit('interaction', false);
      if (this.state)
        this.updatePose();
    }
  }

  cancelInteraction(): void {
    if (this.gesture)
      this.gesture.cancelled = true;
    if (this.drag === 'gizmo')
      this.gizmo.cancel();
    this.cocoDrag = null;
    this.endDrag();
    this.invalidate();
  }

  isInteracting(): boolean {
    return this.drag !== null;
  }

  // ---------- COCO edit drags ----------

  private setRay(x: number, y: number, w: number, h: number): void {
    this.ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
  }

  /** Screen-parallel plane through `base`; offset = grab point → handle centre. */
  private rebaseCocoDrag(d: CocoDrag, x: number, y: number, w: number, h: number, alt: boolean): void {
    const p = d.pts[d.index];
    d.base.set(p[0], p[1], p[2]);
    d.x0 = x;
    d.y0 = y;
    d.alt = alt;
    const dir = this.rig.camera.getWorldDirection(this.v1);
    this.tmpPlane.setFromNormalAndCoplanarPoint(dir, d.base);
    this.setRay(x, y, w, h);
    const hit = this.raycaster.ray.intersectPlane(this.tmpPlane, this.v2);
    d.offset.copy(d.base);
    if (hit)
      d.offset.sub(hit);
    else
      d.offset.set(0, 0, 0);
  }

  private startCocoDrag(index: number, x: number, y: number, w: number, h: number, alt: boolean): void {
    const pts = this.displayCoco();
    if (!pts)
      return;
    const d: CocoDrag = { index, pts: pts.map((p): Vec3 => [p[0], p[1], p[2]]), base: new THREE.Vector3(), offset: new THREE.Vector3(), x0: x, y0: y, alt, moved: false };
    this.rebaseCocoDrag(d, x, y, w, h, alt);
    this.cocoDrag = d;
    this.drag = 'coco';
    this.emit('interaction', true);
    this.updateStyle();
    this.invalidate();
  }

  private moveCocoDrag(x: number, y: number, w: number, h: number, alt: boolean): void {
    const d = this.cocoDrag!;
    if (alt !== d.alt)
      this.rebaseCocoDrag(d, x, y, w, h, alt);
    const dir = this.rig.camera.getWorldDirection(this.v1);
    const out = this.v2;
    if (alt) {
      // Depth: dragging up pushes the point away from the camera
      const wpp = this.rig.worldPerPixel(d.base);
      out.copy(d.base).addScaledVector(dir, (d.y0 - y) * wpp);
    } else {
      this.tmpPlane.setFromNormalAndCoplanarPoint(dir, d.base);
      this.setRay(x, y, w, h);
      if (!this.raycaster.ray.intersectPlane(this.tmpPlane, out))
        return;
      out.add(d.offset);
    }
    d.pts[d.index] = [out.x, out.y, out.z];
    const ls = d.pts[COCO.L_SHOULDER];
    const rs = d.pts[COCO.R_SHOULDER];
    d.pts[COCO.NECK] = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2, (ls[2] + rs[2]) / 2]; // derived
    d.moved = true;
    this.liveCocoPending = true;
    this.coco.update(d.pts);
    this.invalidate();
  }

  private finishCocoDrag(): void {
    const d = this.cocoDrag;
    this.cocoDrag = null;
    this.endDrag();
    if (d && d.moved && this.src) {
      this.src.commitCoco(d.pts, `Move ${humanLabel(SKELETON_LABELS[d.index])}`);
      this.refresh();
    }
    this.updateStyle();
  }

  // ---------- keys ----------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Alt' && this.drag === 'coco') {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isFormTarget(e.target))
      return;
    if (e.key === 'Escape') {
      if (this.isInteracting()) {
        this.cancelInteraction();
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    this.rig?.setShift(e.shiftKey);
    const key = FLY_CODES[e.code];
    if (!key || !this.src)
      return;
    e.preventDefault();
    if (!e.repeat) {
      this.rig.setKey(key, true);
      this.invalidate();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.rig?.setShift(e.shiftKey);
    const key = FLY_CODES[e.code];
    if (!key)
      return;
    e.preventDefault();
    this.rig.setKey(key, false);
  }

  private clearKeys(): void {
    this.rig?.clearKeys();
  }

  // ---------- rendering ----------

  /** Schedule one frame (no-op when one is already pending). */
  invalidate(): void {
    if (this.raf || this.disposed || !this.renderer)
      return;
    if (!this.chained && !this.inFrame)
      this.timer.reset(); // restarting after idle: no giant first delta
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.raf = 0;
    if (this.disposed || !this.renderer || this.contextLost) {
      this.chained = false;
      return;
    }
    this.inFrame = true;
    this.timer.update();
    const dt = Math.min(Math.max(this.timer.getDelta(), 0), 0.1);
    const moving = this.rig.update(dt);
    if (this.poseDirty && this.state) {
      const pose = this.gizmo.pose;
      if (pose) {
        fk(pose, this.state.rig, this.fkr);
        this.coco.update(this.displayCoco());
      }
      this.poseDirty = false;
    }
    if (this.livePending) {
      this.livePending = false;
      const pose = this.gizmo.pose;
      if (pose) {
        const t = this.effectiveTarget();
        const copy = clonePose(pose);
        this.emit('livePose', t, copy);
        this.src?.onLivePose?.(t, copy);
      }
    }
    if (this.liveCocoPending) {
      this.liveCocoPending = false;
      const d = this.cocoDrag;
      if (d)
        this.emit('liveCoco', d.pts.map((p): Vec3 => [p[0], p[1], p[2]]));
    }
    this.renderNow();
    this.inFrame = false;
    // Keep frames coming while the camera damps or fly keys are held. Drags invalidate on each change, so a drag held
    // still renders nothing (an invalidate() during this frame already queued the next one: raf was reset above).
    this.chained = moving || this.rig.keysHeld;
    if (this.chained && !this.raf)
      this.raf = requestAnimationFrame(this.frame);
  };

  private renderNow(): void {
    const r = this.renderer;
    if (!r || this.contextLost)
      return;
    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    const target = this.rig.orbit?.target ?? this.v1.set(0, 0.5, 0);
    this.lights.update(cam, target);
    this.ghosts.layout(this.rig);
    this.skeleton.layout(cam, this.rig);
    r.clear();
    r.render(this.bgScene, cam);
    r.clearDepth();
    r.render(this.fgScene, cam);
    r.render(this.cocoScene, cam);
    r.render(this.helperScene, cam);
    this.frames++;
  }

  /**
   * A devicePixelRatio change (window moved to a monitor with other scaling, OS zoom) can leave the CSS size unchanged,
   * so the ResizeObserver stays silent: re-size the drawing buffer (and re-snap the aligned view) on it too.
   */
  private watchPixelRatio(): void {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = (): void => {
      mq.removeEventListener('change', onChange);
      if (this.disposed)
        return;
      this.onResize();
      this.watchPixelRatio();
    };
    mq.addEventListener('change', onChange);
    this.cleanups.push(() => mq.removeEventListener('change', onChange));
  }

  private onResize(): void {
    const c = this.container;
    const r = this.renderer;
    if (!c || !r)
      return;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (w < 1 || h < 1)
      return; // hidden (v-show): keep the last size
    r.setPixelRatio(window.devicePixelRatio || 1);
    r.setSize(w, h, false);
    const buf = r.getDrawingBufferSize(new THREE.Vector2());
    this.rig.resize(w, h, buf.x, buf.y);
    this.renderNow(); // synchronously, or the cleared buffer flashes
  }

  // ---------- diagnostics (testbed, integration checks) ----------

  /** Frames rendered so far. */
  get renderCount(): number {
    return this.frames;
  }

  get selectedBone(): BoneName | null {
    return this.selected >= 0 ? BONES[this.selected].name : null;
  }

  /** Effective gizmo mode of the current selection (Hips may translate; every other bone rotates). */
  get gizmoMode(): 'rotate' | 'translate' | null {
    return this.gizmo?.attached ? this.gizmo.effectiveMode : null;
  }

  /** CSS px (relative to the viewport) of a bone head, or null without a pose. */
  projectBone(bone: BoneName): [number, number] | null {
    if (!this.hasPose || !this.canvas)
      return null;
    const r = this.canvas.getBoundingClientRect();
    this.rig.camera.updateMatrixWorld();
    const s = this.picker.project(this.fkr.pos[BONE_INDEX[bone]], this.rig.camera, { w: r.width, h: r.height });
    return [s.x, s.y];
  }

  /** CSS px of a displayed COCO point (canonical index), or null. */
  projectCoco(index: number): [number, number] | null {
    const pts = this.displayCoco();
    if (!pts || !this.canvas)
      return null;
    const r = this.canvas.getBoundingClientRect();
    this.rig.camera.updateMatrixWorld();
    const s = this.picker.project(pts[index], this.rig.camera, { w: r.width, h: r.height });
    return [s.x, s.y];
  }

  /** What the arbiter would see at a viewport point (CSS px): the gizmo axis and the rig pick. */
  debugPickAt(x: number, y: number): { axis: GizmoAxis; bone: BoneName | null; coco: number } {
    const r = this.canvas!.getBoundingClientRect();
    const axis = this.gizmo.axisAt((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1);
    const hit = this.pickRigAt(x, y, r.width, r.height);
    return { axis, bone: hit ? BONES[hit.bone].name : null, coco: this.pickCocoAt(x, y, r.width, r.height) };
  }
}
