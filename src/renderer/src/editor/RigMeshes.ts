// One skeleton of our rig drawn Blender-style, shared by the active SkeletonView and the onion-skin GhostView:
// octahedral bones between joints, joint spheres and end sites, dark outline hulls, and relationship lines for
// disconnected children. Instanced meshes are allocated once and re-laid out every render from an FK result
// (screen-space sizing: joints stay ~9 px across at any zoom). RigLights is the single light rig of the foreground scene.
import * as THREE from 'three';
import type { RigCalibration } from '../core/model';
import type { FkResult } from '../core/rig/fk';
import { BONE_INDEX, BONES, END_SITE_INDEX, END_SITES, PARENT_INDEX } from '../core/rig/rigDef';

/** A bone's tail: its end site, otherwise its first child bone (BONES order). */
export interface BoneTail { kind: 'bone' | 'end'; index: number }

export const BONE_TAILS: readonly BoneTail[] = BONES.map((b, i): BoneTail =>
  b.endSite ? { kind: 'end', index: END_SITE_INDEX[b.endSite] } : { kind: 'bone', index: PARENT_INDEX.indexOf(i) });

/** Children that do not start at their parent's tail (pelvis → thighs, upper chest → clavicles): dashed-style links. */
const LINKS: readonly (readonly [number, number])[] = BONES.flatMap((_, i) => {
  const p = PARENT_INDEX[i];
  const t = p >= 0 ? BONE_TAILS[p] : null;
  return t && !(t.kind === 'bone' && t.index === i) ? [[p, i] as const] : [];
});

export function tailPosition(fkr: FkResult, bone: number): readonly number[] {
  const t = BONE_TAILS[bone];
  if (t.index < 0)
    return fkr.pos[bone];
  return t.kind === 'end' ? fkr.endPos[t.index] : fkr.pos[t.index];
}

/** Calibrated head → tail offset in the bone's rest frame (what the octahedron is aligned to). */
function tailOffset(calib: RigCalibration, bone: number): readonly number[] {
  const t = BONE_TAILS[bone];
  if (t.index < 0)
    return BONES[bone].restDir;
  return calib.offsets[t.kind === 'end' ? END_SITES[t.index].name : BONES[t.index].name];
}

/** Base colours (sRGB). */
export const RIG_COLOR = { bone: 0x8d9bb3, joint: 0xa9b5c8, end: 0x7a879c, outline: 0x07090c, link: 0x56627a };
/** Base opacities of the outline hulls and the relationship links (bones and joints: 1). */
export const RIG_OPACITY = { hull: 0.85, link: 0.8 };

/** Screen sizes, CSS px. */
const PX = { joint: 4.2, hips: 5.2, end: 2.8, boneMin: 1.8, boneMax: 4.6, outline: 1.2 };
const BONE_WIDTH = 0.08;

/** Unit octahedral bone along +Y: head at 0, tail at 1, square ring at 10% (Blender-like). */
function octahedronGeometry(): THREE.BufferGeometry {
  const r = 0.1;
  const v = [[0, 0, 0], [0, 1, 0], [1, r, 0], [0, r, 1], [-1, r, 0], [0, r, -1]];
  // Counter-clockwise seen from outside (outward normals): the outline hull relies on it
  const faces = [[0, 2, 3], [0, 3, 4], [0, 4, 5], [0, 5, 2], [1, 3, 2], [1, 4, 3], [1, 5, 4], [1, 2, 5]];
  const pos: number[] = [];
  for (const f of faces) {
    for (const k of f)
      pos.push(v[k][0], v[k][1], v[k][2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Geometry shared by every RigMeshes of a viewport (owned by the viewport: disposeRigGeometries). */
export interface RigGeometries { octa: THREE.BufferGeometry; sphere: THREE.BufferGeometry }

export const createRigGeometries = (): RigGeometries => ({ octa: octahedronGeometry(), sphere: new THREE.SphereGeometry(1, 14, 10) });

export function disposeRigGeometries(g: RigGeometries): void {
  g.octa.dispose();
  g.sphere.dispose();
}

export interface ScreenScale {
  /** World units per CSS px at a world point. */
  worldPerPixel(p: THREE.Vector3): number;
}

export type RigMesh = THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial | THREE.MeshBasicMaterial>;

const baseColor = (_bone: number, base: number): number => base;
const noEmphasis = (): number => 1;

/** Layout scratch, shared by every RigMeshes (layout is synchronous). */
const S = {
  m: new THREE.Matrix4(), q: new THREE.Quaternion(), qa: new THREE.Quaternion(), p: new THREE.Vector3(), t: new THREE.Vector3(),
  s: new THREE.Vector3(), c: new THREE.Color(), yAxis: new THREE.Vector3(0, 1, 0)
};

/** One skeleton's meshes. Add them to a scene yourself (`meshes` and `links`); render orders: hulls 0, bones 1, joints 2. */
export class RigMeshes {
  readonly bones: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  readonly joints: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  /** Inverted hulls (back faces, slightly larger) give every bone and joint a dark outline over busy sprites. */
  readonly boneHull: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly jointHull: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  readonly links: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  /** The instanced meshes, outline hulls first. */
  readonly meshes: readonly RigMesh[];

  constructor(geo: RigGeometries) {
    const jointCount = BONES.length + END_SITES.length;
    this.bones = new THREE.InstancedMesh(geo.octa, new THREE.MeshLambertMaterial({ flatShading: true, transparent: true }), BONES.length);
    this.joints = new THREE.InstancedMesh(geo.sphere, new THREE.MeshLambertMaterial({ transparent: true }), jointCount);
    const hullMat = (): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({ color: RIG_COLOR.outline, side: THREE.BackSide, transparent: true, opacity: RIG_OPACITY.hull });
    this.boneHull = new THREE.InstancedMesh(geo.octa, hullMat(), BONES.length);
    this.jointHull = new THREE.InstancedMesh(geo.sphere, hullMat(), jointCount);
    this.meshes = [this.boneHull, this.jointHull, this.bones, this.joints];
    for (const mesh of this.meshes) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.boneHull.renderOrder = 0;
    this.jointHull.renderOrder = 0;
    this.bones.renderOrder = 1;
    this.joints.renderOrder = 2;

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINKS.length * 6), 3));
    this.links = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: RIG_COLOR.link, transparent: true, opacity: RIG_OPACITY.link }));
    this.links.frustumCulled = false;
    this.paint();
  }

  /** Instance colours: colorOf(bone, base colour) for each bone and joint; an end site asks for its parent bone. */
  paint(colorOf: (bone: number, base: number) => number = baseColor): void {
    const c = S.c;
    for (let i = 0; i < BONES.length; i++) {
      this.bones.setColorAt(i, c.setHex(colorOf(i, RIG_COLOR.bone)));
      this.joints.setColorAt(i, c.setHex(colorOf(i, RIG_COLOR.joint)));
    }
    END_SITES.forEach((e, k) => {
      this.joints.setColorAt(BONES.length + k, c.setHex(colorOf(BONE_INDEX[e.parent], RIG_COLOR.end)));
    });
    this.bones.instanceColor!.needsUpdate = true;
    this.joints.instanceColor!.needsUpdate = true;
  }

  /** Re-lay out every instance for the current camera. emphasis(bone) scales a bone's width and joint (selection, hover). */
  layout(fkr: FkResult, calib: RigCalibration, scale: ScreenScale, emphasis: (bone: number) => number = noEmphasis): void {
    const { m, q, qa, p, t, s } = S;
    for (let i = 0; i < BONES.length; i++) {
      const head = fkr.pos[i];
      const tail = tailPosition(fkr, i);
      p.set(head[0], head[1], head[2]);
      t.set(tail[0], tail[1], tail[2]);
      const len = p.distanceTo(t);
      const wpp = scale.worldPerPixel(p);
      const off = tailOffset(calib, i);
      qa.setFromUnitVectors(S.yAxis, s.set(off[0], off[1], off[2]).normalize());
      const rw = fkr.rotW[i];
      q.set(rw[0], rw[1], rw[2], rw[3]).multiply(qa);
      const emph = emphasis(i);
      const w = THREE.MathUtils.clamp(BONE_WIDTH * len, PX.boneMin * wpp, PX.boneMax * wpp) * emph;
      const l = Math.max(len, 1e-6);
      m.compose(p, q, s.set(w, l, w));
      this.bones.setMatrixAt(i, m);
      const wo = w + PX.outline * wpp;
      m.compose(p, q, s.set(wo, l, wo));
      this.boneHull.setMatrixAt(i, m);
      this.placeJoint(i, (i === 0 ? PX.hips : PX.joint) * wpp * emph, wpp);
    }
    for (let k = 0; k < END_SITES.length; k++) {
      const e = fkr.endPos[k];
      p.set(e[0], e[1], e[2]);
      const wpp = scale.worldPerPixel(p);
      this.placeJoint(BONES.length + k, PX.end * wpp, wpp);
    }
    for (const mesh of this.meshes)
      mesh.instanceMatrix.needsUpdate = true;

    const arr = this.links.geometry.getAttribute('position') as THREE.BufferAttribute;
    LINKS.forEach(([a, b], k) => {
      const pa = fkr.pos[a];
      const pb = fkr.pos[b];
      arr.setXYZ(2 * k, pa[0], pa[1], pa[2]);
      arr.setXYZ(2 * k + 1, pb[0], pb[1], pb[2]);
    });
    arr.needsUpdate = true;
  }

  /** Joint sphere + its outline hull at the layout scratch point. */
  private placeJoint(index: number, r: number, wpp: number): void {
    const { m, q, p, s } = S;
    q.identity();
    m.compose(p, q, s.set(r, r, r));
    this.joints.setMatrixAt(index, m);
    const ro = r + PX.outline * wpp;
    m.compose(p, q, s.set(ro, ro, ro));
    this.jointHull.setMatrixAt(index, m);
  }

  /** Materials, link geometry and instance buffers (the shared RigGeometries stay). */
  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.material.dispose();
      mesh.dispose();
    }
    this.links.geometry.dispose();
    this.links.material.dispose();
  }
}

/**
 * The rig's lighting (Blender solid-mode feel): a sky / ground fill plus a key light that follows the camera. ONE per
 * foreground scene and outside the skeleton group, so the active skeleton and every ghost are lit identically, lights
 * never accumulate, and hiding the skeleton does not unlight the ghosts.
 */
export class RigLights {
  readonly group = new THREE.Group();
  private hemi = new THREE.HemisphereLight(0xe4ecff, 0x2a2f38, 2.1);
  private key = new THREE.DirectionalLight(0xffffff, 1.6);
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();

  constructor() {
    this.group.add(this.hemi, this.key, this.key.target);
  }

  /** Camera-relative key light aimed at the orbit target (call once per rendered frame). */
  update(camera: THREE.Camera, target: THREE.Vector3): void {
    const right = this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    this.key.position.copy(camera.position).addScaledVector(up, 3).addScaledVector(right, 1.5);
    this.key.target.position.copy(target);
    this.key.target.updateMatrixWorld();
  }

  dispose(): void {
    this.hemi.dispose();
    this.key.dispose();
  }
}
