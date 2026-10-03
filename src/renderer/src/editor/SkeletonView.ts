// The active skeleton: one RigMeshes (octahedral bones, joints, end sites, outline hulls, relationship links) with
// selection / hover emphasis, the COCO-edit dimmed style and an anchor glyph at Hips. Re-laid out every render from the
// FK result the viewport mutates in place. Lighting is RigLights (owned by the viewport, shared with the ghosts).
import * as THREE from 'three';
import type { RigCalibration } from '../core/model';
import type { FkResult } from '../core/rig/fk';
import { RIG_OPACITY, RigMeshes, type RigGeometries, type ScreenScale } from './RigMeshes';

/** Highlight colours (sRGB); the base colours are RIG_COLOR. */
const COLOR = { hover: 0xc4d0e3, selected: 0x4c8dff, selectedHover: 0x7aaaff, anchor: 0xd7dfeb };

/** Screen sizes, CSS px. */
const PX = { emphasis: 1.4, anchor: 17, anchorOffset: 13 };

export class SkeletonView {
  /** Add to the overlay scene (drawn after clearDepth, so always over the image). */
  readonly group = new THREE.Group();
  private rig: RigMeshes;
  private anchor: THREE.Sprite;
  private fkr: FkResult | null = null;
  private calib: RigCalibration | null = null;
  private shown = true;
  private selected = -1;
  private hover = -1;
  private dimmed = false;

  private p = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();

  constructor(anchorTex: THREE.Texture, geo: RigGeometries) {
    this.rig = new RigMeshes(geo);
    this.anchor = new THREE.Sprite(new THREE.SpriteMaterial({ map: anchorTex, color: COLOR.anchor, depthTest: false, depthWrite: false, transparent: true }));
    this.anchor.renderOrder = 5;
    this.group.add(...this.rig.meshes, this.rig.links, this.anchor);
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

  private colorFor = (bone: number, base: number): number => {
    const sel = bone === this.selected;
    const hov = bone === this.hover;
    if (sel)
      return hov ? COLOR.selectedHover : COLOR.selected;
    return hov ? COLOR.hover : base;
  };

  private emphasis = (bone: number): number => bone === this.selected || bone === this.hover ? PX.emphasis : 1;

  private applyStyle(): void {
    const r = this.rig;
    r.paint(this.colorFor);
    const opacity = this.dimmed ? 0.28 : 1;
    r.bones.material.opacity = opacity;
    r.joints.material.opacity = opacity;
    r.boneHull.material.opacity = this.dimmed ? 0.15 : RIG_OPACITY.hull;
    r.jointHull.material.opacity = this.dimmed ? 0.15 : RIG_OPACITY.hull;
    r.boneHull.visible = !this.dimmed;
    r.jointHull.visible = !this.dimmed;
    r.links.material.opacity = this.dimmed ? 0.25 : RIG_OPACITY.link;
    const am = this.anchor.material;
    am.opacity = opacity;
    am.color.setHex(this.selected === 0 ? COLOR.selected : COLOR.anchor);
  }

  /** Re-lay out every instance for the current camera (call once per rendered frame; skipped while hidden). */
  layout(camera: THREE.Camera, scale: ScreenScale): void {
    const fkr = this.fkr;
    const calib = this.calib;
    if (!fkr || !calib || !this.group.visible)
      return;
    this.rig.layout(fkr, calib, scale, this.emphasis);

    // Anchor glyph: beside the Hips joint, offset down-right in screen space
    const hips = fkr.pos[0];
    this.p.set(hips[0], hips[1], hips[2]);
    const wpp = scale.worldPerPixel(this.p);
    const right = this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    this.anchor.position.copy(this.p).addScaledVector(right, PX.anchorOffset * wpp).addScaledVector(up, -PX.anchorOffset * wpp);
    this.anchor.scale.setScalar(PX.anchor * wpp);
  }

  dispose(): void {
    this.rig.dispose();
    this.anchor.material.dispose();
  }
}
