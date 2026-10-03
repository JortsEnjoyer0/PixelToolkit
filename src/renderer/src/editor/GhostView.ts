// Onion skin (toolbar "Ghost frames"): the committed poses of the track frames before the shown one, drawn as our rig
// (RigMeshes; not the OpenPose overlay, no images) at a uniform 35 % opacity under the active skeleton, tinted with the
// toolbar's ghost colour (setColor). Display only:
// the viewport hands it poses, so ghosts are never picked, never get the gizmo and never affect hover or the cursor.
//
// Each ghost reads as one flat layer: a depth-only pre-pass of its meshes (sharing their instance buffers and shader
// programs, so the depths match exactly) and then the colour pass at LessEqual, so only its front-most surface blends:
// no darker spots where its bones, joints and outline hulls overlap, and the outline stays a clean rim. A full-screen
// depth reset after each ghost stacks the layers (the frame nearest the active one on top) instead of letting nearly
// coincident ghosts z-fight, and the last reset leaves the active skeleton drawing above every ghost.
//
// Ghosts are pooled (allocated on first use, at most GHOST_COUNT_MAX). FK runs in setPoses() only; layout() re-sizes the
// shown ghosts once per rendered frame (screen-space sizing). Lit by the viewport's shared RigLights.
import * as THREE from 'three';
import type { Pose, RigCalibration } from '../core/model';
import { createFkResult, fk, type FkResult } from '../core/rig/fk';
import { RIG_COLOR, RigMeshes, type RigGeometries, type RigMesh, type ScreenScale } from './RigMeshes';
import { DEFAULT_GHOST_COLOR, GHOST_COUNT_MAX } from './types';

/** Every part of a ghost is drawn at this fraction of its normal opacity. */
const GHOST_OPACITY = 0.35;

interface Tint { bone: number; joint: number; end: number }

const WHITE = new THREE.Color(0xffffff);

/** The toolbar's ghost colour as the rig's three tones: bones as picked, joints lighter, end sites darker. */
function ghostTint(hex: string): Tint {
  const c = new THREE.Color(hex);
  return { bone: c.getHex(), joint: c.clone().lerp(WHITE, 0.25).getHex(), end: c.clone().multiplyScalar(0.85).getHex() };
}
/** Render orders per ghost (pool index k): pre-pass, colour pass, depth reset. */
const ORDER_STRIDE = 3;

interface Ghost {
  /** A plain Object3D, not a Group: a Group would restart the render-order group of its children. */
  root: THREE.Object3D;
  rig: RigMeshes;
  prepass: RigMesh[];
  fkr: FkResult;
}

/** Fullscreen triangle at the far plane that writes depth only: resets the depth buffer between ghost layers. */
function depthResetMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }',
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    depthTest: true, // depth writes need the test enabled (ALWAYS passes)
    depthFunc: THREE.AlwaysDepth,
    depthWrite: true,
    colorWrite: false,
    transparent: true // sorted with the ghosts' (transparent) meshes by render order
  });
}

function depthResetGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

export class GhostView {
  /** Add to the foreground scene before the active skeleton. renderOrder -1: this Group's items sort before the skeleton's. */
  readonly group = new THREE.Group();
  private pool: Ghost[] = [];
  private shown = 0;
  private calib: RigCalibration | null = null;
  private resetGeo: THREE.BufferGeometry | null = null;
  private resetMat: THREE.ShaderMaterial | null = null;
  private colorHex = DEFAULT_GHOST_COLOR;
  private tint = ghostTint(DEFAULT_GHOST_COLOR);

  constructor(private readonly geo: RigGeometries) {
    this.group.renderOrder = -1;
    this.group.visible = false;
  }

  /** Ghosts on screen. */
  get count(): number {
    return this.shown;
  }

  /** Ghost poses oldest → nearest (the nearest draws on top; at most GHOST_COUNT_MAX are used). Runs FK once per pose; [] hides. */
  setPoses(poses: readonly Readonly<Pose>[], calib: RigCalibration | null): void {
    const n = calib ? Math.min(poses.length, GHOST_COUNT_MAX) : 0;
    if (calib) {
      for (let k = 0; k < n; k++)
        fk(poses[k], calib, this.ghost(k).fkr);
    }
    for (let k = 0; k < this.pool.length; k++)
      this.pool[k].root.visible = k < n;
    this.shown = n;
    this.calib = n > 0 ? calib : null;
    this.group.visible = n > 0;
  }

  /** Re-lay out the shown ghosts for the current camera (call once per rendered frame). */
  layout(scale: ScreenScale): void {
    const calib = this.calib;
    if (!calib)
      return;
    for (let k = 0; k < this.shown; k++) {
      const g = this.pool[k];
      g.rig.layout(g.fkr, calib, scale);
    }
  }

  /** Tint every ghost ('#rrggbb'; pooled and future ones). */
  setColor(hex: string): void {
    if (hex === this.colorHex)
      return;
    this.colorHex = hex;
    this.tint = ghostTint(hex);
    for (const g of this.pool)
      this.paint(g.rig);
  }

  /** The pre-pass shares the colour pass's instanceColor buffer, so painting one rig covers both. */
  private paint(rig: RigMeshes): void {
    const t = this.tint;
    rig.paint((_bone, base) => {
      if (base === RIG_COLOR.joint)
        return t.joint;
      return base === RIG_COLOR.end ? t.end : t.bone;
    });
  }

  /** Pool entry k, allocating up to it on first use. */
  private ghost(k: number): Ghost {
    while (this.pool.length <= k)
      this.pool.push(this.createGhost(this.pool.length));
    return this.pool[k];
  }

  private createGhost(k: number): Ghost {
    const order = k * ORDER_STRIDE;
    const rig = new RigMeshes(this.geo);
    this.paint(rig);
    const prepass = rig.meshes.map((mesh): RigMesh => {
      const material = mesh.material.clone(); // same shader program as the colour pass → bit-identical depths
      material.colorWrite = false;
      const pre: RigMesh = new THREE.InstancedMesh(mesh.geometry, material, mesh.count);
      pre.instanceMatrix = mesh.instanceMatrix; // shared: rig.layout() moves both passes
      pre.instanceColor = mesh.instanceColor;
      pre.frustumCulled = false;
      pre.renderOrder = order;
      return pre;
    });
    for (const mesh of rig.meshes) {
      mesh.material.opacity *= GHOST_OPACITY;
      mesh.material.depthWrite = false; // the pre-pass wrote it; LessEqual keeps the front-most surface only
      mesh.renderOrder = order + 1;
    }
    rig.links.material.opacity *= GHOST_OPACITY;
    rig.links.renderOrder = order + 1;
    this.resetGeo ??= depthResetGeometry();
    this.resetMat ??= depthResetMaterial();
    const reset = new THREE.Mesh(this.resetGeo, this.resetMat);
    reset.frustumCulled = false;
    reset.renderOrder = order + 2;
    const root = new THREE.Object3D();
    root.add(...prepass, ...rig.meshes, rig.links, reset);
    this.group.add(root);
    return { root, rig, prepass, fkr: createFkResult() };
  }

  dispose(): void {
    for (const g of this.pool) {
      for (const pre of g.prepass) {
        pre.material.dispose();
        pre.dispose();
      }
      g.rig.dispose();
    }
    this.pool = [];
    this.shown = 0;
    this.calib = null;
    this.group.clear();
    this.resetGeo?.dispose();
    this.resetMat?.dispose();
    this.resetGeo = null;
    this.resetMat = null;
  }
}
