// TransformControls on a proxy object. The proxy sits at the selected bone's head with qW(bone)
// (rotate) or at the Hips position (translate). Each objectChange writes qL = qW(parent)⁻¹·proxy.q (or the root
// position) into a scratch pose the gizmo owns; the proxy is never re-synced from FK while dragging.
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { Pose, Quat } from '../core/model';
import type { FkResult } from '../core/rig/fk';
import { clonePose } from '../core/rig/poses';
import { BONES, PARENT_INDEX } from '../core/rig/rigDef';

export type GizmoMode = 'rotate' | 'translate';

/** TransformControls size: a little under its default (1) so the rings do not dwarf small sprites. */
export const GIZMO_SIZE = 0.75;
export type GizmoAxis = TransformControls['axis'];

export interface GizmoEvents {
  /** TransformControls grabbed an axis (mouseDown). */
  dragStart: () => void;
  /** The scratch pose changed (objectChange). */
  dragChange: () => void;
  /** The pointer was released after a drag (mouseUp); the scratch pose is still available. */
  dragEnd: () => void;
  /** TransformControls dragging flag changed (orbit must be off while it is on). */
  draggingChanged: (on: boolean) => void;
  /** Hover highlight or helper moved: render. */
  change: () => void;
}

export class GizmoController {
  readonly tc: TransformControls;
  readonly proxy = new THREE.Object3D();
  private bone = -1;
  private mode: GizmoMode = 'rotate';
  private scratch: Pose | null = null;
  private parentQW = new THREE.Quaternion();
  private q = new THREE.Quaternion();
  private suppress = false;
  private changed = false;

  /** `proxyParent` is any scene object (TransformControls requires the proxy to be in a scene graph). */
  constructor(camera: THREE.Camera, dom: HTMLElement, proxyParent: THREE.Object3D, helperParent: THREE.Object3D, private events: GizmoEvents) {
    this.tc = new TransformControls(camera, dom);
    this.tc.size = GIZMO_SIZE;
    this.tc.setSpace('local');
    proxyParent.add(this.proxy);
    helperParent.add(this.tc.getHelper()); // r186: TransformControls is not an Object3D; its helper is
    this.tc.addEventListener('mouseDown', () => events.dragStart());
    this.tc.addEventListener('mouseUp', () => events.dragEnd());
    this.tc.addEventListener('objectChange', () => this.onObjectChange());
    this.tc.addEventListener('dragging-changed', (e) => events.draggingChanged(e.value as boolean));
    this.tc.addEventListener('change', () => events.change());
  }

  dispose(): void {
    this.tc.detach();
    this.tc.getHelper().removeFromParent();
    this.tc.dispose();
    this.proxy.removeFromParent();
  }

  get dragging(): boolean {
    return this.tc.dragging;
  }

  get attachedBone(): number {
    return this.bone;
  }

  get effectiveMode(): GizmoMode {
    return this.mode;
  }

  /** The scratch pose of the running drag (null when idle). */
  get pose(): Pose | null {
    return this.scratch;
  }

  /** objectChange fired since the drag started. */
  get hasChanged(): boolean {
    return this.changed;
  }

  setCamera(camera: THREE.Camera): void {
    this.tc.camera = camera;
  }

  setEnabled(on: boolean): void {
    this.tc.enabled = on;
  }

  get enabled(): boolean {
    return this.tc.enabled;
  }

  setSpace(space: 'local' | 'world'): void {
    this.tc.setSpace(space);
  }

  /** Attach to a bone (-1 detaches). `mode` is honoured for Hips only; every other bone rotates. */
  attach(bone: number, mode: GizmoMode, fkr: FkResult | null): void {
    this.bone = fkr ? bone : -1;
    this.mode = bone === 0 ? mode : 'rotate';
    if (this.bone < 0) {
      this.tc.detach();
      return;
    }
    this.tc.setMode(this.mode);
    this.sync(fkr!);
    if (this.tc.object !== this.proxy)
      this.tc.attach(this.proxy);
  }

  get attached(): boolean {
    return this.tc.object !== undefined;
  }

  /** Place the proxy from FK (ignored while dragging). */
  sync(fkr: FkResult): void {
    if (this.bone < 0 || this.tc.dragging)
      return;
    const p = fkr.pos[this.bone];
    const r = fkr.rotW[this.bone];
    this.proxy.position.set(p[0], p[1], p[2]);
    this.proxy.quaternion.set(r[0], r[1], r[2], r[3]);
    this.proxy.updateMatrixWorld();
  }

  /** The axis under the pointer (NDC), as TransformControls would pick it on pointerdown. */
  axisAt(ndcX: number, ndcY: number): GizmoAxis {
    if (!this.attached || !this.tc.enabled || this.tc.dragging)
      return null;
    // pointerHover takes TransformControls' internal {x, y, button} pointer, typed as PointerEvent
    this.tc.pointerHover({ x: ndcX, y: ndcY, button: -1 } as unknown as PointerEvent);
    return this.tc.axis;
  }

  /** The axis TransformControls currently highlights (updated by its own pointermove hover). */
  get hoveredAxis(): GizmoAxis {
    return this.attached && this.tc.enabled ? this.tc.axis : null;
  }

  /** Drop the hover highlight (the arbiter gave the gesture to someone else). */
  clearAxis(): void {
    if (!this.tc.dragging)
      this.tc.axis = null;
  }

  /** Drag started: copy the displayed pose into the scratch pose and remember the parent's world rotation. */
  begin(pose: Readonly<Pose>, fkr: FkResult): void {
    this.scratch = clonePose(pose);
    this.changed = false;
    const p = PARENT_INDEX[this.bone];
    if (p >= 0) {
      const r = fkr.rotW[p];
      this.parentQW.set(r[0], r[1], r[2], r[3]);
    } else
      this.parentQW.identity();
  }

  private onObjectChange(): void {
    if (this.suppress || !this.scratch || this.bone < 0)
      return;
    if (this.mode === 'translate')
      this.scratch.root = [this.proxy.position.x, this.proxy.position.y, this.proxy.position.z];
    else {
      this.q.copy(this.parentQW).invert().multiply(this.proxy.quaternion).normalize();
      this.scratch.rot[BONES[this.bone].name] = [this.q.x, this.q.y, this.q.z, this.q.w] as Quat;
    }
    this.changed = true;
    this.events.dragChange();
  }

  /** Hand the finished scratch pose over (and forget it). */
  take(): Pose | null {
    const p = this.scratch;
    this.scratch = null;
    return p;
  }

  /**
   * Finish a drag whose pointerup TransformControls ignored: it only accepts button 0, but with chorded buttons the
   * single pointerup reports the button released last. Emits mouseUp (dragEnd) like a normal release.
   */
  release(): void {
    if (this.tc.dragging)
      this.tc.pointerUp(null);
  }

  /** Abort a running drag: restore the proxy (TransformControls.reset), stop dragging and drop the scratch pose. */
  cancel(): void {
    if (this.tc.dragging) {
      this.suppress = true;
      this.tc.reset();
      this.tc.dragging = false; // further pointer moves are ignored; the pending pointerup emits no mouseUp
      this.suppress = false;
    }
    this.scratch = null;
    this.changed = false;
  }
}
