// Rig definition (docs/skelanim/rig.md "Rig"): bones, parents, rest directions, bend normals, end sites, limb chains
// and the chibi template.
// Canonical space: faces +Z, left = +X, Y up. Rest pose = T-pose with identity local rotations.
import { BONE_NAMES, END_SITE_NAMES, type BoneName, type EndSiteName, type FaceLabel, type Vec3 } from '@shared/pose';
import type { SkeletonLabel } from '@shared/pixellab';

export interface BoneDef {
  name: BoneName;
  parent: BoneName | null;
  /** Unit rest direction head → primary child head (T-pose, world = parent frame). */
  restDir: Vec3;
  /** The end site hanging off this bone, if any. */
  endSite?: EndSiteName;
  side: 'left' | 'right' | null;
}

export interface EndSiteDef { name: EndSiteName; parent: BoneName }

const L = 'left';
const R = 'right';

/** Hierarchy order (parents first); BONES[i].name === BONE_NAMES[i]. */
export const BONES: readonly BoneDef[] = [
  { name: 'Hips', parent: null, restDir: [0, 1, 0], side: null },
  { name: 'Spine', parent: 'Hips', restDir: [0, 1, 0], side: null },
  { name: 'Chest', parent: 'Spine', restDir: [0, 1, 0], side: null },
  { name: 'UpperChest', parent: 'Chest', restDir: [0, 1, 0], side: null },
  { name: 'Neck', parent: 'UpperChest', restDir: [0, 1, 0], side: null },
  { name: 'Head', parent: 'Neck', restDir: [0, 1, 0], endSite: 'HeadTop', side: null },
  { name: 'LeftShoulder', parent: 'UpperChest', restDir: [1, 0, 0], side: L },
  { name: 'LeftUpperArm', parent: 'LeftShoulder', restDir: [1, 0, 0], side: L },
  { name: 'LeftLowerArm', parent: 'LeftUpperArm', restDir: [1, 0, 0], side: L },
  { name: 'LeftHand', parent: 'LeftLowerArm', restDir: [1, 0, 0], endSite: 'LeftHandEnd', side: L },
  { name: 'RightShoulder', parent: 'UpperChest', restDir: [-1, 0, 0], side: R },
  { name: 'RightUpperArm', parent: 'RightShoulder', restDir: [-1, 0, 0], side: R },
  { name: 'RightLowerArm', parent: 'RightUpperArm', restDir: [-1, 0, 0], side: R },
  { name: 'RightHand', parent: 'RightLowerArm', restDir: [-1, 0, 0], endSite: 'RightHandEnd', side: R },
  { name: 'LeftUpperLeg', parent: 'Hips', restDir: [0, -1, 0], side: L },
  { name: 'LeftLowerLeg', parent: 'LeftUpperLeg', restDir: [0, -1, 0], side: L },
  { name: 'LeftFoot', parent: 'LeftLowerLeg', restDir: [0, -0.496139, 0.868243], side: L },
  { name: 'LeftToes', parent: 'LeftFoot', restDir: [0, 0, 1], endSite: 'LeftToesEnd', side: L },
  { name: 'RightUpperLeg', parent: 'Hips', restDir: [0, -1, 0], side: R },
  { name: 'RightLowerLeg', parent: 'RightUpperLeg', restDir: [0, -1, 0], side: R },
  { name: 'RightFoot', parent: 'RightLowerLeg', restDir: [0, -0.496139, 0.868243], side: R },
  { name: 'RightToes', parent: 'RightFoot', restDir: [0, 0, 1], endSite: 'RightToesEnd', side: R }
];

export const BONE_INDEX = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i])) as Readonly<Record<BoneName, number>>;

/** Parent index per bone (-1 for Hips), BONES order. */
export const PARENT_INDEX: readonly number[] = BONES.map((b) => b.parent ? BONE_INDEX[b.parent] : -1);

/** End-site order; FkResult.endPos follows it. */
export const END_SITES: readonly EndSiteDef[] = [
  { name: 'HeadTop', parent: 'Head' },
  { name: 'LeftHandEnd', parent: 'LeftHand' },
  { name: 'RightHandEnd', parent: 'RightHand' },
  { name: 'LeftToesEnd', parent: 'LeftToes' },
  { name: 'RightToesEnd', parent: 'RightToes' }
];

export const END_SITE_INDEX = Object.fromEntries(END_SITE_NAMES.map((n, i) => [n, i])) as Readonly<Record<EndSiteName, number>>;

export type LimbName = 'LeftArm' | 'RightArm' | 'LeftLeg' | 'RightLeg';

/** Two-bone chains for calibration and (future) IK. `ref` = the frame the straight-limb fallback normal lives in. */
export interface LimbChain { name: LimbName; upper: BoneName; lower: BoneName; end: BoneName; ref: BoneName; d0: Vec3; n0: Vec3 }

export const LIMB_CHAINS: readonly LimbChain[] = [
  { name: 'LeftArm', upper: 'LeftUpperArm', lower: 'LeftLowerArm', end: 'LeftHand', ref: 'UpperChest', d0: [1, 0, 0], n0: [0, -1, 0] },
  { name: 'RightArm', upper: 'RightUpperArm', lower: 'RightLowerArm', end: 'RightHand', ref: 'UpperChest', d0: [-1, 0, 0], n0: [0, 1, 0] },
  { name: 'LeftLeg', upper: 'LeftUpperLeg', lower: 'LeftLowerLeg', end: 'LeftFoot', ref: 'Hips', d0: [0, -1, 0], n0: [1, 0, 0] },
  { name: 'RightLeg', upper: 'RightUpperLeg', lower: 'RightLowerLeg', end: 'RightFoot', ref: 'Hips', d0: [0, -1, 0], n0: [1, 0, 0] }
];

/** Template head height h (chin to crown); face offsets below are h × the chibi table. */
const H = 0.31;
const HALF_SHOULDER = 0.16;
const NECK_LEN = 0.04;

export interface RigTemplate {
  /** Rest Hips world position (character standing on Y = 0). */
  root: Vec3;
  /** Ankle (Foot head) height above the floor in rest. */
  ankleHeight: number;
  /** Torso length |NECK − hip centre| (Neck head above Hips). */
  torso: number;
  /** Head height h (chin to crown). */
  headHeight: number;
  offsets: Readonly<Record<BoneName | EndSiteName, Vec3>>;
  /** Head-local face offsets (+X left, +Y up, +Z forward), template-aligned frame. */
  face: Readonly<Record<FaceLabel, Vec3>>;
}

/**
 * Chibi pixel template, exactly 1.0 tall: HeadTop y = 1, toes on the floor (Toes offset y = −ankleHeight). Offsets =
 * head offset from the parent head in the parent's rest frame. Clavicle heads sit at (±0.2·halfShoulder, neckLen, 0)
 * above UpperChest so rest COCO NECK (UpperArm midpoint) = Neck head.
 */
export const TEMPLATE: Readonly<RigTemplate> = {
  root: [0, 0.35, 0],
  ankleHeight: 0.04,
  torso: 0.32,
  headHeight: H,
  offsets: {
    Hips: [0, 0, 0],
    Spine: [0, 0.08, 0],
    Chest: [0, 0.10, 0],
    UpperChest: [0, 0.10, 0],
    Neck: [0, NECK_LEN, 0],
    Head: [0, 0.03, 0],
    HeadTop: [0, 0.30, 0],
    LeftShoulder: [0.2 * HALF_SHOULDER, NECK_LEN, 0],
    LeftUpperArm: [0.8 * HALF_SHOULDER, 0, 0],
    LeftLowerArm: [0.15, 0, 0],
    LeftHand: [0.15, 0, 0],
    LeftHandEnd: [0.06, 0, 0],
    RightShoulder: [-0.2 * HALF_SHOULDER, NECK_LEN, 0],
    RightUpperArm: [-0.8 * HALF_SHOULDER, 0, 0],
    RightLowerArm: [-0.15, 0, 0],
    RightHand: [-0.15, 0, 0],
    RightHandEnd: [-0.06, 0, 0],
    LeftUpperLeg: [0.08, 0, 0],
    LeftLowerLeg: [0, -0.18, 0],
    LeftFoot: [0, -0.13, 0],
    LeftToes: [0, -0.04, 0.07],
    LeftToesEnd: [0, 0, 0.04],
    RightUpperLeg: [-0.08, 0, 0],
    RightLowerLeg: [0, -0.18, 0],
    RightFoot: [0, -0.13, 0],
    RightToes: [0, -0.04, 0.07],
    RightToesEnd: [0, 0, 0.04]
  },
  face: {
    NOSE: [0, 0.15 * H, 0.50 * H],
    'RIGHT EYE': [-0.19 * H, 0.28 * H, 0.42 * H],
    'LEFT EYE': [0.19 * H, 0.28 * H, 0.42 * H],
    'RIGHT EAR': [-0.45 * H, 0.30 * H, 0],
    'LEFT EAR': [0.45 * H, 0.30 * H, 0]
  }
};

/** UI names for undo labels and tooltips ("Rotate Left Forearm"). */
export const HUMAN_NAMES: Readonly<Record<BoneName, string>> = {
  Hips: 'Hips',
  Spine: 'Spine',
  Chest: 'Chest',
  UpperChest: 'Upper Chest',
  Neck: 'Neck',
  Head: 'Head',
  LeftShoulder: 'Left Clavicle',
  LeftUpperArm: 'Left Upper Arm',
  LeftLowerArm: 'Left Forearm',
  LeftHand: 'Left Hand',
  RightShoulder: 'Right Clavicle',
  RightUpperArm: 'Right Upper Arm',
  RightLowerArm: 'Right Forearm',
  RightHand: 'Right Hand',
  LeftUpperLeg: 'Left Thigh',
  LeftLowerLeg: 'Left Shin',
  LeftFoot: 'Left Foot',
  LeftToes: 'Left Toes',
  RightUpperLeg: 'Right Thigh',
  RightLowerLeg: 'Right Shin',
  RightFoot: 'Right Foot',
  RightToes: 'Right Toes'
};

/** Where each COCO point comes from in cocoFromFk (docs/skelanim/rig.md "COCO-18 mapping"). */
export type CocoSource = { kind: 'bone'; bone: BoneName } | { kind: 'neck' } | { kind: 'face' };

export const JOINT_FOR_COCO: Readonly<Record<SkeletonLabel, CocoSource>> = {
  NOSE: { kind: 'face' },
  NECK: { kind: 'neck' }, // midpoint of the two UpperArm heads; derived, never draggable
  'RIGHT SHOULDER': { kind: 'bone', bone: 'RightUpperArm' },
  'RIGHT ELBOW': { kind: 'bone', bone: 'RightLowerArm' },
  'RIGHT ARM': { kind: 'bone', bone: 'RightHand' },
  'LEFT SHOULDER': { kind: 'bone', bone: 'LeftUpperArm' },
  'LEFT ELBOW': { kind: 'bone', bone: 'LeftLowerArm' },
  'LEFT ARM': { kind: 'bone', bone: 'LeftHand' },
  'RIGHT HIP': { kind: 'bone', bone: 'RightUpperLeg' },
  'RIGHT KNEE': { kind: 'bone', bone: 'RightLowerLeg' },
  'RIGHT LEG': { kind: 'bone', bone: 'RightFoot' },
  'LEFT HIP': { kind: 'bone', bone: 'LeftUpperLeg' },
  'LEFT KNEE': { kind: 'bone', bone: 'LeftLowerLeg' },
  'LEFT LEG': { kind: 'bone', bone: 'LeftFoot' },
  'RIGHT EYE': { kind: 'face' },
  'LEFT EYE': { kind: 'face' },
  'RIGHT EAR': { kind: 'face' },
  'LEFT EAR': { kind: 'face' }
};

/** Left ↔ right counterpart bone (centre bones map to themselves). */
export const mirrorBone = (b: BoneName): BoneName =>
  (b.startsWith('Left') ? 'Right' + b.slice(4) : b.startsWith('Right') ? 'Left' + b.slice(5) : b) as BoneName;

export const mirrorEndSite = (e: EndSiteName): EndSiteName =>
  (e.startsWith('Left') ? 'Right' + e.slice(4) : e.startsWith('Right') ? 'Left' + e.slice(5) : e) as EndSiteName;
