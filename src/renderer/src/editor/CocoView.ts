// COCO-18 overlay in the pinned OpenPose palette (docs/skelanim/rig.md "OpenPose palette"): 17 limbs (screen-space
// width lines) and 18 joint dots, drawn on top of everything but the gizmo. In COCO edit mode the dots are larger
// draggable handles (NECK stays a derived, non-pickable point) and a ring marks the hovered / dragged handle.
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Vec3 } from '../core/model';
import { COCO_LIMBS, OPENPOSE_COLORS, limbColor, type Rgb } from '../core/rig/coco';

const N = OPENPOSE_COLORS.length;
const PX = { limb: 2, limbEdit: 2.5, joint: 5.5, jointEdit: 10, ring: 18 };

/** sRGB 0..255 → linear (vertex colours are not colour-managed). */
function linear(rgb: Rgb, c = new THREE.Color()): THREE.Color {
  return c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
}

export class CocoView {
  /** Add to the COCO scene (rendered after the skeleton, without depth testing). */
  readonly group = new THREE.Group();
  private segs = new Float32Array(COCO_LIMBS.length * 6);
  private limbGeom = new LineSegmentsGeometry();
  private limbMat: LineMaterial;
  private limbs: LineSegments2;
  private points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private ring: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private edit = false;
  private hover = -1;
  private active = -1;
  private pts: Vec3[] = [];
  private wanted = true;

  constructor(discTex: THREE.Texture, ringTex: THREE.Texture) {
    this.limbGeom.setPositions(this.segs);
    const colors = new Float32Array(COCO_LIMBS.length * 6);
    const c = new THREE.Color();
    COCO_LIMBS.forEach((_, j) => {
      linear(limbColor(j), c);
      colors.set([c.r, c.g, c.b, c.r, c.g, c.b], j * 6);
    });
    this.limbGeom.setColors(colors);
    this.limbMat = new LineMaterial({ linewidth: PX.limb, vertexColors: true, worldUnits: false, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
    this.limbs = new LineSegments2(this.limbGeom, this.limbMat);
    this.limbs.frustumCulled = false;
    this.limbs.renderOrder = 1;

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const pc = new Float32Array(N * 3);
    OPENPOSE_COLORS.forEach((rgb, i) => {
      linear(rgb, c);
      pc.set([c.r, c.g, c.b], i * 3);
    });
    pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({
      size: PX.joint, sizeAttenuation: false, vertexColors: true, map: discTex, transparent: true, alphaTest: 0.2, depthTest: false, depthWrite: false
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;

    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.ring = new THREE.Points(rg, new THREE.PointsMaterial({
      size: PX.ring, sizeAttenuation: false, map: ringTex, transparent: true, alphaTest: 0.2, depthTest: false, depthWrite: false
    }));
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 3;
    this.ring.visible = false;

    this.group.add(this.limbs, this.points, this.ring);
  }

  /** The 18 canonical points to draw (copied). */
  update(coco18: readonly Vec3[] | null): void {
    if (!coco18) {
      this.pts = [];
      this.group.visible = false;
      return;
    }
    this.group.visible = this.wanted;
    this.pts = coco18.map((p): Vec3 => [p[0], p[1], p[2]]);
    const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.pts.forEach((p, i) => pos.setXYZ(i, p[0], p[1], p[2]));
    pos.needsUpdate = true;
    COCO_LIMBS.forEach(([a, b], j) => {
      const pa = this.pts[a];
      const pb = this.pts[b];
      this.segs.set([pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]], j * 6);
    });
    (this.limbGeom.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute).data.needsUpdate = true;
    this.updateRing();
  }

  setEditMode(on: boolean): void {
    if (on === this.edit)
      return;
    this.edit = on;
    this.points.material.size = on ? PX.jointEdit : PX.joint;
    this.limbMat.linewidth = on ? PX.limbEdit : PX.limb;
    this.limbMat.opacity = on ? 0.75 : 0.85;
    this.updateRing();
  }

  /** Hovered / dragged handle (COCO index, -1 = none); only shown in edit mode. */
  setHandles(hover: number, active: number): void {
    if (hover === this.hover && active === this.active)
      return;
    this.hover = hover;
    this.active = active;
    this.updateRing();
  }

  private updateRing(): void {
    const i = this.active >= 0 ? this.active : this.hover;
    this.ring.visible = this.edit && i >= 0 && i < this.pts.length;
    if (!this.ring.visible)
      return;
    const p = this.pts[i];
    const pos = this.ring.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, p[0], p[1], p[2]);
    pos.needsUpdate = true;
    this.ring.material.color.setHex(this.active >= 0 ? 0x4c8dff : 0xffffff);
  }

  setVisible(on: boolean): void {
    this.wanted = on;
    this.group.visible = on && this.pts.length > 0;
  }

  dispose(): void {
    this.limbGeom.dispose();
    this.limbMat.dispose();
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
