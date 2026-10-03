// COCO-18 / OpenPose constants and the pinned ControlNet palette (docs/skelanim/rig.md "OpenPose palette"). Editor and
// thumbnails share these.
import { SKELETON_LABELS, type SkeletonLabel } from '@shared/pixellab';
import { FACE_LABELS, type FaceLabel } from '@shared/pose';

export { SKELETON_LABELS, FACE_LABELS };
export type { SkeletonLabel, FaceLabel };

export type Rgb = readonly [number, number, number];

/** Label → COCO index (0..17). */
export const LABEL_INDEX = Object.fromEntries(SKELETON_LABELS.map((l, i) => [l, i])) as Readonly<Record<SkeletonLabel, number>>;

/** Named indices for readable rig code. */
export const COCO = {
  NOSE: 0, NECK: 1,
  R_SHOULDER: 2, R_ELBOW: 3, R_WRIST: 4,
  L_SHOULDER: 5, L_ELBOW: 6, L_WRIST: 7,
  R_HIP: 8, R_KNEE: 9, R_ANKLE: 10,
  L_HIP: 11, L_KNEE: 12, L_ANKLE: 13,
  R_EYE: 14, L_EYE: 15, R_EAR: 16, L_EAR: 17
} as const;

/** The 17 drawn limbs in OpenPose render order; limb j is coloured limbColor(j). */
export const COCO_LIMBS: readonly (readonly [number, number])[] = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10],
  [1, 11], [11, 12], [12, 13], [1, 0], [0, 14], [14, 16], [0, 15], [15, 17]
];

/** controlnet_aux draw_bodypose colours (RGB): joint i uses OPENPOSE_COLORS[i]. */
export const OPENPOSE_COLORS: readonly Rgb[] = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85], [0, 255, 170],
  [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]
];

/** Limb j colour: OPENPOSE_COLORS[j] × 0.6, truncated like controlnet_aux int(c·0.6). */
export function limbColor(j: number): Rgb {
  const [r, g, b] = OPENPOSE_COLORS[j];
  return [Math.floor(r * 0.6), Math.floor(g * 0.6), Math.floor(b * 0.6)];
}

export const jointColor = (i: number): Rgb => OPENPOSE_COLORS[i];

export const rgbCss = ([r, g, b]: Rgb): string => `rgb(${r}, ${g}, ${b})`;

export const isFaceLabel = (l: SkeletonLabel): l is FaceLabel => (FACE_LABELS as readonly string[]).includes(l);

/** Left ↔ right counterpart (NOSE and NECK map to themselves). */
export const mirrorLabel = (l: SkeletonLabel): SkeletonLabel =>
  (l.startsWith('LEFT ') ? l.replace('LEFT ', 'RIGHT ') : l.startsWith('RIGHT ') ? l.replace('RIGHT ', 'LEFT ') : l) as SkeletonLabel;

/** Display name for undo labels and tooltips: 'LEFT ARM' → 'Left Wrist', 'RIGHT LEG' → 'Right Ankle'. */
export function humanLabel(l: SkeletonLabel): string {
  const words = l.replace(/ ARM$/, ' WRIST').replace(/ LEG$/, ' ANKLE').toLowerCase().split(' ');
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
