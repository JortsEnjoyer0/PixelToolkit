// Background layer (drawn before renderer.clearDepth()): the floor grid at Y = 0 and the PixelLab canvas rectangle,
// spanned by the camera basis r, u through the aligned target, carrying the frame / reference image
// (docs/skelanim/rig.md "Projection").
import * as THREE from 'three';
import type { AlignedView } from '../core/rig/projection';

const FLOOR_SIZE = 4;
const FLOOR_DIVISIONS = 20;

export class ProjectionPlane {
  /** Add to the background scene. */
  readonly group = new THREE.Group();
  private floor: THREE.GridHelper;
  private image: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private outline: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private frame = new THREE.Group();
  private showImage = true;
  private m = new THREE.Matrix4();
  private vr = new THREE.Vector3();
  private vu = new THREE.Vector3();
  private vc = new THREE.Vector3();

  constructor() {
    this.floor = new THREE.GridHelper(FLOOR_SIZE, FLOOR_DIVISIONS, 0x4a5466, 0x262c38);
    const fm = this.floor.material as THREE.LineBasicMaterial;
    fm.transparent = true;
    fm.opacity = 0.55;
    fm.depthWrite = false;
    this.floor.renderOrder = 0;

    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.image = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.image.renderOrder = 1;
    this.image.visible = false;

    const pts = [new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)];
    const lineMat = new THREE.LineBasicMaterial({ color: 0x5b6680, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false });
    this.outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    this.outline.renderOrder = 2;

    this.frame.add(this.image, this.outline);
    this.group.add(this.floor, this.frame);
  }

  /** Place the canvas rectangle: centre = aligned target, axes r / u / c, size W/ppu × H/ppu. */
  setCanvas(view: AlignedView | null): void {
    this.frame.visible = view !== null;
    if (!view)
      return;
    this.vr.set(...view.right);
    this.vu.set(...view.up);
    this.vc.set(...view.toCamera);
    this.m.makeBasis(this.vr, this.vu, this.vc);
    this.frame.quaternion.setFromRotationMatrix(this.m);
    this.frame.position.set(...view.target);
    this.frame.scale.set(2 * view.halfW, 2 * view.halfH, 1);
  }

  /** The image shown on the plane (null = none); `opacity` < 1 ghosts the reference behind a frame without its own image. */
  setTexture(tex: THREE.Texture | null, opacity = 1): void {
    const mat = this.image.material;
    if (mat.map !== tex) {
      mat.map = tex;
      mat.needsUpdate = true;
    }
    mat.opacity = opacity;
    this.image.visible = this.showImage && tex !== null;
  }

  setShowImage(on: boolean): void {
    this.showImage = on;
    this.image.visible = on && this.image.material.map !== null;
  }

  setShowFloor(on: boolean): void {
    this.floor.visible = on;
  }

  dispose(): void {
    this.floor.geometry.dispose();
    (this.floor.material as THREE.Material).dispose();
    this.image.geometry.dispose();
    this.image.material.dispose();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
  }
}
