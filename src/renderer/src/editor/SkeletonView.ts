// The rig drawn Blender-style: octahedral bones between joints, joint spheres and end sites, relationship lines for
// disconnected children, and an anchor glyph at Hips. Instanced meshes are allocated once and re-laid out every render
// from the FK result (screen-space sizing: joints stay ~9 px across at any zoom).
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

/** Colours (sRGB). */
const COLOR = {
  bone: 0x8d9bb3,
  joint: 0xa9b5c8,
  end: 0x7a879c,
  outline: 0x07090c,
  hover: 0xc4d0e3,
  selected: 0x4c8dff,
  selectedHover: 0x7aaaff,
  link: 0x56627a,
  anchor: 0xd7dfeb
};

/** Screen sizes, CSS px. */
const PX = { joint: 4.2, hips: 5.2, end: 2.8, boneMin: 1.8, boneMax: 4.6, outline: 1.2, emphasis: 1.4, anchor: 17, anchorOffset: 13 };
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

export interface ScreenScale {
  /** World units per CSS px at a world point. */
  worldPerPixel(p: THREE.Vector3): number;
}

export class SkeletonView {
  /** Add to the overlay scene (drawn after clearDepth, so always over the image). */
  readonly group = new THREE.Group();
  private bones: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private joints: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshLambertMaterial>;
  /** Inverted hulls (back faces, slightly larger) give every bone and joint a dark outline over busy sprites. */
  private boneHull: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private jointHull: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private links: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private anchor: THREE.Sprite;
  private light = new THREE.DirectionalLight(0xffffff, 1.6);
  private fkr: FkResult | null = null;
  private calib: RigCalibration | null = null;
  private shown = true;
  private selected = -1;
  private hover = -1;
  private dimmed = false;

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private qa = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private t = new THREE.Vector3();
  private s = new THREE.Vector3();
  private c = new THREE.Color();
  private yAxis = new THREE.Vector3(0, 1, 0);

  constructor(anchorTex: THREE.Texture) {
    const octa = octahedronGeometry();
    const sphere = new THREE.SphereGeometry(1, 14, 10);
    const jointCount = BONES.length + END_SITES.length;
    this.bones = new THREE.InstancedMesh(octa, new THREE.MeshLambertMaterial({ flatShading: true, transparent: true }), BONES.length);
    this.joints = new THREE.InstancedMesh(sphere, new THREE.MeshLambertMaterial({ transparent: true }), jointCount);
    const hullMat = (): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: COLOR.outline, side: THREE.BackSide, transparent: true });
    this.boneHull = new THREE.InstancedMesh(octa, hullMat(), BONES.length);
    this.jointHull = new THREE.InstancedMesh(sphere, hullMat(), jointCount);
    for (const mesh of [this.bones, this.joints, this.boneHull, this.jointHull]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.boneHull.renderOrder = 0;
    this.jointHull.renderOrder = 0;
    this.bones.renderOrder = 1;
    this.joints.renderOrder = 2;

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINKS.length * 6), 3));
    this.links = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: COLOR.link, transparent: true, opacity: 0.8 }));
    this.links.frustumCulled = false;

    this.anchor = new THREE.Sprite(new THREE.SpriteMaterial({ map: anchorTex, color: COLOR.anchor, depthTest: false, depthWrite: false, transparent: true }));
    this.anchor.renderOrder = 5;

    const hemi = new THREE.HemisphereLight(0xe4ecff, 0x2a2f38, 2.1);
    this.group.add(this.boneHull, this.jointHull, this.bones, this.joints, this.links, this.anchor, hemi, this.light, this.light.target);
    this.applyStyle();
  }

  /** The FK result to draw (read at every layout; the viewport mutates it in place) and the calibration. null hides. */
  setPose(fkr: FkResult | null, calib: RigCalibration | null): void {
    this.fkr = fkr;
    this.calib = calib;
    this.updateVisibility();
  }

  /** The skeleton toolbar toggle (hidden while watching an animation unobstructed). */
  setShown(on: boolean): void {
    this.shown = on;
    this.updateVisibility();
  }

  private updateVisibility(): void {
    this.group.visible = this.shown && this.fkr !== null && this.calib !== null;
  }

  /** Bone indices (-1 = none). Dimmed in COCO edit mode (the rig is not pickable there). */
  setStyle(selected: number, hover: number, dimmed: boolean): void {
    if (selected === this.selected && hover === this.hover && dimmed === this.dimmed)
      return;
    this.selected = selected;
    this.hover = hover;
    this.dimmed = dimmed;
    this.applyStyle();
  }

  private colorFor(bone: number, base: number): number {
    const sel = bone === this.selected;
    const hov = bone === this.hover;
    if (sel)
      return hov ? COLOR.selectedHover : COLOR.selected;
    return hov ? COLOR.hover : base;
  }

  private applyStyle(): void {
    for (let i = 0; i < BONES.length; i++) {
      this.bones.setColorAt(i, this.c.setHex(this.colorFor(i, COLOR.bone)));
      this.joints.setColorAt(i, this.c.setHex(this.colorFor(i, COLOR.joint)));
    }
    END_SITES.forEach((e, k) => {
      this.joints.setColorAt(BONES.length + k, this.c.setHex(this.colorFor(BONE_INDEX[e.parent], COLOR.end)));
    });
    this.bones.instanceColor!.needsUpdate = true;
    this.joints.instanceColor!.needsUpdate = true;
    const opacity = this.dimmed ? 0.28 : 1;
    this.bones.material.opacity = opacity;
    this.joints.material.opacity = opacity;
    this.boneHull.material.opacity = this.dimmed ? 0.15 : 0.85;
    this.jointHull.material.opacity = this.dimmed ? 0.15 : 0.85;
    this.boneHull.visible = !this.dimmed;
    this.jointHull.visible = !this.dimmed;
    this.links.material.opacity = this.dimmed ? 0.25 : 0.8;
    const am = this.anchor.material;
    am.opacity = opacity;
    am.color.setHex(this.selected === 0 ? COLOR.selected : COLOR.anchor);
  }

  /** Re-lay out every instance for the current camera (call once per rendered frame). */
  layout(camera: THREE.Camera, scale: ScreenScale, target: THREE.Vector3): void {
    const fkr = this.fkr;
    const calib = this.calib;
    if (!fkr || !calib)
      return;
    for (let i = 0; i < BONES.length; i++) {
      const head = fkr.pos[i];
      const tail = tailPosition(fkr, i);
      this.p.set(head[0], head[1], head[2]);
      this.t.set(tail[0], tail[1], tail[2]);
      const len = this.p.distanceTo(this.t);
      const wpp = scale.worldPerPixel(this.p);
      const off = tailOffset(calib, i);
      this.qa.setFromUnitVectors(this.yAxis, this.s.set(off[0], off[1], off[2]).normalize());
      const rw = fkr.rotW[i];
      this.q.set(rw[0], rw[1], rw[2], rw[3]).multiply(this.qa);
      const emph = i === this.selected || i === this.hover ? PX.emphasis : 1;
      const w = THREE.MathUtils.clamp(BONE_WIDTH * len, PX.boneMin * wpp, PX.boneMax * wpp) * emph;
      const l = Math.max(len, 1e-6);
      this.m.compose(this.p, this.q, this.s.set(w, l, w));
      this.bones.setMatrixAt(i, this.m);
      const wo = w + PX.outline * wpp;
      this.m.compose(this.p, this.q, this.s.set(wo, l, wo));
      this.boneHull.setMatrixAt(i, this.m);
      this.placeJoint(i, (i === 0 ? PX.hips : PX.joint) * wpp * emph, wpp);
    }
    for (let k = 0; k < END_SITES.length; k++) {
      const e = fkr.endPos[k];
      this.p.set(e[0], e[1], e[2]);
      const wpp = scale.worldPerPixel(this.p);
      this.placeJoint(BONES.length + k, PX.end * wpp, wpp);
    }
    for (const mesh of [this.bones, this.joints, this.boneHull, this.jointHull])
      mesh.instanceMatrix.needsUpdate = true;

    const arr = this.links.geometry.getAttribute('position') as THREE.BufferAttribute;
    LINKS.forEach(([a, b], k) => {
      const pa = fkr.pos[a];
      const pb = fkr.pos[b];
      arr.setXYZ(2 * k, pa[0], pa[1], pa[2]);
      arr.setXYZ(2 * k + 1, pb[0], pb[1], pb[2]);
    });
    arr.needsUpdate = true;

    // Anchor glyph: beside the Hips joint, offset down-right in screen space
    const hips = fkr.pos[0];
    this.p.set(hips[0], hips[1], hips[2]);
    const wpp = scale.worldPerPixel(this.p);
    const right = this.s.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = this.t.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    this.anchor.position.copy(this.p).addScaledVector(right, PX.anchorOffset * wpp).addScaledVector(up, -PX.anchorOffset * wpp);
    this.anchor.scale.setScalar(PX.anchor * wpp);

    // Camera-relative key light (Blender solid-mode feel)
    this.light.position.copy(camera.position).addScaledVector(up, 3).addScaledVector(right, 1.5);
    this.light.target.position.copy(target);
    this.light.target.updateMatrixWorld();
  }

  /** Joint sphere + its outline hull at this.p. */
  private placeJoint(index: number, r: number, wpp: number): void {
    this.q.identity();
    this.m.compose(this.p, this.q, this.s.set(r, r, r));
    this.joints.setMatrixAt(index, this.m);
    const ro = r + PX.outline * wpp;
    this.m.compose(this.p, this.q, this.s.set(ro, ro, ro));
    this.jointHull.setMatrixAt(index, this.m);
  }

  dispose(): void {
    this.boneHull.material.dispose();
    this.boneHull.dispose();
    this.jointHull.material.dispose();
    this.jointHull.dispose();
    this.bones.geometry.dispose();
    this.bones.material.dispose();
    this.bones.dispose();
    this.joints.geometry.dispose();
    this.joints.material.dispose();
    this.joints.dispose();
    this.links.geometry.dispose();
    this.links.material.dispose();
    this.anchor.material.dispose();
    this.light.dispose();
  }
}
