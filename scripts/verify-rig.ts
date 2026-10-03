// npm run test:rig — numeric checks for core/rig (no Electron, no API calls). Prints PASS/FAIL per check and
// exits with code 1 on any failure. Sections: rig definition, camera, math, FK∘calibrate, lift on the fixtures,
// z_index, hysteresis, mirror, re-lift, the generate / document contract paths and FK performance.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DIRECTIONS, SKELETON_LABELS, VIEW_PITCH, canonicalKeypoints, validateAnimateRequest, type Direction, type KeypointOut } from '../src/shared/pixellab';
import { BONE_NAMES, FACE_LABELS, type BoneName, type Pose, type Quat, type Vec3 } from '../src/shared/pose';
import { BONE_INDEX, BONES, END_SITE_INDEX, LIMB_CHAINS, TEMPLATE } from '../src/renderer/src/core/rig/rigDef';
import { COCO, LABEL_INDEX, mirrorLabel } from '../src/renderer/src/core/rig/coco';
import { cocoFromFk, cocoFromPose, createCoco, createFkResult, fk, worldRotations } from '../src/renderer/src/core/rig/fk';
import {
  DEG, RAD, add, angleBetween, cross, dist, dot, fitRotation, len, mid, norm, perp, qAngle, qAngleBetween, qFromAxisAngle,
  qFromUnitVectors, qMul, qMulConjA, qNormalize, qPow, qRotate, qSlerp, qSwingTwist, qYaw, rotateY, sub
} from '../src/renderer/src/core/rig/math';
import { clonePose, idlePose, restPose, templateCalibration } from '../src/renderer/src/core/rig/poses';
import {
  alignedView, cameraBasis, createProjectScratch, fromCanvas, projectCocoForDisplay, projectPose, projectPoseForDisplay,
  projectPoseSequence, projectToKeypoints, toCanvas, translateAnchor, type SequenceContext
} from '../src/renderer/src/core/rig/projection';
import { HEAD_TILT_KEEP, calibrate, cocoResidual, forceNeck, type CalibrateResult } from '../src/renderer/src/core/rig/calibrate';
import { lift, type LiftResult } from '../src/renderer/src/core/rig/lift';
import { mirrorCalibration, mirrorCoco, mirrorPose } from '../src/renderer/src/core/rig/mirror';
import { formatJson, parseAnimation, serializeAnimation, createAnimationMeta, type Projection, type RigCalibration } from '../src/renderer/src/core/model';
import { ghostPoses, metaFromState, newFrame, stateFromMeta, withCamera, withEstimate, withFrames, withReferenceImage } from '../src/renderer/src/core/docState';
import { buildGeneration } from '../src/renderer/src/core/generate';

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok)
    passes++;
  else
    failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const info = (text: string): void => console.log(`      ${text}`);
const section = (title: string): void => console.log(`\n== ${title}`);
const e1 = (v: number): string => v.toExponential(1);
const f1 = (v: number): string => v.toFixed(1);
const f2 = (v: number): string => v.toFixed(2);

/** Deterministic PRNG (mulberry32) → [-0.5, 0.5). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

const euler = (yaw: number, pitch: number, roll: number): Quat =>
  qMul(qMul(qFromAxisAngle([0, 1, 0], yaw * DEG), qFromAxisAngle([1, 0, 0], pitch * DEG)), qFromAxisAngle([0, 0, 1], roll * DEG));

function jitter(coco: readonly Vec3[], amount: number, seed: number): Vec3[] {
  const r = rng(seed);
  return forceNeck(coco.map((p): Vec3 => [p[0] + r() * 2 * amount, p[1] + r() * 2 * amount, p[2] + r() * 2 * amount]));
}

/** Head pitch in degrees (+ = nose up) of a pose's world head rotation. */
function headPitchDeg(pose: Pose): number {
  const f = qRotate(worldRotations(pose)[BONE_INDEX.Head], [0, 0, 1]);
  return Math.asin(Math.max(-1, Math.min(1, f[1]))) * RAD;
}

/** Wrap an angle in degrees to (−180, 180]. */
const wrapDeg = (a: number): number => a - 360 * Math.ceil((a - 180) / 360);

/**
 * Head rotation relative to UpperChest, degrees: yaw = twist about the chest up axis, tilt = angle of the head up
 * axis from the chest up axis (the swing), pitch = asin(forward·Y) (+ nose up), roll = asin(left·Y).
 */
function headRelative(pose: Pose): { yaw: number; tilt: number; pitch: number; roll: number } {
  const qW = worldRotations(pose);
  const rel = qMulConjA(qW[BONE_INDEX.UpperChest], qW[BONE_INDEX.Head]);
  const { swing, twist } = qSwingTwist(rel, [0, 1, 0]);
  const f = qRotate(rel, [0, 0, 1]);
  const x = qRotate(rel, [1, 0, 0]);
  const asinDeg = (v: number): number => Math.asin(Math.max(-1, Math.min(1, v))) * RAD;
  return { yaw: wrapDeg(2 * Math.atan2(twist[1], twist[3]) * RAD), tilt: qAngle(swing) * RAD, pitch: asinDeg(f[1]), roll: asinDeg(x[1]) };
}

/** Regularized vs raw head of the same input: |Δyaw| and |tilt − HEAD_TILT_KEEP·rawTilt|, degrees. */
function headRegularization(reg: Pose, raw: Pose): { yawErr: number; tiltErr: number } {
  const a = headRelative(reg);
  const b = headRelative(raw);
  return { yawErr: Math.abs(wrapDeg(a.yaw - b.yaw)), tiltErr: Math.abs(a.tilt - HEAD_TILT_KEEP * b.tilt) };
}

/** Upper-limb twist vs the rest normal carried along the swing from the ref frame (critique item 2), degrees. */
function limbTwistDeg(pose: Pose, chainName: string): number {
  const chain = LIMB_CHAINS.find((c) => c.name === chainName)!;
  const qW = worldRotations(pose);
  const refW = qW[BONE_INDEX[chain.ref]];
  const upperW = qW[BONE_INDEX[chain.upper]];
  const d = qRotate(upperW, chain.d0);
  const restDirW = qRotate(refW, chain.d0);
  const nRef = norm(perp(qRotate(qFromUnitVectors(restDirW, d), qRotate(refW, chain.n0)), d));
  return angleBetween(qRotate(upperW, chain.n0), nRef) * RAD;
}

const tCalib = templateCalibration();

// ---------------------------------------------------------------------------------------------------------------
section('Rig definition and template');
check('BONES order matches BONE_NAMES', BONES.every((b, i) => b.name === BONE_NAMES[i]));
check('parents precede children', BONES.every((b, i) => !b.parent || BONE_INDEX[b.parent] < i));
const rest = fk(restPose(tCalib), tCalib);
const restCoco = cocoFromFk(rest, tCalib);
check('template height is 1', Math.abs(tCalib.height - 1) < 1e-9, `H_char = ${tCalib.height}`);
check('rest HeadTop at y = 1', Math.abs(rest.endPos[END_SITE_INDEX.HeadTop][1] - 1) < 1e-9);
check('rest COCO NECK = Neck head', dist(restCoco[COCO.NECK], rest.pos[BONE_INDEX.Neck]) < 1e-12);
check('rest Hips height = TEMPLATE.root', Math.abs(restPose(tCalib).root[1] - TEMPLATE.root[1]) < 1e-12);
check('rest toes on the floor', Math.abs(rest.endPos[END_SITE_INDEX.LeftToesEnd][1]) < 1e-12 && Math.abs(rest.pos[BONE_INDEX.RightToes][1]) < 1e-12);
const idleCoco = cocoFromPose(idlePose(tCalib), tCalib);
check('idle wrists below elbows', idleCoco[COCO.L_WRIST][1] < idleCoco[COCO.L_ELBOW][1] && idleCoco[COCO.R_WRIST][1] < idleCoco[COCO.R_ELBOW][1]);
check('idle elbows bend forward (+Z)', idleCoco[COCO.L_WRIST][2] > 0 && idleCoco[COCO.R_WRIST][2] > 0);
check('idle pose is left/right symmetric', cocoResidual(mirrorCoco(idleCoco), idleCoco) < 1e-12);
const cp = clonePose(idlePose(tCalib));
cp.rot.Head[0] = 0.5;
check('clonePose is a deep copy', idlePose(tCalib).rot.Head[0] === 0);

// ---------------------------------------------------------------------------------------------------------------
section('Camera basis and projection');
let worstBasis = 0;
for (const d of DIRECTIONS) {
  for (const pitch of Object.values(VIEW_PITCH)) {
    const b = cameraBasis(d, pitch);
    const c = cross(b.r, b.u);
    worstBasis = Math.max(worstBasis, Math.abs(len(b.r) - 1), Math.abs(len(b.u) - 1), Math.abs(dot(b.r, b.u)), dist(c, b.c));
  }
}
check('camera basis orthonormal and r × u = c (24 combos)', worstBasis < 1e-12, `max err ${e1(worstBasis)}`);
const south20 = cameraBasis('south', 20);
check('south: subject RIGHT on image-left', toCanvas(restCoco[COCO.R_SHOULDER], south20, { ppu: 50, anchorPx: [32, 60] })[0] < 32);
const east20 = cameraBasis('east', 20);
check('east: RIGHT side nearer the camera', dot(restCoco[COCO.R_SHOULDER], east20.ch) > dot(restCoco[COCO.L_SHOULDER], east20.ch));
check('pitch: a nearer point sits lower on the canvas', toCanvas([0, 0, 0.1], south20, { ppu: 50, anchorPx: [32, 32] })[1] > 32);
let facingOk = true;
for (const d of DIRECTIONS) {
  for (const pitch of Object.values(VIEW_PITCH)) {
    const b = cameraBasis(d, pitch);
    const right = dot([0, 0, 1], b.r);
    const toCam = dot([0, 0, 1], b.ch);
    if ((d.includes('east') && right < 0.5) || (d.includes('west') && right > -0.5))
      facingOk = false;
    if ((d.startsWith('south') && toCam < 0.5) || (d.startsWith('north') && toCam > -0.5))
      facingOk = false;
  }
}
check('facing matches the direction name (24 combos)', facingOk);
const proj0: Projection = { ppu: 47.5, anchorPx: [30.25, 55.5] };
const P0: Vec3 = [0.13, 0.62, -0.21];
const [px0, py0] = toCanvas(P0, east20, proj0);
check('fromCanvas inverts toCanvas', dist(fromCanvas(px0, py0, dot(P0, east20.c), east20, proj0), P0) < 1e-12);
const T0: Vec3 = [0.3, -0.1, 0.25];
const moved = translateAnchor(proj0, T0, east20);
const [qx0, qy0] = toCanvas(add(P0, T0), east20, moved);
check('translateAnchor keeps canvas positions', Math.hypot(qx0 - px0, qy0 - py0) < 1e-9);
const av = alignedView({ width: 64, height: 64 }, proj0, east20);
const [cx0, cy0] = toCanvas(av.target, east20, proj0);
check('alignedView target maps to the canvas centre', Math.hypot(cx0 - 32, cy0 - 32) < 1e-9);

// ---------------------------------------------------------------------------------------------------------------
section('Math helpers');
{
  const r = rng(7);
  let worst = 0;
  for (let t = 0; t < 50; t++) {
    const q = qNormalize([r(), r(), r(), r()]);
    const src: Vec3[] = [0, 1, 2, 3, 4].map((): Vec3 => [r(), r(), r()]);
    const dst = src.map((p) => add(qRotate(q, p), [3, -1, 2]));
    worst = Math.max(worst, qAngleBetween(fitRotation(src, dst, [1, 1, 1, 1, 1], [0, 0, 0, 1]), q) * RAD);
  }
  check('fitRotation (Horn) recovers random rotations', worst < 0.1, `worst ${e1(worst)}° (prior bias only)`);
  const prior = qYaw(0.7);
  const line: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
  const fitLine = fitRotation(line, line, [1, 1, 1], prior);
  check('fitRotation on collinear points keeps the prior roll', Math.abs(qRotate(fitLine, [1, 0, 0])[0] - 1) < 1e-6 && Number.isFinite(fitLine[3]), `angle to prior ${f2(qAngleBetween(fitLine, prior) * RAD)}°`);
  const q = euler(40, 25, -10);
  check('qPow(q, t) = slerp(I, q, t)', qAngleBetween(qPow(q, 0.4), qSlerp([0, 0, 0, 1], q, 0.4)) < 1e-9);
  check('rotateY matches qYaw', dist(rotateY([0.3, 0.2, -0.5], 1.1), qRotate(qYaw(1.1), [0.3, 0.2, -0.5])) < 1e-12);
}

// ---------------------------------------------------------------------------------------------------------------
section('FK ∘ calibrate (template rig)');

function roundTrip(name: string, pose: Pose, calib: RigCalibration = tCalib, opts: Parameters<typeof calibrate>[1] = {}): CalibrateResult {
  const coco = cocoFromPose(pose, calib);
  const cal = calibrate(coco, opts);
  const res = cocoResidual(cocoFromPose(cal.pose, cal.calib), forceNeck(coco));
  check(`calibrate ${name}: FK residual < 1e-6`, res < 1e-6 && Math.abs(res - cal.residual) < 1e-12, `${e1(res)}`);
  return cal;
}

function maxBoneError(a: Pose, b: Pose, bones: readonly BoneName[]): number {
  const wa = worldRotations(a);
  const wb = worldRotations(b);
  return Math.max(...bones.map((n) => qAngleBetween(wa[BONE_INDEX[n]], wb[BONE_INDEX[n]]) * RAD));
}

const LIMB_BONES: BoneName[] = ['LeftUpperArm', 'LeftLowerArm', 'RightUpperArm', 'RightLowerArm', 'LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg'];

{
  const idle = idlePose(tCalib);
  const cal = roundTrip('template idle', idle);
  check('idle: neutral head reads 0° pitch', Math.abs(headPitchDeg(cal.pose)) < 1e-6, `${e1(headPitchDeg(cal.pose))}°`);
  check('idle: Neck and Head local rotations are identity', qAngleBetween(cal.pose.rot.Neck, [0, 0, 0, 1]) < 1e-6 && qAngleBetween(cal.pose.rot.Head, [0, 0, 0, 1]) < 1e-6);
  check('idle: calibrated proportions = template', Math.max(...BONE_NAMES.map((b) => dist(cal.calib.offsets[b], tCalib.offsets[b]))) < 1e-12 && Math.abs(cal.calib.height - 1) < 1e-9, `H_char ${cal.calib.height}`);
  check('idle: all world rotations = truth', maxBoneError(cal.pose, idle, BONE_NAMES.filter((b) => !b.endsWith('Foot') && !b.endsWith('Toes'))) < 1e-6);
  check('idle: no warnings', cal.warnings.length === 0, cal.warnings.join('; '));
}
{
  const cal = roundTrip('T-pose', restPose(tCalib));
  const tw = Math.max(limbTwistDeg(cal.pose, 'LeftArm'), limbTwistDeg(cal.pose, 'RightArm'));
  check('T-pose: upper-arm twist vs rest < 1°', tw < 1, `${e1(tw)}°`);
  check('T-pose: local rotations are identity', maxBoneError(cal.pose, restPose(tCalib), BONE_NAMES) < 1e-6);
}
{
  let worstRes = 0;
  let worstTwist = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const coco = jitter(cocoFromPose(restPose(tCalib), tCalib), 0.02, seed);
    const cal = calibrate(coco);
    worstRes = Math.max(worstRes, cocoResidual(cocoFromPose(cal.pose, cal.calib), coco));
    worstTwist = Math.max(worstTwist, limbTwistDeg(cal.pose, 'LeftArm'), limbTwistDeg(cal.pose, 'RightArm'));
  }
  check('T-pose + 0.02 jitter (40 seeds): FK residual < 1e-6', worstRes < 1e-6, e1(worstRes));
  check('T-pose + 0.02 jitter: no flipped (180°) upper-arm twist', worstTwist < 90, `worst ${f1(worstTwist)}° (noise defines the bend plane of a bent limb)`);
}
for (const down of [88, 90, 92]) {
  const pose = restPose(tCalib);
  pose.rot.LeftUpperArm = qFromAxisAngle([0, 0, 1], -down * DEG);
  pose.rot.RightUpperArm = qFromAxisAngle([0, 0, 1], down * DEG);
  const cal = roundTrip(`arms hanging straight ${down}°`, pose);
  const tw = Math.max(limbTwistDeg(cal.pose, 'LeftArm'), limbTwistDeg(cal.pose, 'RightArm'));
  check(`arms straight ${down}°: upper-arm twist vs rest < 15°`, tw < 15, `${e1(tw)}°`);
  let worstJ = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const c2 = calibrate(jitter(cocoFromPose(pose, tCalib), 0.002, seed));
    worstJ = Math.max(worstJ, limbTwistDeg(c2.pose, 'LeftArm'), limbTwistDeg(c2.pose, 'RightArm'));
  }
  check(`arms straight ${down}° + 0.002 jitter (20 seeds): twist < 15°`, worstJ < 15, `worst ${f1(worstJ)}°`);
}
{
  const pose = idlePose(tCalib);
  pose.rot.LeftLowerArm = qFromAxisAngle([0, -1, 0], 70 * DEG);
  pose.rot.RightLowerArm = qFromAxisAngle([0, 1, 0], 45 * DEG);
  pose.rot.LeftUpperLeg = qFromAxisAngle([1, 0, 0], -30 * DEG);
  pose.rot.LeftLowerLeg = qFromAxisAngle([1, 0, 0], 60 * DEG);
  pose.rot.RightLowerLeg = qFromAxisAngle([1, 0, 0], 25 * DEG);
  const cal = roundTrip('bent elbows and knees', pose);
  check('bent limbs: recovered limb rotations = truth', maxBoneError(cal.pose, pose, LIMB_BONES) < 1e-6, `${e1(maxBoneError(cal.pose, pose, LIMB_BONES))}°`);
  const hyper = idlePose(tCalib);
  hyper.rot.LeftLowerLeg = qFromAxisAngle([1, 0, 0], -15 * DEG);
  const ch = roundTrip('hyperextended knee', hyper);
  check('hyperextended knee: no thigh twist (negative hinge)', limbTwistDeg(ch.pose, 'LeftLeg') < 1, `${e1(limbTwistDeg(ch.pose, 'LeftLeg'))}°`);
}
{
  const pose = idlePose(tCalib);
  pose.root = [0, 0.22, 0.03];
  pose.rot.Hips = qFromAxisAngle([1, 0, 0], 25 * DEG);
  pose.rot.Spine = qFromAxisAngle([1, 0, 0], 10 * DEG);
  for (const side of ['Left', 'Right'] as const) {
    pose.rot[`${side}UpperLeg`] = qFromAxisAngle([1, 0, 0], -105 * DEG);
    pose.rot[`${side}LowerLeg`] = qFromAxisAngle([1, 0, 0], 120 * DEG);
    pose.rot[`${side}Foot`] = qFromAxisAngle([1, 0, 0], -30 * DEG);
  }
  const cal = roundTrip('crouch', pose);
  const err = maxBoneError(cal.pose, pose, ['LeftLowerLeg', 'RightLowerLeg', 'LeftUpperLeg', 'RightUpperLeg']);
  check('crouch: recovered leg rotations = truth', err < 1e-6, `${e1(err)}°`);
}
for (const twist of [40, -40]) {
  const pose = idlePose(tCalib);
  for (const b of ['Spine', 'Chest', 'UpperChest'] as const)
    pose.rot[b] = qFromAxisAngle([0, 1, 0], (twist / 3) * DEG);
  const cal = roundTrip(`torso twist ${twist}°`, pose);
  const err = maxBoneError(cal.pose, pose, ['Spine', 'Chest', 'UpperChest', 'LeftUpperArm', 'RightLowerArm']);
  check(`torso twist ${twist}°: spine and arm rotations = truth`, err < 1e-6, `${e1(err)}°`);
}
{
  // Raw Kabsch fit (headTilt 1) recovers any head rotation; the default keeps the yaw and HEAD_TILT_KEEP of the tilt
  const cases: [string, Quat][] = [['yaw 35°', euler(35, 0, 0)], ['pitch −25°', euler(0, -25, 0)], ['roll 20°', euler(0, 0, 20)], ['yaw/pitch/roll', euler(-30, 15, 12)]];
  let worstYaw = 0;
  let worstTilt = 0;
  for (const [label, q] of cases) {
    const pose = idlePose(tCalib);
    pose.rot.Neck = qPow(q, 0.3);
    pose.rot.Head = qMul(qPow(q, -0.3), q);
    const raw = roundTrip(`head ${label} (raw fit)`, pose, tCalib, { headTilt: 1 });
    const err = maxBoneError(raw.pose, pose, ['Head']);
    check(`head ${label}: raw fit recovers the head rotation`, err < 0.5, `${e1(err)}°`);
    const reg = roundTrip(`head ${label} (regularized)`, pose);
    const r = headRegularization(reg.pose, raw.pose);
    worstYaw = Math.max(worstYaw, r.yawErr);
    worstTilt = Math.max(worstTilt, r.tiltErr);
  }
  check(`regularized head keeps the fitted yaw and ${HEAD_TILT_KEEP * 100}% of the fitted tilt (4 head cases)`, worstYaw < 1e-6 && worstTilt < 1e-6, `|Δyaw| ${e1(worstYaw)}°, |Δtilt| ${e1(worstTilt)}°`);
  const yawOnly = idlePose(tCalib);
  yawOnly.rot.Head = euler(35, 0, 0);
  const cy = calibrate(cocoFromPose(yawOnly, tCalib));
  const yawErr = maxBoneError(cy.pose, yawOnly, ['Head']);
  check('regularized head: a pure yaw is recovered exactly', yawErr < 0.5, `${e1(yawErr)}°`);
  const look = idlePose(tCalib);
  look.rot.Head = euler(0, 20, 0); // +20° about +X tips the nose down
  const cl = calibrate(cocoFromPose(look, tCalib), { headTilt: 1 });
  check('head pitched down reads −20° pitch (raw fit)', Math.abs(headPitchDeg(cl.pose) + 20) < 0.5, `${f2(headPitchDeg(cl.pose))}°`);
  const clr = calibrate(cocoFromPose(look, tCalib));
  const expect = -20 * HEAD_TILT_KEEP;
  check(`head pitched down reads ${f1(expect)}° pitch (regularized), FK exact`, Math.abs(headPitchDeg(clr.pose) - expect) < 0.5 && clr.residual < 1e-6, `${f2(headPitchDeg(clr.pose))}°, residual ${e1(clr.residual)}`);
}
{
  let worst = 0;
  let worstHead = 0;
  let worstYaw = 0;
  let worstTilt = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const r = rng(seed * 101);
    const pose = idlePose(tCalib);
    pose.root = [r() * 0.2, 0.35 + r() * 0.1, r() * 0.2];
    for (const b of BONE_NAMES)
      pose.rot[b] = qMul(pose.rot[b], euler(r() * 70, r() * 70, r() * 70));
    const coco = cocoFromPose(pose, tCalib);
    const cal = calibrate(coco);
    const raw = calibrate(coco, { headTilt: 1 });
    worst = Math.max(worst, cal.residual, raw.residual);
    worstHead = Math.max(worstHead, maxBoneError(raw.pose, pose, ['Head']));
    const h = headRegularization(cal.pose, raw.pose);
    worstYaw = Math.max(worstYaw, h.yawErr);
    worstTilt = Math.max(worstTilt, h.tiltErr);
  }
  check('30 random poses: FK residual < 1e-6 (regularized and raw head)', worst < 1e-6, e1(worst));
  check('30 random poses: head rotation recovered (raw fit)', worstHead < 0.5, `worst ${e1(worstHead)}°`);
  check(`30 random poses: regularized head = raw yaw + ${HEAD_TILT_KEEP * 100}% of the raw tilt`, worstYaw < 1e-6 && worstTilt < 1e-6, `|Δyaw| ${e1(worstYaw)}°, |Δtilt| ${e1(worstTilt)}°`);
}
{
  // Non-template proportions: every offset scaled randomly, face offsets perturbed
  const r = rng(99);
  const odd = templateCalibration();
  for (const k of Object.keys(odd.offsets) as (keyof RigCalibration['offsets'])[])
    odd.offsets[k] = odd.offsets[k].map((v) => v * (1 + r() * 0.6)) as Vec3;
  for (const k of FACE_LABELS)
    odd.face[k] = odd.face[k].map((v) => v * 1.4 + r() * 0.02) as Vec3;
  const pose = idlePose(odd);
  pose.rot.Spine = euler(10, 8, -5);
  pose.rot.LeftLowerArm = qFromAxisAngle([0, -1, 0], 50 * DEG);
  roundTrip('random proportions (±30%) + chibi face', pose, odd);
  let worst = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const coco = jitter(cocoFromPose(idlePose(tCalib), tCalib), 0.05, seed * 7);
    worst = Math.max(worst, calibrate(coco).residual);
  }
  check('20 arbitrary point sets (0.05 jitter): FK residual < 1e-6', worst < 1e-6, e1(worst));
}
{
  // Degenerate inputs: finite output, exact where the geometry allows
  const same: Vec3[] = SKELETON_LABELS.map((): Vec3 => [0.1, 0.5, 0]);
  const cs = calibrate(same);
  const finite = (c: CalibrateResult): boolean => BONE_NAMES.every((b) => c.pose.rot[b].every(Number.isFinite)) && Number.isFinite(c.calib.height);
  check('degenerate: 18 coincident points → finite rig, residual < 1e-6', finite(cs) && cs.residual < 1e-6, `${e1(cs.residual)}, ${cs.warnings.length} warning(s)`);
  const hips = cocoFromPose(idlePose(tCalib), tCalib);
  hips[COCO.L_HIP] = [...hips[COCO.R_HIP]];
  const ch = calibrate(hips);
  check('degenerate: coincident hips → finite, exact', finite(ch) && ch.residual < 1e-6 && ch.warnings.some((w) => w.includes('hips')), e1(ch.residual));
  const fold = idlePose(tCalib);
  fold.rot.LeftLowerArm = qFromAxisAngle([0, -1, 0], 180 * DEG);
  const cf = roundTrip('fully folded elbow', fold);
  check('fully folded elbow: finite', finite(cf));
  const flatFace = cocoFromPose(idlePose(tCalib), tCalib);
  for (const k of FACE_LABELS)
    flatFace[LABEL_INDEX[k]] = [0, 0.9, 0.05];
  const cff = calibrate(flatFace);
  check('degenerate: coincident face points → finite, exact', finite(cff) && cff.residual < 1e-6, e1(cff.residual));
  const swapped = cocoFromPose(idlePose(tCalib), tCalib).map((_, i, all) => all[LABEL_INDEX[mirrorLabel(SKELETON_LABELS[i])]]);
  const cw = calibrate(swapped.map((p): Vec3 => [p[0], p[1], -p[2]]));
  check('swapped LEFT/RIGHT labels → warning', cw.warnings.some((w) => w.includes('swapped')), cw.warnings.join('; '));
}
{
  // Previous-frame bend normal: a straight limb keeps the previous pose's hinge axis
  const bent = idlePose(tCalib);
  bent.rot.LeftUpperArm = qMul(qFromAxisAngle([0, 0, 1], -88 * DEG), qFromAxisAngle([1, 0, 0], 50 * DEG));
  bent.rot.LeftLowerArm = qFromAxisAngle([0, -1, 0], 40 * DEG);
  const prev = calibrate(cocoFromPose(bent, tCalib)).pose;
  const straight = clonePose(bent);
  straight.rot.LeftLowerArm = [0, 0, 0, 1];
  const withPrev = calibrate(cocoFromPose(straight, tCalib), { prevPose: prev });
  const err = maxBoneError(withPrev.pose, straight, ['LeftUpperArm']);
  check('straight limb with prevPose keeps the previous hinge axis', err < 1e-6, `${e1(err)}°`);
}

// ---------------------------------------------------------------------------------------------------------------
section('Fixtures: lift → calibrate → FK → project');

interface Fixture { name: string; direction: Direction; keypoints: KeypointOut[]; canvas: { width: number; height: number } }

const fixtureDir = path.resolve(__dirname, '..', 'testbed', 'fixtures');
const fixtures: Fixture[] = readdirSync(fixtureDir).filter((n) => n.endsWith('.estimate.json')).map((f) => {
  const fx = JSON.parse(readFileSync(path.join(fixtureDir, f), 'utf8')) as { keypoints: KeypointOut[]; canvas: { width: number; height: number } };
  return { name: f.replace('.estimate.json', ''), direction: f.includes('right') ? 'east' : 'south', keypoints: fx.keypoints, canvas: fx.canvas };
});
check('4 fixtures found', fixtures.length === 4, fixtures.map((f) => f.name).join(', '));

/** Reprojection of a calibrated pose vs the estimate: max error over the 17 non-NECK joints and the NECK error, px. */
function reprojection(fx: Fixture, cal: CalibrateResult, projection: Projection, pitch: number): { max: number; neck: number; ranks: number[] } {
  const b = cameraBasis(fx.direction, pitch);
  const coco = cocoFromPose(cal.pose, cal.calib);
  const est = canonicalKeypoints(fx.keypoints)!;
  let max = 0;
  let neck = 0;
  coco.forEach((p, i) => {
    const [x, y] = toCanvas(p, b, projection);
    const e = Math.hypot(x - est[i].x * fx.canvas.width, y - est[i].y * fx.canvas.height);
    if (i === COCO.NECK)
      neck = e;
    else
      max = Math.max(max, e);
  });
  const ranks = projectPose(cal.pose, cal.calib, { basis: b, projection, canvas: fx.canvas, sendDepth: false }).ranks;
  return { max, neck, ranks };
}

/** Fraction of joint pairs whose estimate z_index order (where it differs by ≥ 1) our ranks reproduce. */
function zAgreement(est: KeypointOut[], ranks: number[]): number {
  let n = 0;
  let ok = 0;
  for (let i = 0; i < 18; i++) {
    for (let j = i + 1; j < 18; j++) {
      const dz = est[i].z_index - est[j].z_index;
      if (Math.abs(dz) < 1)
        continue;
      n++;
      if (Math.sign(dz) === Math.sign(ranks[i] - ranks[j]))
        ok++;
    }
  }
  return n ? ok / n : 1;
}

const liftCache = new Map<string, { lifted: LiftResult; cal: CalibrateResult }>();
const PITCH = VIEW_PITCH['low top-down'];
for (const fx of fixtures) {
  const t0 = performance.now();
  const lifted = lift({ estimate: fx.keypoints, canvas: fx.canvas, direction: fx.direction, pitchDeg: PITCH });
  const t1 = performance.now();
  const cal = calibrate(lifted.coco, { weights: lifted.faceWeights });
  const t2 = performance.now();
  liftCache.set(fx.name, { lifted, cal });
  const rep = lifted.report;
  const rp = reprojection(fx, cal, lifted.projection, PITCH);
  const est = canonicalKeypoints(fx.keypoints)!;
  check(`${fx.name}: lift reprojects 17 joints < 1e-6 px`, rep.maxResidualPx < 1e-6, `${e1(rep.maxResidualPx)} px; NECK forced by ${rep.neckResidualPx.toFixed(3)} px`);
  check(`${fx.name}: calibrate residual < 1e-6`, cal.residual < 1e-6, e1(cal.residual));
  check(`${fx.name}: FK of the calibrated pose reprojects 17 joints < 1e-6 px`, rp.max < 1e-6, `${e1(rp.max)} px, NECK residual ${rp.neck.toFixed(3)} px`);
  info(`direction ${fx.direction}, pitch ${PITCH}°: torso yaw δ ${f1(rep.torsoYawDeg)}°, head yaw ${f1(rep.headYawDeg)}°, width k ${f2(rep.widthScale)}, s_char ${f2(rep.charScale)}, ppu ${f1(rep.ppu)}, H_char ${cal.calib.height.toFixed(3)}; lift ${f1(t1 - t0)} ms, calibrate ${f1(t2 - t1)} ms`);
  info(`face weights ${FACE_LABELS.map((k) => `${k} ${lifted.faceWeights[k]}`).join(', ')}`);
  info(`limb depth rules ${Object.entries(rep.limbRules).map(([k, v]) => `${k.replace(/RIGHT /g, 'R ').replace(/LEFT /g, 'L ')}: ${v}`).join(', ')}`);
  info(`z ranks  ${SKELETON_LABELS.map((l, i) => `${l} ${rp.ranks[i]}`).join(', ')}`);
  info(`estimate ${SKELETON_LABELS.map((l, i) => `${l} ${est[i].z_index}`).join(', ')}`);
  info(`estimate z order reproduced for ${(100 * zAgreement(est, rp.ranks)).toFixed(0)}% of the joint pairs it separates by ≥ 1 layer`);
  for (const w of [...rep.warnings, ...cal.warnings])
    info(`warning: ${w}`);
  const b = cameraBasis(fx.direction, PITCH);
  const hipC = mid(lifted.coco[COCO.L_HIP], lifted.coco[COCO.R_HIP]);
  check(`${fx.name}: hip centre at X = Z = 0`, Math.abs(hipC[0]) < 1e-9 && Math.abs(hipC[2]) < 1e-9);
  const toes = fk(cal.pose, cal.calib).endPos[END_SITE_INDEX.LeftToesEnd][1];
  check(`${fx.name}: lowest foot on the floor`, Math.min(lifted.coco[COCO.L_ANKLE][1], lifted.coco[COCO.R_ANKLE][1]) > 0 && Math.abs(Math.min(toes, fk(cal.pose, cal.calib).endPos[END_SITE_INDEX.RightToesEnd][1])) < 1e-9);
  if (fx.direction === 'south')
    check(`${fx.name}: south torso yaw ≈ 0`, Math.abs(rep.torsoYawDeg) < 1, `${f2(rep.torsoYawDeg)}°`);
  else {
    const dh = (i: number): number => dot(sub(lifted.coco[i], hipC), b.ch);
    check(`${fx.name}: east — RIGHT side nearer (shoulders and hips)`, dh(COCO.R_SHOULDER) > dh(COCO.L_SHOULDER) && dh(COCO.R_HIP) > dh(COCO.L_HIP), `d_h R/L shoulder ${dh(COCO.R_SHOULDER).toFixed(3)}/${dh(COCO.L_SHOULDER).toFixed(3)}`);
    const side = (pre: string): number => SKELETON_LABELS.reduce((a, l, i) => a + (l.startsWith(pre) ? rp.ranks[i] : 0), 0) / 8;
    check(`${fx.name}: east — RIGHT ranks above LEFT on average`, side('RIGHT') > side('LEFT'), `${f1(side('RIGHT'))} vs ${f1(side('LEFT'))}`);
    check(`${fx.name}: east — torso opened toward the camera (δ < 0), within ±60°`, rep.torsoYawDeg < 0 && rep.torsoYawDeg > -60, `${f1(rep.torsoYawDeg)}°`);
    const fwd = qRotate(worldRotations(cal.pose)[BONE_INDEX.Hips], [0, 0, 1]);
    check(`${fx.name}: east — pelvis faces screen-right`, dot(fwd, b.r) > 0.5, `forward·r ${f2(dot(fwd, b.r))}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
section('Head orientation on the fixtures (tilt regularized toward UpperChest)');
for (const fx of fixtures) {
  let worstPitch = 0;
  let worstRoll = 0;
  let worstRes = 0;
  let worstReg = 0;
  const rows: string[] = [];
  for (const pitch of [0, 20, 35]) {
    const lifted = lift({ estimate: fx.keypoints, canvas: fx.canvas, direction: fx.direction, pitchDeg: pitch });
    const cal = calibrate(lifted.coco, { weights: lifted.faceWeights });
    const raw = calibrate(lifted.coco, { weights: lifted.faceWeights, headTilt: 1 });
    const h = headRelative(cal.pose);
    const hr = headRelative(raw.pose);
    const reg = headRegularization(cal.pose, raw.pose);
    worstPitch = Math.max(worstPitch, Math.abs(h.pitch));
    worstRoll = Math.max(worstRoll, Math.abs(h.roll));
    worstRes = Math.max(worstRes, cal.residual);
    worstReg = Math.max(worstReg, reg.yawErr, reg.tiltErr);
    rows.push(`${pitch}°: yaw ${f1(h.yaw)} pitch ${f1(h.pitch)} roll ${f1(h.roll)} (raw pitch ${f1(hr.pitch)} roll ${f1(hr.roll)})`);
  }
  info(`${fx.name} head vs UpperChest, degrees: ${rows.join('; ')}`);
  check(`${fx.name}: regularized head keeps the fitted yaw, FK exact (pitch 0/20/35)`, worstReg < 1e-6 && worstRes < 1e-6, `${e1(worstReg)}°, residual ${e1(worstRes)}`);
  if (fx.direction === 'south')
    check(`${fx.name}: south head pitch and roll vs chest < 5° (pitch 0/20/35)`, worstPitch < 5 && worstRoll < 5, `pitch ${f1(worstPitch)}°, roll ${f1(worstRoll)}°`);
  else
    check(`${fx.name}: east head roll vs chest < 8° (pitch 0/20/35)`, worstRoll < 8, `roll ${f1(worstRoll)}°, pitch ${f1(worstPitch)}°`);
}

// ---------------------------------------------------------------------------------------------------------------
section('Lift of synthetic estimates (known 3D truth)');

/** Project a known pose to an estimate-like 2D set (z_index = coarse d_h layers, nearest highest) and lift it. */
function synthLift(truth: readonly Vec3[], d: Direction, pitch: number): { lifted: LiftResult; err: number } {
  const b = cameraBasis(d, pitch);
  const proj: Projection = { ppu: 50, anchorPx: [64, 110] };
  const hip = mid(truth[COCO.L_HIP], truth[COCO.R_HIP]);
  const est: KeypointOut[] = truth.map((p, i) => {
    const [x, y] = toCanvas(p, b, proj);
    return { label: SKELETON_LABELS[i], x: x / 128, y: y / 128, z_index: Math.round(dot(sub(p, hip), b.ch) * 10) };
  });
  const lifted = lift({ estimate: est, canvas: { width: 128, height: 128 }, direction: d, pitchDeg: pitch });
  // Compare in the truth's units: undo the lift's scale and translation about the hip centre
  const h2 = mid(lifted.coco[COCO.L_HIP], lifted.coco[COCO.R_HIP]);
  const k = lifted.report.ppu / proj.ppu;
  let err = 0;
  truth.forEach((p, i) => {
    const q = sub(lifted.coco[i], h2);
    err = Math.max(err, dist(sub(p, hip), [q[0] * k, q[1] * k, q[2] * k]));
  });
  return { lifted, err };
}
{
  const truth = cocoFromPose(idlePose(tCalib), tCalib);
  let worst = 0;
  let worstYaw = 0;
  let worstK = 0;
  for (const d of DIRECTIONS) {
    for (const pitch of [0, 20, 35]) {
      const r = synthLift(truth, d, pitch);
      worst = Math.max(worst, r.err);
      worstYaw = Math.max(worstYaw, Math.abs(r.lifted.report.torsoYawDeg), Math.abs(r.lifted.report.headYawDeg));
      worstK = Math.max(worstK, Math.abs(r.lifted.report.widthScale - 1));
    }
  }
  check('template idle, 8 directions × 3 pitches: lift recovers the 3D pose', worst < 1e-3 && worstYaw < 0.5 && worstK < 0.01, `max 3D error ${e1(worst)}, |yaw| ≤ ${f2(worstYaw)}°, |k − 1| ≤ ${e1(worstK)}`);
  const rows: string[] = [];
  let signOk = true;
  let worstObs = 0;
  for (const yaw of [-30, 25]) {
    const pose = idlePose(tCalib);
    pose.rot.Hips = qYaw(yaw * DEG);
    const yawed = cocoFromPose(pose, tCalib);
    for (const d of DIRECTIONS) {
      for (const pitch of [0, 20, 35]) {
        const r = synthLift(yawed, d, pitch);
        const est = r.lifted.report.torsoYawDeg;
        signOk &&= Math.sign(est) === Math.sign(yaw);
        // Yaw is unobservable in 2D for frontal views without pitch (only the z_index sign is known)
        if (!(pitch === 0 && (d === 'south' || d === 'north')))
          worstObs = Math.max(worstObs, Math.abs(est - yaw));
        if (pitch === 20)
          rows.push(`${d} ${f1(est)}°`);
      }
    }
    info(`torso yaw ${yaw}° recovered at pitch 20°: ${rows.splice(0).join(', ')}`);
  }
  check('yawed torso (−30°, +25°): recovered yaw has the right sign in every view', signOk);
  check('yawed torso: |error| < 20° wherever the yaw is observable (priors pull toward 0°)', worstObs < 20, `worst ${f1(worstObs)}°`);
  let finite = true;
  let exact = 0;
  for (const fx of fixtures) {
    for (const d of DIRECTIONS) {
      for (const pitch of [0, 20, 35]) {
        const r = lift({ estimate: fx.keypoints, canvas: fx.canvas, direction: d, pitchDeg: pitch });
        finite &&= r.coco.every((p) => p.every(Number.isFinite)) && Number.isFinite(r.projection.ppu);
        exact = Math.max(exact, r.report.maxResidualPx, calibrate(r.coco, { weights: r.faceWeights }).residual);
      }
    }
  }
  check('every fixture under every direction × pitch (even mismatched): finite and exact', finite && exact < 1e-6, `worst ${e1(exact)}`);
}

// ---------------------------------------------------------------------------------------------------------------
section('Re-lift for direction / pitch changes');
for (const fx of fixtures) {
  for (const pitch of [0, 35]) {
    const lifted = lift({ estimate: fx.keypoints, canvas: fx.canvas, direction: fx.direction, pitchDeg: pitch });
    const cal = calibrate(lifted.coco, { weights: lifted.faceWeights, prevPose: liftCache.get(fx.name)!.cal.pose });
    const rp = reprojection(fx, cal, lifted.projection, pitch);
    check(`${fx.name}: re-lift at pitch ${pitch}° stays exact`, rp.max < 1e-6 && cal.residual < 1e-6, `${e1(rp.max)} px; δ ${f1(lifted.report.torsoYawDeg)}°, H_char ${cal.calib.height.toFixed(3)}`);
  }
}
{
  const fx = fixtures[0];
  const animMeta = createAnimationMeta({ direction: fx.direction, canvas: fx.canvas, action: 'walk' });
  let st = withReferenceImage(stateFromMeta(animMeta), { image: 'fixture0', sourceBaseUid: null, ...fx.canvas });
  st = withEstimate(st, fx.keypoints).state;
  const moved2 = withCamera(st, { pitchDeg: 35 }).state;
  const cal = { pose: moved2.reference.pose!, calib: moved2.rig, residual: 0, warnings: [] };
  const rp = reprojection(fx, cal, moved2.projection, 35);
  check('withCamera(pitch 35°) re-lifts the reference exactly', rp.max < 1e-6, `${e1(rp.max)} px`);
  check('withCamera keeps the track frames', moved2.frames.length === st.frames.length && moved2.frames[0].pose === st.frames[0].pose);
}

// ---------------------------------------------------------------------------------------------------------------
section('z_index on the idle pose, 8 directions');
{
  const idle = idlePose(tCalib);
  const canvas = { width: 64, height: 64 };
  const ctxFor = (d: Direction, sendDepth = false): SequenceContext => ({ basis: cameraBasis(d, 20), projection: { ppu: 48, anchorPx: [32, 56] }, canvas, sendDepth });
  for (const d of DIRECTIONS) {
    const res = projectPose(idle, tCalib, ctxFor(d, true));
    const r = res.ranks;
    const perm = [...r].sort((a, b) => a - b).every((v, i) => v === i);
    const side = (pre: string): number => SKELETON_LABELS.reduce((a, l, i) => a + (l.startsWith(pre) ? r[i] : 0), 0) / 8;
    const R = side('RIGHT');
    const L = side('LEFT');
    let ok = perm && res.keypoints.every((k) => Number.isInteger(k.z_index) && k.depth !== undefined && k.depth >= 0 && k.depth <= 255);
    let expect = 'unique ranks 0..17';
    if (d === 'south') {
      ok &&= r[COCO.NOSE] >= 15 && r[COCO.R_EYE] >= 14 && r[COCO.L_EYE] >= 14;
      expect += ', NOSE and eyes on top';
    } else if (d === 'north') {
      ok &&= r[COCO.NOSE] === 0;
      expect += ', NOSE lowest';
    } else if (d.includes('east')) {
      ok &&= R > L;
      expect += ', RIGHT > LEFT';
    } else if (d.includes('west')) {
      ok &&= L > R;
      expect += ', LEFT > RIGHT';
    }
    check(`idle ${d}: ${expect}`, ok, `NOSE ${r[COCO.NOSE]}, RIGHT avg ${f1(R)}, LEFT avg ${f1(L)}, NECK depth ${res.keypoints[COCO.NECK].depth}`);
  }
  const s = projectPose(idle, tCalib, ctxFor('south'));
  check('south idle: symmetric L/R pairs tie-break by label index (strict order)', s.ranks[COCO.R_ELBOW] !== s.ranks[COCO.L_ELBOW]);
  const off = projectPose(idle, tCalib, { ...ctxFor('east'), projection: { ppu: 48, anchorPx: [80, 56] } });
  check('joints outside the canvas are clamped and reported', off.clamped && off.clampedJoints.length > 0 && off.keypoints.every((k) => k.x >= 0 && k.x <= 1 && k.y >= 0 && k.y <= 1), `${off.clampedJoints.length} clamped`);
  const away = clonePose(idle);
  away.rot.Neck = qYaw(Math.PI / 2);
  away.rot.Head = qYaw(Math.PI / 2); // head turned 180°: faces away from a south camera
  const ra = projectPose(away, tCalib, ctxFor('south')).ranks;
  check('head turned away (south): face points drop below the ears', ra[COCO.NOSE] < ra[COCO.R_EAR] && ra[COCO.NOSE] < ra[COCO.L_EAR], `NOSE ${ra[COCO.NOSE]}, ears ${ra[COCO.R_EAR]}/${ra[COCO.L_EAR]}`);
}

// ---------------------------------------------------------------------------------------------------------------
section('projectToKeypoints ordering rules');
{
  // South, pitch 0: c_h = +Z, so d_h is just z. H_char = 1 → ε = 0.02, hysteresis step per rank 0.5·ε/17.
  const base = { basis: cameraBasis('south', 0), projection: { ppu: 40, anchorPx: [32, 60] } as Projection, canvas: { width: 64, height: 64 }, hipC: [0, 0, 0] as Vec3, Hchar: 1, sendDepth: true };
  const flat = SKELETON_LABELS.map((_, i): Vec3 => [i * 0.01 - 0.09, 0.5, 0]);
  const r0 = projectToKeypoints(flat, base).ranks;
  const expectOrder = ['NOSE', 'RIGHT EYE', 'LEFT EYE', 'RIGHT ELBOW', 'RIGHT ARM', 'LEFT ELBOW', 'LEFT ARM', 'RIGHT KNEE', 'LEFT KNEE', 'RIGHT EAR', 'LEFT EAR', 'NECK', 'RIGHT SHOULDER', 'LEFT SHOULDER', 'RIGHT HIP', 'RIGHT LEG', 'LEFT HIP', 'LEFT LEG'];
  check('equal depths: priority NOSE > EYES > wrists = elbows = knees > EARS > rest, then label index', expectOrder.every((l, pos) => r0[LABEL_INDEX[l as keyof typeof LABEL_INDEX]] === 17 - pos));
  // Critique item 11: depths 0 / 0.015 / 0.03 with priorities high / mid / low form a cycle under an ε-comparator
  const cyc = flat.map((p): Vec3 => [p[0], p[1], -1]);
  cyc[COCO.NOSE] = [0, 0.5, 0];
  cyc[COCO.R_ELBOW] = [0, 0.5, 0.015];
  cyc[COCO.R_EAR] = [0, 0.5, 0.03];
  const rc = projectToKeypoints(cyc, base).ranks;
  check('scalar key gives a strict order where an ε-comparator cycles', rc[COCO.R_EAR] === 17 && rc[COCO.R_ELBOW] === 16 && rc[COCO.NOSE] === 15, `EAR ${rc[COCO.R_EAR]}, ELBOW ${rc[COCO.R_ELBOW]}, NOSE ${rc[COCO.NOSE]}`);
  const band = (0.5 * 0.02) / 17;
  // Previous frame: LEFT ELBOW one rank above RIGHT ELBOW (the label tie-break alone would put RIGHT first)
  const prev = projectToKeypoints(flat, base).ranks;
  prev[COCO.L_ELBOW] = 14;
  prev[COCO.R_ELBOW] = 13;
  const near = cyc.map((p): Vec3 => [p[0], p[1], p[2]]);
  near[COCO.L_ELBOW] = [0, 0.5, 0.2];
  near[COCO.R_ELBOW] = [0, 0.5, 0.2 + 0.7 * band];
  const keep = projectToKeypoints(near, { ...base, prevRanks: prev }).ranks;
  near[COCO.R_ELBOW] = [0, 0.5, 0.2 + 1.3 * band];
  const flip = projectToKeypoints(near, { ...base, prevRanks: prev }).ranks;
  check('hysteresis: a swap smaller than one rank step keeps the previous order, a larger one flips', keep[COCO.L_ELBOW] > keep[COCO.R_ELBOW] && flip[COCO.R_ELBOW] > flip[COCO.L_ELBOW], `band ${e1(band)}`);
  const dk = projectToKeypoints([...flat.slice(0, 1).map((): Vec3 => [0, 0.5, 0.5]), ...flat.slice(1)], base).keypoints;
  check('depth = clamp(round(128 + 255·d_h/H_char))', dk[COCO.NOSE].depth === 255 && dk[COCO.NECK].depth === Math.round(128 + 255 * flat[COCO.NECK][2]), `NOSE ${dk[COCO.NOSE].depth}, NECK ${dk[COCO.NECK].depth}`);
  check('no depth field unless sendDepth', projectToKeypoints(flat, { ...base, sendDepth: false }).keypoints.every((k) => !('depth' in k)));
}

// ---------------------------------------------------------------------------------------------------------------
section('projectPoseSequence hysteresis');
{
  const idle = idlePose(tCalib);
  const ctx: SequenceContext = { basis: cameraBasis('south', 20), projection: { ppu: 48, anchorPx: [32, 56] }, canvas: { width: 64, height: 64 }, sendDepth: false };
  const frames: Pose[] = [];
  for (let f = 1; f <= 12; f++) {
    const r = rng(f * 31);
    const p = clonePose(idle);
    for (const b of BONE_NAMES)
      p.rot[b] = qMul(p.rot[b], euler(r() * 0.02, r() * 0.02, r() * 0.02)); // ≤ 0.01° per bone
    frames.push(p);
  }
  const seq = projectPoseSequence([idle, ...frames], tCalib, ctx);
  const same = seq.every((res) => res.ranks.every((v, i) => v === seq[0].ranks[i]));
  check('small perturbations do not flip ranks (12 frames)', same);
  let flipsWithout = 0;
  for (const p of frames) {
    const r = projectPose(p, tCalib, ctx).ranks;
    flipsWithout += r.some((v, i) => v !== seq[0].ranks[i]) ? 1 : 0;
  }
  info(`without hysteresis ${flipsWithout} of 12 perturbed frames reorder at least one tied pair`);
  const ref = projectPose(idle, tCalib, ctx);
  check('result[0] = the reference projected on its own', seq[0].ranks.every((v, i) => v === ref.ranks[i]) && seq[0].keypoints.every((k, i) => k.x === ref.keypoints[i].x && k.y === ref.keypoints[i].y));
  const reach = clonePose(idle);
  reach.rot.RightUpperArm = qMul(qFromAxisAngle([1, 0, 0], -80 * DEG), reach.rot.RightUpperArm); // hanging arm swung forward (+Z)
  const seq2 = projectPoseSequence([idle, idle, reach], tCalib, ctx);
  check('a real change still reorders (right wrist reaches toward the camera)', seq2[2].ranks[COCO.R_WRIST] === 17 && seq2[1].ranks[COCO.R_WRIST] < 17, `wrist rank ${seq2[1].ranks[COCO.R_WRIST]} → ${seq2[2].ranks[COCO.R_WRIST]}`);
  const plan = buildGenerationFromPoses(idle, frames.slice(0, 3));
  check('buildGeneration: first_frame_keypoints = projected reference', plan.request.first_frame_keypoints.every((k, i) => k.z_index === ref.ranks[i]));
}

function buildGenerationFromPoses(refPose: Pose, poses: Pose[]): ReturnType<typeof buildGeneration> {
  const meta = createAnimationMeta({ direction: 'south', canvas: { width: 64, height: 64 }, action: 'idle' });
  meta.projection = { ppu: 48, anchorPx: [32, 56] };
  meta.reference = { ...meta.reference, image: 'aaaaaaaa', pose: refPose, coco: cocoFromPose(refPose, meta.rig) };
  meta.frames = poses.map((p) => newFrame(p));
  return buildGeneration(stateFromMeta(meta), 'a test character');
}

// ---------------------------------------------------------------------------------------------------------------
section('Mirror');
{
  const idle = idlePose(tCalib);
  const m2 = mirrorPose(mirrorPose(idle));
  check('mirrorPose twice = identity', BONE_NAMES.every((b) => m2.rot[b].every((v, i) => v === idle.rot[b][i])) && dist(m2.root, idle.root) === 0);
  const fxCal = liftCache.get(fixtures[1].name)!.cal;
  const mc2 = mirrorCalibration(mirrorCalibration(fxCal.calib));
  check('mirrorCalibration twice = identity', Object.keys(mc2.offsets).every((k) => dist(mc2.offsets[k as BoneName], fxCal.calib.offsets[k as BoneName]) === 0) && FACE_LABELS.every((k) => dist(mc2.face[k], fxCal.calib.face[k]) === 0));
  // A general pose on an asymmetric (calibrated) rig
  const r = rng(5);
  const pose = clonePose(fxCal.pose);
  for (const b of BONE_NAMES)
    pose.rot[b] = qMul(pose.rot[b], euler(r() * 40, r() * 40, r() * 40));
  pose.root = [0.07, pose.root[1], -0.04];
  const mPose = mirrorPose(pose);
  const mCal = mirrorCalibration(fxCal.calib);
  const coco = cocoFromPose(pose, fxCal.calib);
  const mCoco = cocoFromPose(mPose, mCal);
  check('FK(mirrored rig, mirrored pose) = mirrorCoco(FK)', cocoResidual(mCoco, mirrorCoco(coco)) < 1e-12, e1(cocoResidual(mCoco, mirrorCoco(coco))));
  const W = 64;
  const proj: Projection = { ppu: 40, anchorPx: [27.3, 50.2] };
  let worst = 0;
  let depthWorst = 0;
  for (let i = 0; i < 8; i++) {
    const d = DIRECTIONS[i];
    const dm = DIRECTIONS[(8 - i) % 8]; // θ → −θ
    for (const pitch of [0, 20, 35]) {
      const b = cameraBasis(d, pitch);
      const bm = cameraBasis(dm, pitch);
      SKELETON_LABELS.forEach((l, j) => {
        const [x, y] = toCanvas(coco[j], b, proj);
        const [xm, ym] = toCanvas(mCoco[LABEL_INDEX[mirrorLabel(l)]], bm, proj);
        worst = Math.max(worst, Math.abs(xm / W - (2 * proj.anchorPx[0] / W - x / W)), Math.abs(ym - y));
        depthWorst = Math.max(depthWorst, Math.abs(dot(coco[j], b.ch) - dot(mCoco[LABEL_INDEX[mirrorLabel(l)]], bm.ch)));
      });
    }
  }
  check('mirrored rig + pose projects as x\' = 2a_x/W − x, labels swapped (8 directions × 3 pitches)', worst < 1e-12 && depthWorst < 1e-12, `max err ${e1(worst)}, depth ${e1(depthWorst)}`);
  const cm = calibrate(mirrorCoco(coco));
  check('calibrate(mirrorCoco) is exact', cm.residual < 1e-6, e1(cm.residual));
}

// ---------------------------------------------------------------------------------------------------------------
section('Model, document and generate contract paths');
{
  const meta = createAnimationMeta({ direction: 'east', view: 'high top-down' });
  const again = parseAnimation(JSON.parse(formatJson(serializeAnimation(meta))));
  check('serialize → parse round trip', formatJson(serializeAnimation(again)) === formatJson(serializeAnimation(meta)));
}
{
  // Onion skin: up to N committed poses right before the target, oldest first, no wrap-around
  const st = withFrames(stateFromMeta(createAnimationMeta({ direction: 'south' })), [0, 1, 2, 3, 4].map(() => newFrame(idlePose(tCalib))));
  const fr = st.frames;
  const at = (k: number): { kind: 'frame'; uid: string } => ({ kind: 'frame', uid: fr[k].uid });
  const same = (got: readonly unknown[], want: number[]): boolean => got.length === want.length && want.every((k, j) => got[j] === fr[k].pose);
  check('ghostPoses: REF and frame 1 have none', ghostPoses(st, { kind: 'ref' }, 3).length === 0 && ghostPoses(st, at(0), 3).length === 0);
  check('ghostPoses: count 0, NaN or an unknown frame → none', ghostPoses(st, at(3), 0).length === 0 && ghostPoses(st, at(3), NaN).length === 0 && ghostPoses(st, { kind: 'frame', uid: 'gone' }, 2).length === 0);
  check('ghostPoses: frame 3, count 1 → frame 2', same(ghostPoses(st, at(2), 1), [1]));
  check('ghostPoses: frame 3, count 2 → frames 1, 2 (oldest first)', same(ghostPoses(st, at(2), 2), [0, 1]));
  check('ghostPoses: frame 5, count 3 → frames 2, 3, 4', same(ghostPoses(st, at(4), 3), [1, 2, 3]));
  check('ghostPoses: count past frame 1 stops there (no wrap-around)', same(ghostPoses(st, at(2), 15), [0, 1]) && same(ghostPoses(st, at(4), 15), [0, 1, 2, 3]));
  check('ghostPoses: the committed pose objects (no copies)', ghostPoses(st, at(1), 1)[0] === fr[0].pose);
}
for (const fx of fixtures) {
  const animMeta = createAnimationMeta({ direction: fx.direction, canvas: fx.canvas, action: 'walk' });
  let st = withReferenceImage(stateFromMeta(animMeta), { image: 'fixture0', sourceBaseUid: null, ...fx.canvas });
  const est = withEstimate(st, fx.keypoints);
  st = est.state;
  check(`${fx.name}: withEstimate residual < 1e-6, frame 1 = reference pose`, est.report.calibrationResidual < 1e-6 && st.frames.length === 1, e1(est.report.calibrationResidual));
  st = withFrames(st, [st.frames[0], newFrame(st.frames[0].pose), newFrame(st.frames[0].pose)]);
  const gen = buildGeneration(st, 'test character');
  const errs = validateAnimateRequest(gen.request);
  check(`${fx.name}: generate request passes R8 validation`, errs.length === 0 && !gen.clamped, errs.slice(0, 3).join('; '));
  const est2 = canonicalKeypoints(fx.keypoints)!;
  const xy = Math.max(...gen.request.first_frame_keypoints.map((k, i) => i === COCO.NECK ? 0 : Math.hypot((k.x - est2[i].x) * fx.canvas.width, (k.y - est2[i].y) * fx.canvas.height)));
  check(`${fx.name}: first_frame_keypoints = the estimate (17 joints)`, xy < 1e-6, `${e1(xy)} px`);
  const text = formatJson(serializeAnimation(metaFromState(st, { id: animMeta.id, fps: 12 })));
  const reloaded = parseAnimation(JSON.parse(text));
  check(`${fx.name}: save → load → save is byte-identical`, formatJson(serializeAnimation(reloaded)) === text);
  const rounded = cocoResidual(cocoFromPose(reloaded.reference.pose!, reloaded.rig), reloaded.reference.coco!);
  check(`${fx.name}: saved (6-decimal) rig still reproduces reference.coco`, rounded < 1e-4, e1(rounded));
  const disp = projectPoseForDisplay(st, st.reference.pose!, createProjectScratch());
  const manual = projectPose(st.reference.pose!, st.rig, { basis: cameraBasis(st.direction, st.pitchDeg), projection: st.projection, canvas: fx.canvas, sendDepth: st.sendDepth });
  const dpx = Math.max(...disp.points.map((p, i) => i === COCO.NECK ? 0 : Math.hypot(p[0] - est2[i].x * fx.canvas.width, p[1] - est2[i].y * fx.canvas.height)));
  const sameRanks = disp.ranks.every((r, i) => r === manual.ranks[i] && r === disp.keypoints[i].z_index);
  const sameCanvas = disp.canvas.width === fx.canvas.width && disp.canvas.height === fx.canvas.height;
  check(`${fx.name}: projectPoseForDisplay(REF) = the estimate in canvas px, ranks = projectPose`, dpx < 1e-6 && sameRanks && sameCanvas, `${e1(dpx)} px`);
  // The live COCO-drag projection (raw points, ears → nose head forward) matches the FK one in every direction
  let cpx = 0;
  let cocoRanks = true;
  for (const d of DIRECTIONS) {
    const sd = { ...st, direction: d };
    const a = projectPoseForDisplay(sd, sd.reference.pose!);
    const b = projectCocoForDisplay(sd, cocoFromPose(sd.reference.pose!, sd.rig));
    cpx = Math.max(cpx, ...a.points.map((p, i) => Math.hypot(p[0] - b.points[i][0], p[1] - b.points[i][1])));
    cocoRanks = cocoRanks && a.ranks.every((r, i) => r === b.ranks[i]);
  }
  check(`${fx.name}: projectCocoForDisplay(FK points) = projectPoseForDisplay, 8 directions`, cpx < 1e-9 && cocoRanks, `${e1(cpx)} px`);
}

// ---------------------------------------------------------------------------------------------------------------
section('Performance');
{
  const fxCal = liftCache.get(fixtures[0].name)!.cal;
  const pose = fxCal.pose;
  const calib = fxCal.calib;
  const fkr = createFkResult();
  const coco = createCoco();
  let sink = 0;
  const N = 200000;
  for (let i = 0; i < 20000; i++)
    sink += cocoFromFk(fk(pose, calib, fkr), calib, coco)[0][0];
  const t0 = performance.now();
  for (let i = 0; i < N; i++)
    sink += cocoFromFk(fk(pose, calib, fkr), calib, coco)[0][0];
  const us = ((performance.now() - t0) * 1000) / N;
  check('fk + cocoFromFk (reused buffers) < 20 µs per call', us < 20, `${us.toFixed(2)} µs per call`);
  const same = cocoResidual(coco, cocoFromPose(pose, calib));
  check('buffered fk + cocoFromFk = allocating version', same === 0);
  const scratch = createProjectScratch();
  const ctx: SequenceContext = { basis: cameraBasis('south', 20), projection: liftCache.get(fixtures[0].name)!.lifted.projection, canvas: fixtures[0].canvas, sendDepth: true };
  const M = 50000;
  const t1 = performance.now();
  for (let i = 0; i < M; i++)
    sink += projectPose(pose, calib, ctx, undefined, scratch).ranks[0];
  info(`projectPose (FK + COCO + 18 keypoints) ${(((performance.now() - t1) * 1000) / M).toFixed(2)} µs per call`);
  const t2 = performance.now();
  for (let i = 0; i < 200; i++)
    sink += calibrate(cocoFromPose(pose, calib)).residual;
  info(`calibrate ${(((performance.now() - t2) * 1000) / 200).toFixed(0)} µs per call`);
  const fx = fixtures[1];
  const t3 = performance.now();
  for (let i = 0; i < 20; i++)
    sink += lift({ estimate: fx.keypoints, canvas: fx.canvas, direction: fx.direction, pitchDeg: 20 }).report.ppu;
  info(`lift ${((performance.now() - t3) / 20).toFixed(1)} ms per call${Number.isFinite(sink) ? '' : ' (non-finite!)'}`);
}

console.log(failures ? `\n${failures} check(s) FAILED, ${passes} passed` : `\nAll ${passes} checks passed`);
process.exitCode = failures ? 1 : 0;
