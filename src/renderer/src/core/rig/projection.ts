// Orthographic PixelLab projection (PLAN §4.5): camera basis, world ↔ canvas, keypoints, aligned editor view.
import { DIRECTIONS, SKELETON_LABELS, type Direction, type Keypoint } from '@shared/pixellab';
import type { Pose, Vec3 } from '@shared/pose';
import type { Projection, ReferenceData, RigCalibration, UndoableState } from '../model';
import { COCO, isFaceLabel } from './coco';
import { cocoFromFk, createCoco, createFkResult, fk, type FkResult } from './fk';
import { DEG, addScaled, clamp, dot, mid, qRotate, scale, sub } from './math';
import { BONE_INDEX } from './rigDef';

/** Yaw θ in degrees: south 0, south-east 45, east 90, … south-west 315 (DIRECTIONS is in yaw order). */
export const DIRECTION_YAW: Readonly<Record<Direction, number>> = Object.fromEntries(DIRECTIONS.map((d, i) => [d, i * 45])) as Record<Direction, number>;

/** Orthonormal camera frame; r × u = c. The camera sits above the subject looking down by φ. */
export interface CameraBasis {
  /** Screen right. */
  r: Vec3;
  /** Screen up. */
  u: Vec3;
  /** Unit vector toward the camera (camera depth d_c = P·c, used only for lifting). */
  c: Vec3;
  /** Horizontal toward-camera (d_h for z_index and depth). */
  ch: Vec3;
  thetaDeg: number;
  pitchDeg: number;
}

/** Closed forms verified for all 8 directions × 3 pitches. */
export function cameraBasis(direction: Direction, pitchDeg: number): CameraBasis {
  const thetaDeg = DIRECTION_YAW[direction];
  const t = thetaDeg * DEG;
  const p = pitchDeg * DEG;
  const st = Math.sin(t);
  const ct = Math.cos(t);
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  return {
    r: [ct, 0, st],
    u: [st * sp, cp, -ct * sp],
    c: [-st * cp, sp, ct * cp],
    ch: [-st, 0, ct],
    thetaDeg,
    pitchDeg
  };
}

/** World point → canvas px (y down). */
export function toCanvas(P: Readonly<Vec3>, basis: CameraBasis, projection: Projection): [number, number] {
  return [projection.anchorPx[0] + projection.ppu * dot(P, basis.r), projection.anchorPx[1] - projection.ppu * dot(P, basis.u)];
}

/** Canvas px plus camera depth d_c → world point (exact inverse of toCanvas for that depth). */
export function fromCanvas(px: number, py: number, dc: number, basis: CameraBasis, projection: Projection, out: Vec3 = [0, 0, 0]): Vec3 {
  const sx = (px - projection.anchorPx[0]) / projection.ppu;
  const sy = (projection.anchorPx[1] - py) / projection.ppu;
  scale(basis.r, sx, out);
  addScaled(out, basis.u, sy, out);
  return addScaled(out, basis.c, dc, out);
}

/** Anchor after translating the whole world by T, so every point keeps its canvas position: a' = a − ppu·(T·r, −T·u). */
export function translateAnchor(projection: Projection, T: Readonly<Vec3>, basis: CameraBasis): Projection {
  return {
    ppu: projection.ppu,
    anchorPx: [projection.anchorPx[0] - projection.ppu * dot(T, basis.r), projection.anchorPx[1] + projection.ppu * dot(T, basis.u)]
  };
}

/** Framing used before an estimate exists: the character ~80% of the canvas height, centred, floor near the bottom. */
export function defaultProjection(canvas: { width: number; height: number }, Hchar: number): Projection {
  return { ppu: (0.8 * canvas.height) / (Hchar > 0 ? Hchar : 1), anchorPx: [canvas.width / 2, canvas.height * 0.9] };
}

export interface AlignedView {
  /** World point at the canvas centre (the camera target). */
  target: Vec3;
  right: Vec3;
  up: Vec3;
  /** Camera position = target + k·toCamera; camera.up = +Y. */
  toCamera: Vec3;
  /** Ortho half extents at zoom 1 (world units): ±W/(2·ppu), ±H/(2·ppu). The image plane is spanned by right/up through target. */
  halfW: number;
  halfH: number;
}

/** The editor camera that reproduces the PixelLab canvas exactly. */
export function alignedView(canvas: { width: number; height: number }, projection: Projection, basis: CameraBasis): AlignedView {
  const { ppu, anchorPx } = projection;
  const target = scale(basis.r, (canvas.width / 2 - anchorPx[0]) / ppu);
  addScaled(target, basis.u, (anchorPx[1] - canvas.height / 2) / ppu, target);
  return {
    target,
    right: [...basis.r],
    up: [...basis.u],
    toCamera: [...basis.c],
    halfW: canvas.width / (2 * ppu),
    halfH: canvas.height / (2 * ppu)
  };
}

export interface ProjectContext {
  basis: CameraBasis;
  projection: Projection;
  canvas: { width: number; height: number };
  /** This frame's hip centre: d_h = (P − hipC)·c_h. */
  hipC: Vec3;
  /** qW(Head)·(0,0,1); face priorities flip when it points away from the camera. */
  headForward?: Vec3;
  /** Calibrated character height; ε = 0.02·Hchar and the depth scale. */
  Hchar: number;
  sendDepth: boolean;
  /** Ranks (z_index) of the previous frame in this submission, for hysteresis. */
  prevRanks?: number[];
}

export interface ProjectResult {
  /** 18 keypoints in canonical order, x/y clamped to [0, 1]. */
  keypoints: Keypoint[];
  /** z_index per joint (canonical order): a unique rank 0..17, nearest = 17. Feed to the next frame's prevRanks. */
  ranks: number[];
  /** Some joint fell outside the canvas and was clamped (warn the user). */
  clamped: boolean;
  /** COCO indices of the clamped joints (empty when nothing was clamped). */
  clampedJoints: number[];
}

const clamp01 = (v: number): number => clamp(v, 0, 1);

const JOINTS = SKELETON_LABELS.length;
const MAX_RANK = JOINTS - 1;

/**
 * z_index priority (high first, PLAN §4.5): NOSE 4, EYES 3, wrists = elbows = knees 2, EARS 1, the rest 0.
 * Breaks near-ties in favour of the joints whose occlusion matters most.
 */
export const Z_PRIORITY: readonly number[] = SKELETON_LABELS.map((l) => {
  if (l === 'NOSE')
    return 4;
  if (l.endsWith(' EYE'))
    return 3;
  if (l.endsWith(' ARM') || l.endsWith(' ELBOW') || l.endsWith(' KNEE'))
    return 2;
  return l.endsWith(' EAR') ? 1 : 0;
});
const PRIO_MAX = 4;
const IS_FACE: readonly boolean[] = SKELETON_LABELS.map((l) => isFaceLabel(l));

/**
 * 18 canonical COCO points (world) → PixelLab keypoints (PLAN §4.5). z_index is a unique rank (nearest = 17) from
 * one scalar key per joint, k_j = d_h + ε·(0.5·prio_j/prioMax + 0.5·prevRank_j/17) with ε = 0.02·H_char, label index
 * as the final tie-break, so the order is a strict total order. Face priorities flip sign when the head faces away.
 * depth (sendDepth only) = clamp(round(128 + 255·d_h/H_char), 0, 255).
 */
export function projectToKeypoints(coco18: readonly Vec3[], ctx: ProjectContext): ProjectResult {
  const { basis, projection, canvas, hipC } = ctx;
  const ch = basis.ch;
  const Hchar = ctx.Hchar > 0 ? ctx.Hchar : 1;
  const eps = 0.02 * Hchar;
  const away = ctx.headForward ? dot(ctx.headForward, ch) < 0 : false;
  const prev = ctx.prevRanks && ctx.prevRanks.length === JOINTS ? ctx.prevRanks : null;
  const dh = new Array<number>(JOINTS);
  const key = new Array<number>(JOINTS);
  const order = new Array<number>(JOINTS);
  for (let i = 0; i < JOINTS; i++) {
    const P = coco18[i];
    dh[i] = (P[0] - hipC[0]) * ch[0] + (P[1] - hipC[1]) * ch[1] + (P[2] - hipC[2]) * ch[2];
    const prio = IS_FACE[i] && away ? -Z_PRIORITY[i] : Z_PRIORITY[i];
    key[i] = dh[i] + eps * (0.5 * prio / PRIO_MAX + (prev ? 0.5 * prev[i] / MAX_RANK : 0));
    order[i] = i;
  }
  order.sort((a, b) => key[b] - key[a] || a - b);
  const ranks = new Array<number>(JOINTS);
  for (let pos = 0; pos < JOINTS; pos++)
    ranks[order[pos]] = MAX_RANK - pos;
  const clampedJoints: number[] = [];
  const keypoints = new Array<Keypoint>(JOINTS);
  for (let i = 0; i < JOINTS; i++) {
    const [px, py] = toCanvas(coco18[i], basis, projection);
    const x = px / canvas.width;
    const y = py / canvas.height;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1))
      clampedJoints.push(i);
    const kp: Keypoint = { label: SKELETON_LABELS[i], x: clamp01(x), y: clamp01(y), z_index: ranks[i] };
    if (ctx.sendDepth)
      kp.depth = clamp(Math.round(128 + (255 * dh[i]) / Hchar), 0, 255);
    keypoints[i] = kp;
  }
  return { keypoints, ranks, clamped: clampedJoints.length > 0, clampedJoints };
}

export interface SequenceContext {
  basis: CameraBasis;
  projection: Projection;
  canvas: { width: number; height: number };
  sendDepth: boolean;
}

/** Reusable FK / COCO buffers for projectPose (one per caller, e.g. per thumbnail strip). */
export interface ProjectScratch { fkr: FkResult; coco: Vec3[] }

export const createProjectScratch = (): ProjectScratch => ({ fkr: createFkResult(), coco: createCoco() });

/**
 * One pose → keypoints, with this frame's hip centre, head forward and H_char from FK (no hysteresis unless
 * prevRanks is given). For thumbnails and previews; Generate uses projectPoseSequence.
 */
export function projectPose(pose: Readonly<Pose>, calib: RigCalibration, ctx: SequenceContext, prevRanks?: number[], scratch: ProjectScratch = createProjectScratch()): ProjectResult {
  fk(pose, calib, scratch.fkr);
  const coco = cocoFromFk(scratch.fkr, calib, scratch.coco);
  const hipC = mid(coco[COCO.L_HIP], coco[COCO.R_HIP]);
  const headForward = qRotate(scratch.fkr.rotW[BONE_INDEX.Head], [0, 0, 1]);
  return projectToKeypoints(coco, { ...ctx, hipC, headForward, Hchar: calib.height, prevRanks });
}

/** The document fields projectPoseForDisplay / projectCocoForDisplay read (any UndoableState fits). */
export type DisplayState = Pick<UndoableState, 'direction' | 'pitchDeg' | 'projection' | 'rig' | 'sendDepth'> & { reference: Pick<ReferenceData, 'width' | 'height'> };

export interface DisplayProjection extends ProjectResult {
  /** 18 canvas-pixel points (canonical COCO order, y down): exactly what PixelLab receives (keypoint x·W, y·H, clamped). */
  points: [number, number][];
  /** The PixelLab canvas the points live in (the reference width / height). */
  canvas: { width: number; height: number };
}

const withPoints = (res: ProjectResult, canvas: { width: number; height: number }): DisplayProjection =>
  ({ ...res, points: res.keypoints.map((k): [number, number] => [k.x * canvas.width, k.y * canvas.height]), canvas });

/**
 * One pose of a document → its PixelLab canvas projection, with no setup: the camera basis from direction / pitchDeg,
 * the doc's projection, the reference canvas and H_char from the rig. For frame thumbnails and previews; ranks have
 * no hysteresis (Generate uses projectPoseSequence). Draw joints in ascending rank so nearer ones land on top.
 */
export function projectPoseForDisplay(state: DisplayState, pose: Readonly<Pose>, scratch?: ProjectScratch): DisplayProjection {
  const canvas = { width: state.reference.width, height: state.reference.height };
  const ctx: SequenceContext = { basis: cameraBasis(state.direction, state.pitchDeg), projection: state.projection, canvas, sendDepth: state.sendDepth };
  return withPoints(projectPose(pose, state.rig, ctx, undefined, scratch), canvas);
}

/**
 * Raw COCO points of a document (a COCO edit drag, before the doc recalibrates) → their PixelLab canvas projection,
 * like projectPoseForDisplay but without FK: hip centre from the points, H_char from the rig, and the head forward
 * approximated by ears → nose (it only decides whether the face priorities flip).
 */
export function projectCocoForDisplay(state: DisplayState, coco: readonly Vec3[]): DisplayProjection {
  const canvas = { width: state.reference.width, height: state.reference.height };
  const res = projectToKeypoints(coco, {
    basis: cameraBasis(state.direction, state.pitchDeg), projection: state.projection, canvas, sendDepth: state.sendDepth,
    hipC: mid(coco[COCO.L_HIP], coco[COCO.R_HIP]), headForward: sub(coco[COCO.NOSE], mid(coco[COCO.L_EAR], coco[COCO.R_EAR])),
    Hchar: state.rig.height
  });
  return withPoints(res, canvas);
}

/**
 * Project poses in submission order (PLAN §4.5): poses[0] = the reference, then track frames 1..N. Each frame's hip
 * centre, head forward and Hchar come from FK; z_index hysteresis chains frame to frame with no wrap-around.
 * result[0] → first_frame_keypoints, result[1..] → keypoints. The thumbnails must not use this (hysteresis couples frames).
 */
export function projectPoseSequence(poses: readonly Readonly<Pose>[], calib: RigCalibration, ctx: SequenceContext): ProjectResult[] {
  const scratch = createProjectScratch();
  const out: ProjectResult[] = [];
  let prevRanks: number[] | undefined;
  for (const pose of poses) {
    const res = projectPose(pose, calib, ctx, prevRanks, scratch);
    prevRanks = res.ranks;
    out.push(res);
  }
  return out;
}
