// Left ↔ right mirroring across the X = 0 plane (tests and future use; PLAN §4 / critique item 21).
// Positions p → (−x, y, z); rotations q → (x, −y, −z, w); Left* ↔ Right* bones and face labels swap.
// scripts/verify-rig.ts checks it (npm run test:rig).
import { BONE_NAMES, END_SITE_NAMES, FACE_LABELS, type BoneName, type FaceLabel, type Pose, type Quat, type Vec3 } from '@shared/pose';
import type { RigCalibration } from '../model';
import { LABEL_INDEX, SKELETON_LABELS, mirrorLabel } from './coco';
import { mirrorBone, mirrorEndSite } from './rigDef';

const mirrorVec = (v: Readonly<Vec3>): Vec3 => [-v[0], v[1], v[2]];
const mirrorQuat = (q: Readonly<Quat>): Quat => [q[0], -q[1], -q[2], q[3]];

export function mirrorPose(pose: Readonly<Pose>): Pose {
  const rot = {} as Record<BoneName, Quat>;
  for (const b of BONE_NAMES)
    rot[mirrorBone(b)] = mirrorQuat(pose.rot[b]);
  return { root: mirrorVec(pose.root), rot };
}

export function mirrorCalibration(calib: RigCalibration): RigCalibration {
  const offsets = {} as RigCalibration['offsets'];
  for (const b of BONE_NAMES)
    offsets[mirrorBone(b)] = mirrorVec(calib.offsets[b]);
  for (const e of END_SITE_NAMES)
    offsets[mirrorEndSite(e)] = mirrorVec(calib.offsets[e]);
  const face = {} as Record<FaceLabel, Vec3>;
  for (const k of FACE_LABELS)
    face[mirrorLabel(k) as FaceLabel] = mirrorVec(calib.face[k]);
  return { offsets, face, height: calib.height };
}

/** Mirror 18 canonical COCO points: negate x and swap the LEFT/RIGHT entries. */
export function mirrorCoco(coco18: readonly Vec3[]): Vec3[] {
  return SKELETON_LABELS.map((l) => mirrorVec(coco18[LABEL_INDEX[mirrorLabel(l)]]));
}
