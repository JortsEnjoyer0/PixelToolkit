// Forward kinematics (PLAN §4.2) and the rig → COCO-18 mapping (PLAN §4.3).
// Both run per frame per thumbnail: pass `out` buffers (createFkResult / createCoco) and they allocate nothing.
import { BONE_NAMES, FACE_LABELS, type Pose, type Quat, type Vec3 } from '@shared/pose';
import { SKELETON_LABELS } from '@shared/pixellab';
import type { RigCalibration } from '../model';
import { LABEL_INDEX } from './coco';
import { qMul, qRotate } from './math';
import { BONE_INDEX, BONES, END_SITES, JOINT_FOR_COCO, PARENT_INDEX } from './rigDef';

export interface FkResult {
  /** World head position per bone, BONES order. */
  pos: Vec3[];
  /** World rotation qW per bone, BONES order. */
  rotW: Quat[];
  /** World position per end site, END_SITES order. */
  endPos: Vec3[];
}

export function createFkResult(): FkResult {
  return {
    pos: BONES.map((): Vec3 => [0, 0, 0]),
    rotW: BONES.map((): Quat => [0, 0, 0, 1]),
    endPos: END_SITES.map((): Vec3 => [0, 0, 0])
  };
}

/** 18 zeroed points, a reusable `out` for cocoFromFk. */
export const createCoco = (): Vec3[] => SKELETON_LABELS.map((): Vec3 => [0, 0, 0]);

const BONE_COUNT = BONES.length;
const END_PARENT = END_SITES.map((e) => BONE_INDEX[e.parent]);
const END_NAMES = END_SITES.map((e) => e.name);
const HEAD = BONE_INDEX.Head;
const L_UPPER_ARM = BONE_INDEX.LeftUpperArm;
const R_UPPER_ARM = BONE_INDEX.RightUpperArm;
/** Per COCO index: the bone whose head it is, -1 for NECK, -2 for the face points. */
const COCO_SOURCE: readonly number[] = SKELETON_LABELS.map((label) => {
  const src = JOINT_FOR_COCO[label];
  return src.kind === 'bone' ? BONE_INDEX[src.bone] : src.kind === 'neck' ? -1 : -2;
});
const FACE_INDEX = FACE_LABELS.map((k) => LABEL_INDEX[k]);

/**
 * p(child) = p(parent) + qW(parent)·offset(child); qW(child) = qW(parent)·qL(child); root = Pose.root with qL(Hips).
 * Pass `out` (from createFkResult) to avoid allocation in per-frame loops. Never mutates pose or calib.
 */
export function fk(pose: Readonly<Pose>, calib: RigCalibration, out: FkResult = createFkResult()): FkResult {
  const rot = pose.rot;
  const offsets = calib.offsets;
  const pos = out.pos;
  const rotW = out.rotW;
  for (let i = 0; i < BONE_COUNT; i++) {
    const name = BONE_NAMES[i];
    const p = PARENT_INDEX[i];
    const q = rot[name];
    if (p < 0) {
      const o = pos[i];
      o[0] = pose.root[0];
      o[1] = pose.root[1];
      o[2] = pose.root[2];
      const r = rotW[i];
      r[0] = q[0];
      r[1] = q[1];
      r[2] = q[2];
      r[3] = q[3];
      continue;
    }
    const o = qRotate(rotW[p], offsets[name], pos[i]);
    const pp = pos[p];
    o[0] += pp[0];
    o[1] += pp[1];
    o[2] += pp[2];
    qMul(rotW[p], q, rotW[i]);
  }
  for (let e = 0; e < END_PARENT.length; e++) {
    const p = END_PARENT[e];
    const o = qRotate(rotW[p], offsets[END_NAMES[e]], out.endPos[e]);
    const pp = pos[p];
    o[0] += pp[0];
    o[1] += pp[1];
    o[2] += pp[2];
  }
  return out;
}

/**
 * The 18 COCO points (canonical order) of an FK result. NECK = midpoint of the UpperArm heads; face = Head + qW(Head)·face[k].
 * Pass `out` (from createCoco) to reuse the 18 tuples.
 */
export function cocoFromFk(fkr: FkResult, calib: RigCalibration, out: Vec3[] = createCoco()): Vec3[] {
  const pos = fkr.pos;
  for (let i = 0; i < COCO_SOURCE.length; i++) {
    const src = COCO_SOURCE[i];
    const o = out[i];
    if (src >= 0) {
      const p = pos[src];
      o[0] = p[0];
      o[1] = p[1];
      o[2] = p[2];
    } else if (src === -1) {
      const a = pos[L_UPPER_ARM];
      const b = pos[R_UPPER_ARM];
      o[0] = (a[0] + b[0]) * 0.5;
      o[1] = (a[1] + b[1]) * 0.5;
      o[2] = (a[2] + b[2]) * 0.5;
    }
  }
  const hp = pos[HEAD];
  const hq = fkr.rotW[HEAD];
  for (let f = 0; f < FACE_INDEX.length; f++) {
    const o = qRotate(hq, calib.face[FACE_LABELS[f]], out[FACE_INDEX[f]]);
    o[0] += hp[0];
    o[1] += hp[1];
    o[2] += hp[2];
  }
  return out;
}

/** Convenience: cocoFromFk(fk(pose, calib), calib). Allocates; use fk + cocoFromFk with buffers in hot loops. */
export const cocoFromPose = (pose: Readonly<Pose>, calib: RigCalibration): Vec3[] => cocoFromFk(fk(pose, calib), calib);

/** World rotations qW only (they do not depend on the calibration), BONES order. */
export function worldRotations(pose: Readonly<Pose>, out: Quat[] = BONES.map((): Quat => [0, 0, 0, 1])): Quat[] {
  for (let i = 0; i < BONE_COUNT; i++) {
    const q = pose.rot[BONE_NAMES[i]];
    const p = PARENT_INDEX[i];
    if (p < 0) {
      const r = out[i];
      r[0] = q[0];
      r[1] = q[1];
      r[2] = q[2];
      r[3] = q[3];
    } else
      qMul(out[p], q, out[i]);
  }
  return out;
}
