// Stock poses and the template calibration.
import { BONE_NAMES, END_SITE_NAMES, FACE_LABELS, type BoneName, type Pose, type Quat, type Vec3 } from '@shared/pose';
import type { RigCalibration } from '../model';
import { DEG, qFromAxisAngle } from './math';
import { TEMPLATE } from './rigDef';

const identityRot = (): Record<BoneName, Quat> => Object.fromEntries(BONE_NAMES.map((b) => [b, [0, 0, 0, 1]])) as Record<BoneName, Quat>;

const LEG_CHAINS = [['LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'LeftToesEnd'], ['RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes', 'RightToesEnd']] as const;
const HEAD_CHAIN = ['Spine', 'Chest', 'UpperChest', 'Neck', 'Head', 'HeadTop'] as const;

/** Rest-pose y of the lowest foot point (Foot, Toes or ToesEnd head) relative to the Hips head. */
function lowestFootY(calib: RigCalibration): number {
  let min = 0;
  for (const chain of LEG_CHAINS) {
    let y = 0;
    for (const k of chain) {
      y += calib.offsets[k][1];
      if (k !== chain[0] && k !== chain[1])
        min = Math.min(min, y);
    }
  }
  return min;
}

/** Hips height that puts the lowest rest foot point on the floor (Y = 0). */
export const restRootHeight = (calib: RigCalibration): number => -lowestFootY(calib);

/** H_char: rest HeadTop.y minus the lowest foot/toe y (docs/skelanim/rig.md "Rig"). */
export function calibrationHeight(calib: RigCalibration): number {
  let top = 0;
  for (const k of HEAD_CHAIN)
    top += calib.offsets[k][1];
  return top - lowestFootY(calib);
}

/** Fresh deep copy of the chibi template proportions (H_char = 1). */
export function templateCalibration(): RigCalibration {
  const calib: RigCalibration = {
    offsets: Object.fromEntries([...BONE_NAMES, ...END_SITE_NAMES].map((k) => [k, [...TEMPLATE.offsets[k]] as Vec3])) as RigCalibration['offsets'],
    face: Object.fromEntries(FACE_LABELS.map((k) => [k, [...TEMPLATE.face[k]] as Vec3])) as RigCalibration['face'],
    height: 0
  };
  calib.height = calibrationHeight(calib);
  return calib;
}

/** T-pose (identity local rotations) standing on the floor. */
export function restPose(calib?: RigCalibration): Pose {
  return { root: [0, calib ? restRootHeight(calib) : TEMPLATE.root[1], 0], rot: identityRot() };
}

const ARM_DOWN = 80 * DEG;
const ELBOW_BEND = 15 * DEG;

/** Standing idle: arms hanging ~10° out from the body with a slight forward elbow bend, legs straight. */
export function idlePose(calib?: RigCalibration): Pose {
  const pose = restPose(calib);
  pose.rot.LeftUpperArm = qFromAxisAngle([0, 0, 1], -ARM_DOWN);
  pose.rot.RightUpperArm = qFromAxisAngle([0, 0, 1], ARM_DOWN);
  // Flexion is about n0 (left (0,-1,0), right (0,1,0)) and swings the forearm toward +Z
  pose.rot.LeftLowerArm = qFromAxisAngle([0, -1, 0], ELBOW_BEND);
  pose.rot.RightLowerArm = qFromAxisAngle([0, 1, 0], ELBOW_BEND);
  return pose;
}

export function clonePose(p: Readonly<Pose>): Pose {
  return {
    root: [p.root[0], p.root[1], p.root[2]],
    rot: Object.fromEntries(BONE_NAMES.map((b) => [b, [...p.rot[b]] as Quat])) as Record<BoneName, Quat>
  };
}
