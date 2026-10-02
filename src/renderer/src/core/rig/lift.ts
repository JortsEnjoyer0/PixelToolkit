// Lifting (PLAN §4.6): 2D estimate → canonical 3D reference COCO points + the projection that reproduces it.
// Every joint keeps its estimated 2D position exactly (NECK = the 2D shoulder midpoint); lifting only chooses the
// camera depth d_c of each joint, from the canonical template (torso yaw δ, width scale k), the limb-length rule and
// the estimate's z_index layers.
import { canonicalKeypoints, type Direction, type KeypointOut } from '@shared/pixellab';
import { FACE_LABELS, type FaceLabel, type Vec3 } from '@shared/pose';
import type { Projection } from '../model';
import { COCO, LABEL_INDEX, mirrorLabel } from './coco';
import { cocoFromFk, fk } from './fk';
import { DEG, EPS, RAD, add, dist, dot, mid, rotateY, sub } from './math';
import { idlePose, templateCalibration } from './poses';
import { cameraBasis, fromCanvas, toCanvas, translateAnchor, type CameraBasis } from './projection';
import { BONE_INDEX, TEMPLATE } from './rigDef';

export interface LiftInput {
  /** estimate-skeleton keypoints (any order, float z_index). */
  estimate: readonly KeypointOut[];
  /** Canvas the estimate was made on (the padded reference). */
  canvas: { width: number; height: number };
  direction: Direction;
  pitchDeg: number;
}

/** How a limb bone's depth sign was chosen (PLAN §4.6 step 5): z_index order, template prior, joint plausibility. */
export type DepthRule = 'zIndex' | 'template' | 'plausibility' | 'flat';

export interface LiftReport {
  /** |estimated NECK − 2D shoulder midpoint| in canvas px (NECK is forced to the midpoint). */
  neckResidualPx: number;
  /** Max reprojection error over the 17 non-NECK joints, px (target < 1e-6). */
  maxResidualPx: number;
  /** Fitted relative torso yaw δ in degrees (canonical space, about the hip centre). */
  torsoYawDeg: number;
  /** Fitted head yaw ψ_h in degrees (canonical space; equals torsoYawDeg when the face is hidden). */
  headYawDeg: number;
  /** Shoulder / hip width scale k relative to the template. */
  widthScale: number;
  /** s_char: lifted torso length / template torso length (world units). */
  charScale: number;
  /** Canvas px per world unit of the result. */
  ppu: number;
  /** Depth-sign rule used per limb bone, keyed "<parent label>→<child label>". */
  limbRules: Record<string, DepthRule>;
  warnings: string[];
}

export interface LiftResult {
  /** 18 canonical 3D points: hip centre at X = Z = 0, lowest ankle at the template ankle height × s_char. */
  coco: Vec3[];
  /** Projection that maps `coco` back onto the estimate. */
  projection: Projection;
  /** Kabsch weights for calibrate(): 1 visible, 0.25 hidden (lowest face z_index, or within 1 px of its mirror point). */
  faceWeights: Record<FaceLabel, number>;
  report: LiftReport;
}

/** Face visibility weights from the 2D estimate (PLAN §4.4 step 5). */
export function faceWeightsFromEstimate(kps: readonly KeypointOut[], canvas: { width: number; height: number }): Record<FaceLabel, number> {
  const byLabel = new Map(kps.map((k) => [k.label, k]));
  const face = FACE_LABELS.map((l) => byLabel.get(l)!);
  const minZ = Math.min(...face.map((k) => k.z_index));
  const maxZ = Math.max(...face.map((k) => k.z_index));
  const out = {} as Record<FaceLabel, number>;
  for (const k of face) {
    const twin = byLabel.get(mirrorLabel(k.label))!;
    const nearTwin = twin !== k && Math.hypot((k.x - twin.x) * canvas.width, (k.y - twin.y) * canvas.height) <= 1;
    const lowest = maxZ > minZ && k.z_index === minZ;
    out[k.label as FaceLabel] = lowest || (nearTwin && k.z_index < twin.z_index) ? 0.25 : 1;
  }
  return out;
}

// ---------- tuning (2D noise and priors of the torso / head yaw fits) ----------

/** Expected 2D noise of an estimated joint, canvas px. */
const SIGMA_PX = 1.5;
/** Torso yaw prior (radians) and limit (PLAN: δ ∈ [−60°, 60°]). */
const SIGMA_YAW = 40 * DEG;
const YAW_LIMIT = 60;
/** ln(k) prior: chibi shoulder / hip widths vary roughly ±25% around the template. */
const SIGMA_LN_K = 0.25;
const K_MIN = 0.4;
const K_MAX = 2.0;
/** Head yaw prior relative to the torso, and the search half-range. */
const SIGMA_HEAD = 45 * DEG;
const HEAD_RANGE = 80;
/** A template bone that keeps at least this fraction of its length in 2D "shows clearly" (PLAN §4.6 step 5). */
const RHO_CLEAR = 0.6;
/** z_index layers this far apart order two joints; nearer = higher (estimate convention, nearest = 0). */
const Z_STEP = 0.5;
/** L/R z_index difference that gives the torso yaw a sign (PLAN: at least 1). */
const Z_SIDE = 1;

const TORSO = [COCO.L_SHOULDER, COCO.R_SHOULDER, COCO.L_HIP, COCO.R_HIP] as const;
const FACE = FACE_LABELS.map((l) => LABEL_INDEX[l]);
type BoneKind = 'upper' | 'lower' | 'thigh' | 'shin';
/** Limb chains, parent → child, with the joint-plausibility kind of each bone. */
const CHAINS: readonly (readonly [number, number, BoneKind])[][] = [
  [[COCO.R_SHOULDER, COCO.R_ELBOW, 'upper'], [COCO.R_ELBOW, COCO.R_WRIST, 'lower']],
  [[COCO.L_SHOULDER, COCO.L_ELBOW, 'upper'], [COCO.L_ELBOW, COCO.L_WRIST, 'lower']],
  [[COCO.R_HIP, COCO.R_KNEE, 'thigh'], [COCO.R_KNEE, COCO.R_ANKLE, 'shin']],
  [[COCO.L_HIP, COCO.L_KNEE, 'thigh'], [COCO.L_KNEE, COCO.L_ANKLE, 'shin']]
];

interface TemplateData {
  /** Canonical idle pose COCO points (not yawed). */
  coco: Vec3[];
  hip: Vec3;
  /** Head bone head − NECK (the template neck vector). */
  neckVec: Vec3;
}

let templateCache: TemplateData | null = null;

function templateData(): TemplateData {
  if (!templateCache) {
    const calib = templateCalibration();
    const fkr = fk(idlePose(calib), calib);
    const coco = cocoFromFk(fkr, calib);
    templateCache = { coco, hip: mid(coco[COCO.L_HIP], coco[COCO.R_HIP]), neckVec: sub(fkr.pos[BONE_INDEX.Head], coco[COCO.NECK]) };
  }
  return templateCache;
}

type P2 = [number, number];

/** Screen (right, up) components of a world vector. */
const screen = (v: Readonly<Vec3>, b: CameraBasis): P2 => [dot(v, b.r), dot(v, b.u)];

interface TorsoEval { s: number; err: number; spread: number }

/**
 * Template torso (4 points about the template hip centre, lateral × k, yawed δ) vs the observed points (screen-up px,
 * centred): best scale s (px per template unit) and the squared residual.
 */
function evalTorso(obs: readonly P2[], rel: readonly Vec3[], delta: number, k: number, b: CameraBasis): TorsoEval {
  const M: P2[] = rel.map((q) => screen(rotateY([q[0] * k, q[1], q[2]], delta), b));
  const cx = M.reduce((a, m) => a + m[0], 0) / M.length;
  const cy = M.reduce((a, m) => a + m[1], 0) / M.length;
  let num = 0;
  let spread = 0;
  for (let j = 0; j < M.length; j++) {
    M[j][0] -= cx;
    M[j][1] -= cy;
    num += obs[j][0] * M[j][0] + obs[j][1] * M[j][1];
    spread += M[j][0] * M[j][0] + M[j][1] * M[j][1];
  }
  const s = spread > 1e-18 ? num / spread : 0;
  if (!(s > 0))
    return { s, err: Infinity, spread };
  let err = 0;
  for (let j = 0; j < M.length; j++)
    err += (obs[j][0] - s * M[j][0]) ** 2 + (obs[j][1] - s * M[j][1]) ** 2;
  return { s, err, spread };
}

interface TorsoFit { delta: number; k: number; s: number; spread: number }

/** PLAN §4.6 step 3: torso yaw δ jointly with the width scale k, priors on δ and ln k, sign from the L/R z_index. */
function fitTorso(px: readonly P2[], z: readonly number[], b: CameraBasis, tpl: TemplateData, warnings: string[]): TorsoFit {
  const obsRaw: P2[] = TORSO.map((j) => [px[j][0], -px[j][1]]);
  const ox = obsRaw.reduce((a, o) => a + o[0], 0) / obsRaw.length;
  const oy = obsRaw.reduce((a, o) => a + o[1], 0) / obsRaw.length;
  const obs = obsRaw.map((o): P2 => [o[0] - ox, o[1] - oy]);
  const rel = TORSO.map((j) => sub(tpl.coco[j], tpl.hip));
  const theta = b.thetaDeg * DEG;
  // Nearer = higher z: zSide > 0 means the RIGHT side is nearer, i.e. sin(θ + δ) > 0
  const zSide = (z[COCO.R_SHOULDER] + z[COCO.R_HIP] - z[COCO.L_SHOULDER] - z[COCO.L_HIP]) / 2;
  const frontal = b.thetaDeg % 180 === 0;
  let sign = Math.abs(zSide) >= Z_SIDE ? Math.sign(zSide) : 0;
  const deltas: number[] = [];
  if (frontal && sign === 0)
    deltas.push(0);
  else {
    for (let d = -YAW_LIMIT; d <= YAW_LIMIT; d++)
      deltas.push(d * DEG);
  }
  const allowed = (d: number): boolean => sign === 0 || sign * Math.sin(theta + d) >= 0.05;
  if (sign !== 0 && !deltas.some(allowed)) {
    warnings.push('The estimate\'s LEFT/RIGHT z_index contradicts the direction; the torso yaw ignores it');
    sign = 0;
  }
  const n = TORSO.length;
  const score = (e: TorsoEval, d: number, k: number): number =>
    e.err / (n * SIGMA_PX * SIGMA_PX) + (d / SIGMA_YAW) ** 2 + (Math.log(k) / SIGMA_LN_K) ** 2;
  let best = { delta: 0, k: 1, score: Infinity, e: evalTorso(obs, rel, 0, 1, b) };
  const tryAt = (d: number, k: number): void => {
    if (k < K_MIN || k > K_MAX || Math.abs(d) > YAW_LIMIT * DEG + EPS || !allowed(d) || (frontal && sign === 0 && d !== 0))
      return;
    const e = evalTorso(obs, rel, d, k, b);
    const sc = score(e, d, k);
    if (sc < best.score)
      best = { delta: d, k, score: sc, e };
  };
  const kSteps = 80;
  for (const d of deltas) {
    for (let i = 0; i <= kSteps; i++)
      tryAt(d, K_MIN * (K_MAX / K_MIN) ** (i / kSteps));
  }
  // Local refinement: shrinking grids around the best cell
  let dStep = 1 * DEG;
  let kStep = (K_MAX / K_MIN) ** (1 / kSteps);
  for (let pass = 0; pass < 4; pass++) {
    dStep /= 8;
    kStep = Math.pow(kStep, 1 / 8);
    const d0 = best.delta;
    const k0 = best.k;
    for (let i = -8; i <= 8; i++) {
      for (let j = -8; j <= 8; j++)
        tryAt(d0 + i * dStep, k0 * kStep ** j);
    }
  }
  if (!Number.isFinite(best.score) || !(best.e.s > 0)) {
    warnings.push('The torso could not be fitted; template framing is used');
    return { delta: 0, k: 1, s: 0, spread: 0 };
  }
  if (Math.abs(best.delta) > (YAW_LIMIT - 0.5) * DEG)
    warnings.push(`The torso yaw hit the ±${YAW_LIMIT}° search limit`);
  if (best.k <= K_MIN * 1.001 || best.k >= K_MAX * 0.999)
    warnings.push(`The torso width scale hit its limit (k = ${best.k.toFixed(2)})`);
  return { delta: best.delta, k: best.k, s: best.e.s, spread: best.e.spread };
}

interface FaceFit { psi: number; h: number }

/** PLAN §4.6 step 7: head yaw ψ_h with the face's 2D offset and scale h (px per template unit) by weighted least squares. */
function fitFace(px: readonly P2[], w: readonly number[], delta: number, b: CameraBasis, fallbackH: number): FaceFit {
  const obs: P2[] = FACE.map((j) => [px[j][0], -px[j][1]]);
  const wSum = w.reduce((a, v) => a + v, 0);
  const evalAt = (psi: number): { h: number; err: number } => {
    const a: P2[] = FACE_LABELS.map((k) => screen(rotateY(TEMPLATE.face[k], psi), b));
    let ax = 0, ay = 0, ox = 0, oy = 0;
    for (let k = 0; k < a.length; k++) {
      ax += w[k] * a[k][0];
      ay += w[k] * a[k][1];
      ox += w[k] * obs[k][0];
      oy += w[k] * obs[k][1];
    }
    ax /= wSum;
    ay /= wSum;
    ox /= wSum;
    oy /= wSum;
    let num = 0, den = 0;
    for (let k = 0; k < a.length; k++) {
      num += w[k] * ((obs[k][0] - ox) * (a[k][0] - ax) + (obs[k][1] - oy) * (a[k][1] - ay));
      den += w[k] * ((a[k][0] - ax) ** 2 + (a[k][1] - ay) ** 2);
    }
    const h = den > 1e-18 ? num / den : 0;
    if (!(h > 0))
      return { h, err: Infinity };
    let err = 0;
    for (let k = 0; k < a.length; k++)
      err += w[k] * ((obs[k][0] - ox - h * (a[k][0] - ax)) ** 2 + (obs[k][1] - oy - h * (a[k][1] - ay)) ** 2);
    return { h, err };
  };
  // A face turned away from the camera (north-ish) is hidden: ψ_h = torso yaw
  const away = dot(rotateY([0, 0, 1], delta), b.ch) < -0.5;
  if (away || wSum < 1e-6) {
    const e = evalAt(delta);
    return { psi: delta, h: e.h > 0 ? e.h : fallbackH };
  }
  let best = { psi: delta, h: fallbackH, score: Infinity };
  const tryAt = (psi: number): void => {
    const e = evalAt(psi);
    const sc = e.err / (wSum * SIGMA_PX * SIGMA_PX) + ((psi - delta) / SIGMA_HEAD) ** 2;
    if (sc < best.score)
      best = { psi, h: e.h, score: sc };
  };
  for (let d = -HEAD_RANGE; d <= HEAD_RANGE; d++)
    tryAt(delta + d * DEG);
  let step = 1 * DEG;
  for (let pass = 0; pass < 4; pass++) {
    step /= 8;
    const p0 = best.psi;
    for (let i = -8; i <= 8; i++)
      tryAt(p0 + i * step);
  }
  return Number.isFinite(best.score) ? { psi: best.psi, h: best.h } : { psi: delta, h: fallbackH };
}

/**
 * Lift the 2D estimate (PLAN §4.6). The canonical template is projected with basis(θ, φ) and is never yawed by θ; a
 * relative torso yaw δ is fitted instead. Throws unless all 18 labels exist.
 */
export function lift(input: LiftInput): LiftResult {
  const kps = canonicalKeypoints(input.estimate);
  if (!kps)
    throw new Error('lift: the estimate must contain each of the 18 labels exactly once');
  const { width: W, height: H } = input.canvas;
  const b = cameraBasis(input.direction, input.pitchDeg);
  const warnings: string[] = [];
  const tpl = templateData();
  const px: P2[] = kps.map((k) => [k.x * W, k.y * H]);
  const neckEst = px[COCO.NECK];
  px[COCO.NECK] = [(px[COCO.L_SHOULDER][0] + px[COCO.R_SHOULDER][0]) / 2, (px[COCO.L_SHOULDER][1] + px[COCO.R_SHOULDER][1]) / 2];
  const z = kps.map((k) => k.z_index);
  const sinP = Math.sin(b.pitchDeg * DEG);
  const cosP = Math.cos(b.pitchDeg * DEG);

  // Steps 2–3: torso yaw δ and width scale k
  const torso = fitTorso(px, z, b, tpl, warnings);
  const { delta, k } = torso;
  const s = torso.s > 0 ? torso.s : 0.8 * H; // fallback: the ~1.0-tall template over 80% of the canvas

  // Step 4: ppu by least squares over the torso and the limb bones that show clearly in 2D
  let num = s * torso.spread;
  let den = torso.spread;
  for (const chain of CHAINS) {
    for (const [p, c] of chain) {
      const vt = rotateY(sub(tpl.coco[c], tpl.coco[p]), delta);
      const Lt = Math.hypot(vt[0], vt[1], vt[2]);
      const mu = Math.hypot(...screen(vt, b));
      const m = Math.hypot(px[c][0] - px[p][0], px[c][1] - px[p][1]);
      if (Lt > 1e-9 && mu / Lt >= RHO_CLEAR && m / mu >= 0.6 * s && m / mu <= 1.6 * s) {
        num += m * mu;
        den += mu * mu;
      }
    }
  }
  const ppu = den > 1e-18 ? num / den : s;
  const g = s / ppu; // torso world scale vs the template

  // Step 6: torso depths from the template at δ (camera depth d_c), hip centre at depth 0
  const dc = new Array<number>(18).fill(0);
  for (const j of TORSO) {
    const q = sub(tpl.coco[j], tpl.hip);
    dc[j] = g * dot(rotateY([q[0] * k, q[1], q[2]], delta), b.c);
  }
  dc[COCO.NECK] = (dc[COCO.L_SHOULDER] + dc[COCO.R_SHOULDER]) / 2;

  // Step 5: limb depths parent → child
  const fwd = rotateY([0, 0, 1], delta);
  const cf = dot(b.c, fwd);
  const limbRules: Record<string, DepthRule> = {};
  for (const chain of CHAINS) {
    for (const [p, c, kind] of chain) {
      const sx = (px[c][0] - px[p][0]) / ppu;
      const sy = -(px[c][1] - px[p][1]) / ppu;
      const m = Math.hypot(sx, sy);
      const vt = rotateY(sub(tpl.coco[c], tpl.coco[p]), delta);
      const Lt = Math.hypot(vt[0], vt[1], vt[2]);
      const rho = Lt > EPS ? Math.hypot(...screen(vt, b)) / Lt : 1;
      let Lb: number;
      let D: number;
      if (rho >= RHO_CLEAR) {
        Lb = m / rho;
        D = m * Math.sqrt(Math.max(0, 1 / (rho * rho) - 1));
      } else {
        Lb = Lt * g;
        D = Math.sqrt(Math.max(0, Lb * Lb - m * m));
      }
      let sigma = 0;
      let rule: DepthRule = 'flat';
      if (D > EPS) {
        // 1. z_index order (child vs parent), judged on horizontal depth d_h = Δd_c·cosφ − sy·sinφ
        const dz = z[c] - z[p];
        if (Math.abs(dz) >= Z_STEP) {
          const want = Math.sign(dz);
          const tol = 0.15 * Math.max(Lb, m);
          const ok = [1, -1].map((sg) => want * (sg * D * cosP - sy * sinP) > -tol);
          if (ok[0] !== ok[1]) {
            sigma = ok[0] ? 1 : -1;
            rule = 'zIndex';
          }
        }
        // 2. the template prior (in the ρ ≥ 0.6 branch D reproduces the template's own out-of-plane angle)
        const tDc = dot(vt, b.c);
        if (sigma === 0 && Math.abs(tDc) > 1e-9 * Lt) {
          sigma = Math.sign(tDc);
          rule = 'template';
        }
        // 3. plausibility for a template bone exactly in the image plane: limbs reach forward, the shin goes back
        if (sigma === 0) {
          const forward = cf >= 0 ? 1 : -1;
          sigma = kind === 'shin' ? -forward : forward;
          rule = 'plausibility';
        }
      }
      dc[c] = dc[p] + sigma * D;
      limbRules[`${kps[p].label}→${kps[c].label}`] = rule;
    }
  }

  // Step 7: face depths from the head yaw fit; head origin depth = NECK d_c + (template neck vector)·c
  const faceWeights = faceWeightsFromEstimate(kps, input.canvas);
  const face = fitFace(px, FACE_LABELS.map((l) => faceWeights[l]), delta, b, s);
  const hWorld = face.h / ppu;
  const dHead = dc[COCO.NECK] + g * dot(tpl.neckVec, b.c);
  FACE_LABELS.forEach((l, f) => {
    dc[FACE[f]] = dHead + hWorld * dot(rotateY(TEMPLATE.face[l], face.psi), b.c);
  });

  // Step 8: back to world, hip centre to X = Z = 0, lowest ankle at the ankle height; anchor follows the translation
  const hip2d: P2 = [(px[COCO.L_HIP][0] + px[COCO.R_HIP][0]) / 2, (px[COCO.L_HIP][1] + px[COCO.R_HIP][1]) / 2];
  const proj0: Projection = { ppu, anchorPx: hip2d };
  const P = px.map(([x, y], i) => fromCanvas(x, y, dc[i], b, proj0));
  const hip = mid(P[COCO.L_HIP], P[COCO.R_HIP]);
  const charScale = dist(P[COCO.NECK], hip) / TEMPLATE.torso;
  const lowAnkle = Math.min(P[COCO.L_ANKLE][1], P[COCO.R_ANKLE][1]);
  const T: Vec3 = [-hip[0], TEMPLATE.ankleHeight * charScale - lowAnkle, -hip[2]];
  const coco = P.map((p) => add(p, T));
  const projection = translateAnchor(proj0, T, b);

  // Step 9: the 17 non-NECK joints reproject exactly
  let maxResidualPx = 0;
  coco.forEach((p, i) => {
    if (i === COCO.NECK)
      return;
    const [x, y] = toCanvas(p, b, projection);
    maxResidualPx = Math.max(maxResidualPx, Math.hypot(x - px[i][0], y - px[i][1]));
  });
  if (!(maxResidualPx < 1e-6))
    warnings.push(`Lift reprojection error ${maxResidualPx.toExponential(2)} px exceeds 1e-6`);
  return {
    coco,
    projection,
    faceWeights,
    report: {
      neckResidualPx: Math.hypot(neckEst[0] - px[COCO.NECK][0], neckEst[1] - px[COCO.NECK][1]),
      maxResidualPx,
      torsoYawDeg: delta * RAD,
      headYawDeg: face.psi * RAD,
      widthScale: k,
      charScale,
      ppu,
      limbRules,
      warnings
    }
  };
}
