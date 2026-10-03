// Editor cameras (aligned view: docs/skelanim/rig.md "Projection"): orthographic by default with an aligned view that
// reproduces the PixelLab canvas exactly, a perspective alternative, OrbitControls (LMB orbit, MMB pan, wheel zoom),
// WASD / Space / C fly keys, the explicit `aligned` flag and the previous custom view. Programmatic moves never inherit
// leftover damping.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vec3 } from '../core/model';
import type { AlignedView } from '../core/rig/projection';
import type { CameraPose, ViewState } from './types';

/** Ortho visible half height at zoom 1, world units (the template character is 1 tall). */
const HALF_H0 = 1;
/** Ortho camera distance from its target (depth only matters for clipping). */
const ORTHO_DIST = 10;
const FOV = 35;
const TAN_HALF_FOV = Math.tan((FOV / 2) * THREE.MathUtils.DEG2RAD);
/** Aligned view: the canvas fills at most this fraction of the viewport. */
const FIT = 0.9;
const DAMPING = 0.14;
/** Pointer travel (CSS px) that turns a click into an orbit / pan gesture. */
export const CLICK_SLOP = 4;
const SHIFT_BOOST = 3;
/** Ortho W/S zoom rate per unit of fly speed (log space, per second). */
const ZOOM_RATE = 0.6;
/** Ortho strafe speed is scaled by visible height / this (so it feels the same at any zoom). */
const ORTHO_STRAFE_REF = 1.5;

export type FlyKey = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down';

/** What the aligned view needs from the doc: the aligned camera plus the canvas size in texels. */
export interface AlignSpec { view: AlignedView; canvas: { width: number; height: number } }

type AnyCamera = THREE.OrthographicCamera | THREE.PerspectiveCamera;

const toVec3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const copyPose = (p: CameraPose): CameraPose => ({ pos: [...p.pos], target: [...p.target], zoom: p.zoom });

export interface CameraRigEvents {
  alignedChange: (aligned: boolean) => void;
  /** The live camera object changed (ortho ↔ perspective): rebind the gizmo. */
  cameraChange: (camera: AnyCamera) => void;
  /** Something moved the camera: render. */
  change: () => void;
}

export class CameraRig {
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 200);
  readonly persp = new THREE.PerspectiveCamera(FOV, 1, 0.01, 400);
  camera: AnyCamera = this.ortho;
  orbit: OrbitControls | null = null;

  private aligned = false;
  private prevCustom: CameraPose | null = null;
  private spec: AlignSpec | null = null;
  private specKey = '';
  private css = { w: 1, h: 1 };
  private dev = { w: 1, h: 1 };
  private keys = new Set<FlyKey>();
  private shift = false;
  private flySpeed = 1.5;
  private gesture: { start: CameraPose; travel: number } | null = null;

  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();

  constructor(private events: CameraRigEvents) {
    for (const cam of [this.ortho, this.persp]) {
      cam.up.set(0, 1, 0);
      cam.position.set(0, 0.5, ORTHO_DIST);
    }
  }

  /** Create OrbitControls. Call AFTER TransformControls exists, so the gizmo's pointerdown listener runs first. */
  connect(dom: HTMLElement): void {
    const o = new OrbitControls(this.camera, dom);
    o.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    o.enableDamping = true;
    o.dampingFactor = DAMPING;
    o.screenSpacePanning = true;
    o.zoomToCursor = true;
    o.minZoom = 0.02;
    o.maxZoom = 600;
    o.minDistance = 0.05;
    o.maxDistance = 200;
    o.target.set(0, 0.5, 0);
    o.addEventListener('change', () => this.onOrbitChange());
    this.orbit = o;
    o.update();
  }

  dispose(): void {
    this.orbit?.dispose();
    this.orbit = null;
  }

  get isOrtho(): boolean {
    return this.camera === this.ortho;
  }

  isAligned(): boolean {
    return this.aligned;
  }

  hasPreviousView(): boolean {
    return this.prevCustom !== null;
  }

  setFlySpeed(unitsPerSec: number): void {
    this.flySpeed = Math.max(0.01, unitsPerSec);
  }

  setOrbitEnabled(on: boolean): void {
    if (this.orbit)
      this.orbit.enabled = on;
  }

  // ---------- sizing ----------

  /** CSS size plus drawing-buffer size (device px; the aligned zoom snaps texels to whole device pixels). */
  resize(cssW: number, cssH: number, devW: number, devH: number): void {
    this.css = { w: Math.max(1, cssW), h: Math.max(1, cssH) };
    this.dev = { w: Math.max(1, devW), h: Math.max(1, devH) };
    const aspect = this.dev.w / this.dev.h;
    this.ortho.left = -HALF_H0 * aspect;
    this.ortho.right = HALF_H0 * aspect;
    this.ortho.top = HALF_H0;
    this.ortho.bottom = -HALF_H0;
    this.ortho.updateProjectionMatrix();
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    if (this.aligned && this.spec)
      this.setView(this.alignedPose());
  }

  /** World units per CSS pixel at world point p (screen-space sizing of joints, picking tolerances). */
  worldPerPixel(p: THREE.Vector3): number {
    if (this.camera === this.ortho)
      return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / this.css.h;
    const cam = this.persp;
    cam.getWorldDirection(this.v3);
    const depth = Math.max(1e-4, this.v2.copy(p).sub(cam.position).dot(this.v3));
    return (2 * depth * TAN_HALF_FOV) / this.css.h;
  }

  get cssSize(): { w: number; h: number } {
    return this.css;
  }

  // ---------- aligned view ----------

  /** The doc's aligned camera changed (doc swap, re-lift, direction / pitch / canvas change). Re-aligns when aligned. */
  setAlignSpec(spec: AlignSpec | null): void {
    const key = spec ? JSON.stringify([spec.view.target, spec.view.toCamera, spec.view.halfW, spec.view.halfH, spec.canvas]) : '';
    this.spec = spec;
    if (key === this.specKey)
      return;
    this.specKey = key;
    if (this.aligned && spec)
      this.setView(this.alignedPose());
  }

  /** The camera placement that reproduces the canvas: ortho at a whole number of device px per texel when it fits. */
  alignedPose(): CameraPose {
    const spec = this.spec!;
    const { view, canvas } = spec;
    const ppu = canvas.width / (2 * view.halfW);
    const T = view.target;
    const r = view.right;
    const u = view.up;
    const c = view.toCamera;
    if (this.camera === this.persp) {
      const halfVis = Math.max(view.halfH, view.halfW / this.persp.aspect) / FIT;
      const d = halfVis / TAN_HALF_FOV;
      return { pos: [T[0] + c[0] * d, T[1] + c[1] * d, T[2] + c[2] * d], target: [...T], zoom: 1 };
    }
    let n = Math.min((this.dev.w * FIT) / canvas.width, (this.dev.h * FIT) / canvas.height);
    const whole = n >= 1;
    if (whole)
      n = Math.floor(n);
    const zoom = (2 * HALF_H0 * n * ppu) / this.dev.h;
    // Texel edges land on device-pixel edges: shift half a device pixel when the margin is odd
    const worldPerDev = 1 / (n * ppu);
    const dx = whole && Math.round(this.dev.w - n * canvas.width) % 2 !== 0 ? 0.5 * worldPerDev : 0;
    const dy = whole && Math.round(this.dev.h - n * canvas.height) % 2 !== 0 ? 0.5 * worldPerDev : 0;
    const tgt: Vec3 = [T[0] + r[0] * dx + u[0] * dy, T[1] + r[1] * dx + u[1] * dy, T[2] + r[2] * dx + u[2] * dy];
    return { pos: [tgt[0] + c[0] * ORTHO_DIST, tgt[1] + c[1] * ORTHO_DIST, tgt[2] + c[2] * ORTHO_DIST], target: tgt, zoom };
  }

  /** Not aligned → remember the custom view and align; aligned → return to the previous custom view (if any). */
  toggleAlign(): void {
    if (!this.spec)
      return;
    if (this.aligned) {
      if (this.prevCustom) {
        this.setView(this.prevCustom);
        this.setAligned(false);
      }
      return;
    }
    this.prevCustom = this.currentPose();
    this.setView(this.alignedPose());
    this.setAligned(true);
  }

  /** Align without touching the previous custom view (new doc, restored aligned ViewState). */
  alignNow(): void {
    if (!this.spec)
      return;
    this.setView(this.alignedPose());
    this.setAligned(true);
  }

  private setAligned(on: boolean): void {
    if (this.aligned === on)
      return;
    this.aligned = on;
    this.events.alignedChange(on);
  }

  /** Clear the aligned flag (wheel, fly keys, orbit / pan beyond the click slop). */
  breakAlign(): void {
    this.setAligned(false);
  }

  // ---------- placement ----------

  currentPose(): CameraPose {
    const o = this.orbit;
    return {
      pos: toVec3(this.camera.position),
      target: o ? toVec3(o.target) : [0, 0.5, 0],
      zoom: this.camera === this.ortho ? this.ortho.zoom : 1
    };
  }

  /** Damping-safe programmatic move: damping off, update (flush deltas), set, update, damping on. */
  setView(p: CameraPose): void {
    const o = this.orbit;
    if (o) {
      o.enableDamping = false;
      o.update();
    }
    this.camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
    if (this.camera === this.ortho) {
      this.ortho.zoom = p.zoom > 0 ? p.zoom : 1;
      this.ortho.updateProjectionMatrix();
    }
    if (o) {
      o.target.set(p.target[0], p.target[1], p.target[2]);
      o.update();
      o.enableDamping = true;
    } else
      this.camera.lookAt(p.target[0], p.target[1], p.target[2]);
    this.camera.updateMatrixWorld();
    this.events.change();
  }

  /** Same view expressed for the other camera type (matching visible height at the target). */
  private convertPose(p: CameraPose, toOrtho: boolean): CameraPose {
    const pos = this.v1.set(...p.pos);
    const tgt = this.v2.set(...p.target);
    const dir = this.v3.copy(pos).sub(tgt);
    const dist = dir.length();
    if (dist < 1e-9)
      dir.set(0, 0, 1);
    dir.normalize();
    if (toOrtho) {
      const halfVis = Math.max(1e-4, dist * TAN_HALF_FOV);
      return { pos: toVec3(dir.multiplyScalar(ORTHO_DIST).add(tgt)), target: [...p.target], zoom: HALF_H0 / halfVis };
    }
    const d = HALF_H0 / (p.zoom > 0 ? p.zoom : 1) / TAN_HALF_FOV;
    return { pos: toVec3(dir.multiplyScalar(d).add(tgt)), target: [...p.target], zoom: 1 };
  }

  /** Orthographic (default) or perspective. The orbit target is shared; aligned stays aligned. */
  setOrtho(ortho: boolean): void {
    if (ortho === this.isOrtho)
      return;
    const pose = this.convertPose(this.currentPose(), ortho);
    if (this.prevCustom)
      this.prevCustom = this.convertPose(this.prevCustom, ortho);
    this.camera = ortho ? this.ortho : this.persp;
    if (this.orbit)
      this.orbit.object = this.camera;
    this.events.cameraChange(this.camera);
    this.setView(this.aligned && this.spec ? this.alignedPose() : pose);
  }

  getViewState(): ViewState {
    const p = this.currentPose();
    return {
      mode: this.isOrtho ? 'ortho' : 'perspective', pos: p.pos, target: p.target, zoom: p.zoom,
      aligned: this.aligned, prevCustom: this.prevCustom ? copyPose(this.prevCustom) : null
    };
  }

  /** Restore a saved ViewState (null → aligned with no previous view). An aligned state is re-aligned fresh. */
  applyViewState(vs: ViewState | null): void {
    if (!vs) {
      this.prevCustom = null;
      this.alignNow();
      return;
    }
    const toOrtho = this.isOrtho;
    const sameMode = (vs.mode === 'ortho') === toOrtho;
    const conv = (p: CameraPose): CameraPose => sameMode ? copyPose(p) : this.convertPose(p, toOrtho);
    this.prevCustom = vs.prevCustom ? conv(vs.prevCustom) : null;
    if (vs.aligned && this.spec) {
      this.alignNow();
      return;
    }
    this.setView(conv(vs));
    this.setAligned(false);
  }

  // ---------- user gestures ----------

  /** The arbiter handed a pointer gesture to OrbitControls (LMB orbit on empty space, MMB pan). */
  beginGesture(): void {
    this.gesture = { start: this.currentPose(), travel: 0 };
  }

  /** Pointer travel so far (CSS px); beyond the click slop the camera has really moved, so `aligned` clears. */
  gestureTravel(travel: number): void {
    if (!this.gesture)
      return;
    this.gesture.travel = travel;
    if (travel >= CLICK_SLOP)
      this.setAligned(false);
  }

  /** Returns true when it was a click (travel below the slop): the camera snaps back to where it started. */
  endGesture(): boolean {
    const g = this.gesture;
    this.gesture = null;
    if (!g)
      return false;
    if (g.travel < CLICK_SLOP) {
      this.setView(g.start);
      return true;
    }
    return false;
  }

  private onOrbitChange(): void {
    this.events.change();
  }

  // ---------- fly keys ----------

  setKey(key: FlyKey, down: boolean): void {
    if (down)
      this.keys.add(key);
    else
      this.keys.delete(key);
  }

  setShift(on: boolean): void {
    this.shift = on;
  }

  clearKeys(): void {
    this.keys.clear();
    this.shift = false;
  }

  get keysHeld(): boolean {
    return this.keys.size > 0;
  }

  /** Per frame: fly keys, then OrbitControls damping. Returns true while something is still moving. */
  update(dt: number): boolean {
    let flew = false;
    if (this.keys.size > 0 && this.orbit && dt > 0)
      flew = this.fly(dt);
    let moved = false;
    const o = this.orbit;
    if (o) {
      moved = o.update();
      if (!moved && o.enableDamping) {
        // Settled below OrbitControls' threshold: apply the leftover damping now, or the next unrelated render
        // (a panel edit, a selection) would make the idle camera creep
        o.enableDamping = false;
        o.update();
        o.enableDamping = true;
      }
    }
    return flew || moved || this.keys.size > 0;
  }

  private fly(dt: number): boolean {
    const o = this.orbit!;
    const k = this.keys;
    const speed = this.flySpeed * (this.shift ? SHIFT_BOOST : 1);
    const axis = (pos: FlyKey, neg: FlyKey): number => (k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0);
    const fwd = axis('forward', 'back');
    const side = axis('right', 'left');
    const vert = axis('up', 'down');
    if (fwd === 0 && side === 0 && vert === 0)
      return false;
    const forward = this.camera.getWorldDirection(this.v1);
    const right = this.v2.crossVectors(forward, this.camera.up);
    if (right.lengthSq() < 1e-10)
      right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    right.normalize();
    const move = this.v3.set(0, 0, 0);
    let strafe = speed;
    if (this.camera === this.ortho) {
      if (fwd !== 0) {
        const z = this.ortho.zoom * Math.exp(fwd * speed * ZOOM_RATE * dt);
        this.ortho.zoom = THREE.MathUtils.clamp(z, o.minZoom, o.maxZoom);
        this.ortho.updateProjectionMatrix();
      }
      strafe = (speed * (2 * HALF_H0 / this.ortho.zoom)) / ORTHO_STRAFE_REF;
    } else
      move.addScaledVector(forward, fwd * speed * dt);
    move.addScaledVector(right, side * strafe * dt);
    move.y += vert * strafe * dt;
    this.camera.position.add(move);
    o.target.add(move);
    this.setAligned(false);
    this.events.change();
    return true;
  }
}
