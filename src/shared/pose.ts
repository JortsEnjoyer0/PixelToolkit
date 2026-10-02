// Rig pose types shared by main (job snapshots) and the renderer (core/model.ts re-exports them).
import type { SkeletonLabel } from './pixellab';

export type Vec3 = [number, number, number];
/** Unit quaternion, x, y, z, w (three.js order). */
export type Quat = [number, number, number, number];

/**
 * The 22 rig bones (Unity HumanBodyBones subset) in hierarchy order: every parent precedes its children.
 * core/rig/rigDef.ts BONES[i].name === BONE_NAMES[i].
 */
export const BONE_NAMES = [
  'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'
] as const;
export type BoneName = typeof BONE_NAMES[number];

/** Bone-less tips: they only carry an offset (from their parent bone's head). */
export const END_SITE_NAMES = ['HeadTop', 'LeftHandEnd', 'RightHandEnd', 'LeftToesEnd', 'RightToesEnd'] as const;
export type EndSiteName = typeof END_SITE_NAMES[number];

/** COCO face points: rigid offsets from the Head bone (canonical COCO order). */
export const FACE_LABELS = ['NOSE', 'RIGHT EYE', 'LEFT EYE', 'RIGHT EAR', 'LEFT EAR'] as const satisfies readonly SkeletonLabel[];
export type FaceLabel = typeof FACE_LABELS[number];

/**
 * A rig pose in canonical character space (faces +Z, left = +X, Y up, floor Y = 0).
 * `root` is the Hips world position; `rot` holds LOCAL rotations (rest T-pose = identity everywhere).
 */
export interface Pose { root: Vec3; rot: Record<BoneName, Quat> }
