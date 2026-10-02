// Calibration (PLAN §4.4 plus every fix of docs/research/critique-rig-math.md): 18 COCO 3D points of the reference
// pose → per-animation rig proportions + pose, such that FK reproduces all 18 points (< 1e-6; ~1e-15 in practice).
import { BONE_NAMES, FACE_LABELS, type BoneName, type FaceLabel, type Pose, type Quat, type Vec3 } from '@shared/pose';
import type { RigCalibration } from '../model';
import { COCO, LABEL_INDEX } from './coco';
import { cocoFromPose, worldRotations } from './fk';
import {
  EPS, add, clamp, copy3, cross, dist, dot, fitRotation, len, lerp, mid, norm, perp, qConj, qCopy, qFromAxisAngle,
  qFromBasis, qFromUnitVectors, qMul, qMulConjA, qNormalize, qPow, qRotate, qRotateInv, qSwingTwist, qYaw, scale, sub
} from './math';
import { calibrationHeight, templateCalibration } from './poses';
import { BONE_INDEX, LIMB_CHAINS, PARENT_INDEX, TEMPLATE, type LimbChain } from './rigDef';

export interface CalibrateOptions {
  /** Kabsch weights of the face points: 1 visible, 0.25 hidden (from LiftResult.faceWeights). Default 1. */
  weights?: Partial<Record<FaceLabel, number>>;
  /** Previous calibrated pose; its limb bend normals are preferred for near-straight limbs. */
  prevPose?: Pose;
  /**
   * Fraction of the fitted head tilt (pitch / roll relative to UpperChest) to keep, 0..1; the yaw about the UpperChest
   * up axis is always kept. Default HEAD_TILT_KEEP; 1 = the raw Kabsch fit. The face offsets absorb the rest.
   */
  headTilt?: number;
}

/**
 * Head regularization (PLAN §4.4 step 5, refined): pixel-art faces are drawn level and frontal, so the Kabsch fit
 * reads pitched / rolled heads (east sprites 17–33° roll at top-down pitches). Face offsets are measured from the FK
 * head, so any head rotation reproduces the face exactly: keep the fitted yaw and only this fraction of the tilt.
 */
export const HEAD_TILT_KEEP = 0.2;

export interface CalibrateResult {
  calib: RigCalibration;
  /** Hips world position + local rotations; cocoFromPose(pose, calib) reproduces the input. */
  pose: Pose;
  /** Max |FK − input| over the 18 points (world units); must be < 1e-6 (after forcing NECK). */
  residual: number;
  /** e.g. "left/right may be swapped" (hips Z·(0,0,1) ≤ 0), degenerate hips. */
  warnings: string[];
}

/** Copy of the input with NECK forced to the shoulder midpoint (calibrate does this first). */
export function forceNeck(coco18: readonly Vec3[]): Vec3[] {
  const out = coco18.map((p): Vec3 => [p[0], p[1], p[2]]);
  out[COCO.NECK] = mid(out[COCO.L_SHOULDER], out[COCO.R_SHOULDER]);
  return out;
}

/** Max point distance between two 18-point sets. */
export function cocoResidual(a: readonly Vec3[], b: readonly Vec3[]): number {
  let max = 0;
  for (let i = 0; i < a.length; i++)
    max = Math.max(max, dist(a[i], b[i]));
  return max;
}

const X_AXIS: Vec3 = [1, 0, 0];
const Y_AXIS: Vec3 = [0, 1, 0];
const Z_AXIS: Vec3 = [0, 0, 1];
const T = TEMPLATE.offsets;
/** Template spine split: Spine, then Chest / UpperChest / Neck over the rest of the torso. */
const TORSO_T = T.Spine[1] + T.Chest[1] + T.UpperChest[1] + T.Neck[1];
const UPPER3_T = T.Chest[1] + T.UpperChest[1] + T.Neck[1];
/** Measured bend normals below this sin(bend) are pure fallback; full trust from 0.2 (PLAN §4.4 step 4). */
const BLEND_LO = 0.05;
const BLEND_SPAN = 0.15;
const FOLDED = -0.9999;

/** Working state: world rotations and head positions per bone, written as the solve walks down the hierarchy. */
interface Solve {
  offsets: RigCalibration['offsets'];
  rot: Record<BoneName, Quat>;
  qW: Quat[];
  pos: Vec3[];
}

/** Store the world rotation of `bone` and its local rotation relative to the (already solved) parent. */
function setWorld(s: Solve, bone: BoneName, qW: Readonly<Quat>): void {
  const i = BONE_INDEX[bone];
  const p = PARENT_INDEX[i];
  s.qW[i] = qNormalize(qW);
  s.rot[bone] = p < 0 ? qCopy(s.qW[i]) : qNormalize(qMulConjA(s.qW[p], s.qW[i]));
}

/** Head position of `bone` from its parent (FK step). */
function place(s: Solve, bone: BoneName): Vec3 {
  const i = BONE_INDEX[bone];
  const p = PARENT_INDEX[i];
  s.pos[i] = add(s.pos[p], qRotate(s.qW[p], s.offsets[bone]));
  return s.pos[i];
}

const qwOf = (s: Solve, bone: BoneName): Quat => s.qW[BONE_INDEX[bone]];

/** Unit vector of v made perpendicular to the unit axis, or null when v is (nearly) parallel to it. */
function perpUnit(v: Readonly<Vec3>, axis: Readonly<Vec3>, minLen = 1e-9): Vec3 | null {
  const p = perp(v, axis);
  const l = len(p);
  return l < minLen ? null : scale(p, 1 / l);
}

/** Some unit vector perpendicular to the unit vector d. */
const anyPerp = (d: Readonly<Vec3>): Vec3 => perpUnit(X_AXIS, d, 0.1) ?? perpUnit(Y_AXIS, d)!;

/** Hips frame (step 1): X exactly along the hip line, pelvis up halfway between world Y and the torso direction. */
function hipsFrame(target: readonly Vec3[], warnings: string[]): Quat {
  const lh = target[COCO.L_HIP];
  const rh = target[COCO.R_HIP];
  const hipC = mid(lh, rh);
  const torso = sub(target[COCO.NECK], hipC);
  const torsoDir = len(torso) > EPS ? norm(torso) : copy3(Y_AXIS);
  const half = add(Y_AXIS, torsoDir);
  const up = len(half) > 1e-6 ? norm(half) : torsoDir;
  const hipVec = sub(lh, rh);
  let X: Vec3;
  if (len(hipVec) >= 1e-9)
    X = norm(hipVec);
  else {
    // Template hip axis turned by the torso yaw: the horizontal shoulder line, else canonical +X
    warnings.push('The two hips coincide; the hip axis follows the shoulders');
    const sh = sub(target[COCO.L_SHOULDER], target[COCO.R_SHOULDER]);
    X = perpUnit(sh, up) ?? perpUnit(X_AXIS, up) ?? anyPerp(up);
  }
  let Zc = cross(X, up);
  if (len(Zc) < 1e-6) {
    warnings.push('The hip line is parallel to the torso; the pelvis forward is a guess');
    Zc = perpUnit(Z_AXIS, X) ?? anyPerp(X);
  }
  const Z = norm(Zc);
  const Y = cross(Z, X);
  if (dot(Z, Z_AXIS) <= 0)
    warnings.push('The pelvis faces away from +Z: LEFT and RIGHT may be swapped in the estimate');
  return qFromBasis(X, Y, Z);
}

/** Bend normal of the previous pose's limb, expressed in the current ref frame (null without a previous pose). */
function previousNormal(prevW: Quat[] | null, chain: LimbChain, refW: Readonly<Quat>): Vec3 | null {
  if (!prevW)
    return null;
  const nWorldPrev = qRotate(prevW[BONE_INDEX[chain.upper]], chain.n0);
  const nRel = qRotateInv(prevW[BONE_INDEX[chain.ref]], nWorldPrev);
  return qRotate(refW, nRel);
}

/**
 * Two-bone limb (step 4): upper bone from the measured / fallback bend normal, lower bone as a swing, the end bone's
 * head lands exactly on c2. Lengths are measured.
 */
function solveLimb(s: Solve, chain: LimbChain, c1: Readonly<Vec3>, c2: Readonly<Vec3>, prevW: Quat[] | null): void {
  const { upper, lower, end, d0, n0 } = chain;
  const c0 = s.pos[BONE_INDEX[upper]];
  const refW = qwOf(s, chain.ref);
  const v1 = sub(c1, c0);
  const v2 = sub(c2, c1);
  const L1 = len(v1);
  const L2 = len(v2);
  s.offsets[lower] = scale(d0, L1);
  s.offsets[end] = scale(d0, L2);
  const restDirW = qRotate(refW, d0);
  const refN = qRotate(refW, n0);
  const d = L1 > EPS ? scale(v1, 1 / L1) : restDirW;
  const t = L2 > EPS ? scale(v2, 1 / L2) : copy3(d);
  // Fallback normal: the ref-frame rest normal carried along the swing restDir → d (no clavicle roll involved)
  let nfb: Vec3;
  if (dot(d, restDirW) < FOLDED)
    nfb = perpUnit(refN, d) ?? anyPerp(d);
  else
    nfb = perpUnit(qRotate(qFromUnitVectors(restDirW, d), refN), d) ?? anyPerp(d);
  const nPrev = previousNormal(prevW, chain, refW);
  if (nPrev) {
    const p = perp(nPrev, d);
    if (len(p) > 0.3)
      nfb = norm(p);
  }
  const cr = cross(d, t);
  const sinB = len(cr);
  let nMeas = sinB > EPS ? scale(cr, 1 / sinB) : copy3(nfb);
  if (dot(nMeas, nfb) < 0)
    nMeas = scale(nMeas, -1); // a hyperextension (negative hinge), not a 180° twist
  const w = clamp((sinB - BLEND_LO) / BLEND_SPAN, 0, 1);
  const n = perpUnit(lerp(nfb, nMeas, w), d) ?? nfb;
  const qU = qMul(qFromBasis(d, n, cross(d, n)), qConj(qFromBasis(d0, n0, cross(d0, n0))));
  setWorld(s, upper, qU);
  place(s, lower);
  // Lower bone: its rest direction (= d) swung onto t in the bend plane; a fully folded limb turns π about n first
  let qL: Quat;
  if (dot(d, t) < FOLDED) {
    const fold = qMul(qFromAxisAngle(n, Math.PI), qU);
    qL = qMul(qFromUnitVectors(scale(d, -1), t), fold);
  } else
    qL = qMul(qFromUnitVectors(d, t), qU);
  setWorld(s, lower, qL);
  place(s, end);
}

/** Head / face rotation fit (step 5): weighted, centred Kabsch of the 5 face points against the template offsets. */
function headRotation(target: readonly Vec3[], weights: CalibrateOptions['weights'], fallback: Readonly<Quat>): Quat {
  const src = FACE_LABELS.map((k) => TEMPLATE.face[k]);
  const dst = FACE_LABELS.map((k) => target[LABEL_INDEX[k]]);
  const w = FACE_LABELS.map((k) => Math.max(0, weights?.[k] ?? 1));
  const wSum = w.reduce((a, b) => a + b, 0);
  if (wSum < 0.1)
    return qCopy(fallback);
  return fitRotation(src, dst, w, fallback);
}

/**
 * Head rotation relative to UpperChest with its tilt scaled: qRel = swing·twist about the chest's up axis (local +Y);
 * the twist (yaw) is kept and the swing (the tilt of the head's up axis, i.e. pitch and roll) becomes swing^keep.
 */
function regularizeHead(qRel: Readonly<Quat>, keep: number): Quat {
  if (keep >= 1)
    return qCopy(qRel);
  const { swing, twist } = qSwingTwist(qRel, Y_AXIS);
  return qNormalize(qMul(qPow(swing, keep), twist));
}

/** Feet (step 4): yaw follows the hips' ground-projected forward, lying flat (fallback: the spine direction, then +Z). */
function footYaw(hipsW: Readonly<Quat>): Quat {
  const f = qRotate(hipsW, Z_AXIS);
  let fx = f[0];
  let fz = f[2];
  if (Math.hypot(fx, fz) < 1e-3) {
    const y = qRotate(hipsW, Y_AXIS);
    fx = y[0];
    fz = y[2];
    if (Math.hypot(fx, fz) < 1e-3) {
      fx = 0;
      fz = 1;
    }
  }
  return qYaw(Math.atan2(fx, fz));
}

/**
 * Fit the rig to the 18 canonical points (NECK forced to the shoulder midpoint first). Proportions are measured;
 * template-derived offsets (Head, HeadTop, toes, end sites) scale with s_char = observed torso / template torso.
 */
export function calibrate(coco18: readonly Vec3[], opts: CalibrateOptions = {}): CalibrateResult {
  const warnings: string[] = [];
  const target = forceNeck(coco18);
  if (!target.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])))
    throw new Error('calibrate: the COCO points must be finite');
  const calib = templateCalibration();
  const s: Solve = {
    offsets: calib.offsets,
    rot: {} as Record<BoneName, Quat>,
    qW: BONE_NAMES.map((): Quat => [0, 0, 0, 1]),
    pos: BONE_NAMES.map((): Vec3 => [0, 0, 0])
  };
  const prevW = opts.prevPose ? worldRotations(opts.prevPose) : null;

  // 1. Hips
  const lh = target[COCO.L_HIP];
  const rh = target[COCO.R_HIP];
  const hipC = mid(lh, rh);
  const neck = target[COCO.NECK];
  const torsoLen = dist(neck, hipC);
  const sChar = torsoLen > 1e-9 ? torsoLen / TORSO_T : 1;
  if (torsoLen <= 1e-9)
    warnings.push('NECK coincides with the hip centre; template proportions are used');
  setWorld(s, 'Hips', hipsFrame(target, warnings));
  s.pos[BONE_INDEX.Hips] = copy3(hipC);
  const hipW = dist(lh, rh);
  s.offsets.Hips = [0, 0, 0];
  s.offsets.LeftUpperLeg = [hipW / 2, 0, 0];
  s.offsets.RightUpperLeg = [-hipW / 2, 0, 0];

  // 2. Spine chain: straight along s = NECK − SpineHead, the twist α split over Spine, Chest, UpperChest
  s.offsets.Spine = [0, (T.Spine[1] / TORSO_T) * torsoLen, 0];
  const spineHead = place(s, 'Spine');
  const dir = sub(neck, spineHead);
  const L = len(dir);
  const hipsW = qwOf(s, 'Hips');
  const sDir = L > EPS ? scale(dir, 1 / L) : qRotate(hipsW, Y_AXIS);
  s.offsets.Chest = [0, (L * T.Chest[1]) / UPPER3_T, 0];
  s.offsets.UpperChest = [0, (L * T.UpperChest[1]) / UPPER3_T, 0];
  const neckLen = (L * T.Neck[1]) / UPPER3_T;
  s.offsets.Neck = [0, neckLen, 0];
  const swing = qFromUnitVectors(Y_AXIS, qRotateInv(hipsW, sDir));
  const Xc = qRotate(qMul(hipsW, swing), X_AXIS);
  const Xt = perpUnit(sub(target[COCO.L_SHOULDER], target[COCO.R_SHOULDER]), sDir);
  const alpha = Xt ? Math.atan2(dot(cross(Xc, Xt), sDir), dot(Xc, Xt)) : 0;
  const tw = qFromAxisAngle(Y_AXIS, alpha / 3);
  setWorld(s, 'Spine', qMul(hipsW, qMul(swing, tw))); // swing · twist: twist on the RIGHT
  place(s, 'Chest');
  setWorld(s, 'Chest', qMul(qwOf(s, 'Spine'), tw));
  place(s, 'UpperChest');
  setWorld(s, 'UpperChest', qMul(qwOf(s, 'Chest'), tw));
  place(s, 'Neck');
  const ucW = qwOf(s, 'UpperChest');

  // 3. Clavicles: heads beside the Neck head on the shoulder line, UpperArm offset = the measured distance
  const halfShoulder = dist(target[COCO.L_SHOULDER], target[COCO.R_SHOULDER]) / 2;
  for (const side of [1, -1] as const) {
    const clav: BoneName = side > 0 ? 'LeftShoulder' : 'RightShoulder';
    const arm: BoneName = side > 0 ? 'LeftUpperArm' : 'RightUpperArm';
    const shoulder = target[side > 0 ? COCO.L_SHOULDER : COCO.R_SHOULDER];
    s.offsets[clav] = [side * 0.2 * halfShoulder, neckLen, 0];
    const clavHead = place(s, clav);
    const v = sub(shoulder, clavHead);
    const vl = len(v);
    s.offsets[arm] = [side * vl, 0, 0];
    const local = vl > EPS ? qFromUnitVectors([side, 0, 0], norm(qRotateInv(ucW, v))) : ([0, 0, 0, 1] as Quat);
    setWorld(s, clav, qMul(ucW, local));
    place(s, arm);
  }

  // 4. Arms and legs (ref = UpperChest for arms, Hips for legs, from rigDef LIMB_CHAINS)
  for (const chain of LIMB_CHAINS) {
    const left = chain.name.startsWith('Left');
    const isArm = chain.name.endsWith('Arm');
    if (!isArm)
      place(s, chain.upper);
    const c1 = target[isArm ? (left ? COCO.L_ELBOW : COCO.R_ELBOW) : (left ? COCO.L_KNEE : COCO.R_KNEE)];
    const c2 = target[isArm ? (left ? COCO.L_WRIST : COCO.R_WRIST) : (left ? COCO.L_ANKLE : COCO.R_ANKLE)];
    solveLimb(s, chain, c1, c2, prevW);
    if (isArm) {
      setWorld(s, chain.end, qwOf(s, chain.lower)); // Hand: identity local
      continue;
    }
    setWorld(s, chain.end, footYaw(hipsW)); // Foot: flat, yawed with the pelvis
    const toes: BoneName = left ? 'LeftToes' : 'RightToes';
    s.offsets[toes] = scale(T[toes], sChar);
    place(s, toes);
    setWorld(s, toes, qwOf(s, chain.end));
  }

  // 5. Neck and Head: Kabsch head rotation (yaw kept, tilt regularized toward UpperChest), 40% of it in the Neck,
  // Head position from FK, face offsets from the FK Head
  const R = headRotation(target, opts.weights, ucW);
  const qRel = regularizeHead(qNormalize(qMulConjA(ucW, R)), clamp(opts.headTilt ?? HEAD_TILT_KEEP, 0, 1));
  const neckL = qPow(qRel, 0.4);
  setWorld(s, 'Neck', qMul(ucW, neckL));
  s.offsets.Head = scale(T.Head, sChar);
  const headPos = place(s, 'Head');
  setWorld(s, 'Head', qMul(qwOf(s, 'Neck'), qMulConjA(neckL, qRel)));
  const headW = qwOf(s, 'Head');
  for (const k of FACE_LABELS)
    calib.face[k] = qRotateInv(headW, sub(target[LABEL_INDEX[k]], headPos));

  // 6. Scale the remaining template-derived offsets; 7. H_char
  for (const e of ['HeadTop', 'LeftHandEnd', 'RightHandEnd', 'LeftToesEnd', 'RightToesEnd'] as const)
    s.offsets[e] = scale(T[e], sChar);
  calib.height = calibrationHeight(calib);

  // Canonical key order (BONE_NAMES) so saved files do not depend on the solve order
  const rot = Object.fromEntries(BONE_NAMES.map((b) => [b, s.rot[b]])) as Record<BoneName, Quat>;
  const pose: Pose = { root: copy3(hipC), rot };
  const residual = cocoResidual(cocoFromPose(pose, calib), target);
  if (!(residual < 1e-6))
    warnings.push(`Calibration residual ${residual.toExponential(2)} exceeds 1e-6`);
  return { calib, pose, residual, warnings };
}
