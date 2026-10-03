// Screen-space picking: the skeleton is drawn on top of everything and joints are only a few
// pixels apart on small sprites, so picks compare projected positions in CSS px instead of raycasting.
import * as THREE from 'three';
import type { FkResult } from '../core/rig/fk';
import { BONE_INDEX, BONES, END_SITES } from '../core/rig/rigDef';
import { tailPosition } from './RigMeshes';

/** Joint hit radius and bone (segment) hit distance, CSS px. */
export const JOINT_PICK_PX = 8;
export const BONE_PICK_PX = 6;
/** Candidates whose screen distance is within this of the best are ranked by nearness to the camera instead. */
const TIE_PX = 1.5;

export interface ScreenPoint {
  /** CSS px from the viewport's top-left. */
  x: number;
  y: number;
  /** NDC z: smaller = nearer the camera (monotonic for both camera types). */
  z: number;
  /** Inside the near / far range. */
  inFront: boolean;
}

export interface RigHit {
  /** Selected bone index (BONES order). */
  bone: number;
  /** What was under the pointer: a bone head, an end site (selects its parent) or a bone segment. */
  kind: 'joint' | 'end' | 'segment';
  /** Screen distance, CSS px. */
  dist: number;
}

interface Candidate { index: number; d: number; z: number }

function best(cands: Candidate[]): Candidate | null {
  if (cands.length === 0)
    return null;
  const dMin = Math.min(...cands.map((c) => c.d));
  let out: Candidate | null = null;
  for (const c of cands) {
    if (c.d <= dMin + TIE_PX && (!out || c.z < out.z))
      out = c;
  }
  return out;
}

export class Picker {
  private v = new THREE.Vector3();

  project(p: readonly number[], camera: THREE.Camera, size: { w: number; h: number }, out: ScreenPoint = { x: 0, y: 0, z: 0, inFront: false }): ScreenPoint {
    this.v.set(p[0], p[1], p[2]).project(camera);
    out.x = ((this.v.x + 1) / 2) * size.w;
    out.y = ((1 - this.v.y) / 2) * size.h;
    out.z = this.v.z;
    out.inFront = this.v.z >= -1 && this.v.z <= 1;
    return out;
  }

  /** Nearest joint within JOINT_PICK_PX (bone heads and end sites), else the nearest bone segment within BONE_PICK_PX. */
  pickRig(fkr: FkResult, camera: THREE.Camera, size: { w: number; h: number }, x: number, y: number): RigHit | null {
    camera.updateMatrixWorld();
    const sp: ScreenPoint = { x: 0, y: 0, z: 0, inFront: false };
    const joints: Candidate[] = [];
    const heads: ScreenPoint[] = [];
    for (let i = 0; i < BONES.length; i++) {
      const s = this.project(fkr.pos[i], camera, size);
      heads.push(s);
      const d = Math.hypot(s.x - x, s.y - y);
      if (s.inFront && d <= JOINT_PICK_PX)
        joints.push({ index: i, d, z: s.z });
    }
    END_SITES.forEach((_, k) => {
      this.project(fkr.endPos[k], camera, size, sp);
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (sp.inFront && d <= JOINT_PICK_PX)
        joints.push({ index: BONES.length + k, d, z: sp.z });
    });
    const j = best(joints);
    if (j) {
      const isEnd = j.index >= BONES.length;
      return { bone: isEnd ? BONE_INDEX[END_SITES[j.index - BONES.length].parent] : j.index, kind: isEnd ? 'end' : 'joint', dist: j.d };
    }
    const segs: Candidate[] = [];
    for (let i = 0; i < BONES.length; i++) {
      const a = heads[i];
      const b = this.project(tailPosition(fkr, i), camera, size, sp);
      if (!a.inFront || !b.inFront)
        continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      if (l2 < 1)
        continue;
      const t = THREE.MathUtils.clamp(((x - a.x) * dx + (y - a.y) * dy) / l2, 0, 1);
      const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
      if (d <= BONE_PICK_PX)
        segs.push({ index: i, d, z: a.z + (b.z - a.z) * t });
    }
    const s = best(segs);
    return s ? { bone: s.index, kind: 'segment', dist: s.d } : null;
  }

  /** Nearest allowed point within JOINT_PICK_PX (COCO edit handles); -1 when none. */
  pickPoints(points: readonly (readonly number[])[], allowed: (i: number) => boolean, camera: THREE.Camera, size: { w: number; h: number }, x: number, y: number): number {
    camera.updateMatrixWorld();
    const sp: ScreenPoint = { x: 0, y: 0, z: 0, inFront: false };
    const cands: Candidate[] = [];
    points.forEach((p, i) => {
      if (!allowed(i))
        return;
      this.project(p, camera, size, sp);
      const d = Math.hypot(sp.x - x, sp.y - y);
      if (sp.inFront && d <= JOINT_PICK_PX)
        cands.push({ index: i, d, z: sp.z });
    });
    return best(cands)?.index ?? -1;
  }
}
