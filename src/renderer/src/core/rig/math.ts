// Small vec3 / quaternion helpers on tuples (three.js conventions: quat = [x, y, z, w], right-handed, Y up).
// Allocation-light: every function takes an optional `out` (which may alias an input) and returns it.
// Hot paths (qMul, qRotate) use indexed access only, so FK runs without temporaries.
import type { Quat, Vec3 } from '@shared/pose';

export { clamp } from '../util/math';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const EPS = 1e-12;

// ---------- vec3 ----------

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];

export function set3(out: Vec3, x: number, y: number, z: number): Vec3 {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export const copy3 = (a: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 => set3(out, a[0], a[1], a[2]);

export const add = (a: Readonly<Vec3>, b: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 => set3(out, a[0] + b[0], a[1] + b[1], a[2] + b[2]);

export const sub = (a: Readonly<Vec3>, b: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 => set3(out, a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const scale = (a: Readonly<Vec3>, s: number, out: Vec3 = [0, 0, 0]): Vec3 => set3(out, a[0] * s, a[1] * s, a[2] * s);

/** a + b·s */
export const addScaled = (a: Readonly<Vec3>, b: Readonly<Vec3>, s: number, out: Vec3 = [0, 0, 0]): Vec3 =>
  set3(out, a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s);

export const negate = (a: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 => set3(out, -a[0], -a[1], -a[2]);

export const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Readonly<Vec3>, b: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 =>
  set3(out, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);

export const lenSq = (a: Readonly<Vec3>): number => dot(a, a);

export const len = (a: Readonly<Vec3>): number => Math.sqrt(dot(a, a));

export const dist = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Unit vector; returns `fallback` (default +Y) for a (near) zero vector. */
export function norm(a: Readonly<Vec3>, out: Vec3 = [0, 0, 0], fallback: Readonly<Vec3> = [0, 1, 0]): Vec3 {
  const l = len(a);
  if (l < EPS)
    return copy3(fallback, out);
  return scale(a, 1 / l, out);
}

export const lerp = (a: Readonly<Vec3>, b: Readonly<Vec3>, t: number, out: Vec3 = [0, 0, 0]): Vec3 =>
  set3(out, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);

export const mid = (a: Readonly<Vec3>, b: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 => lerp(a, b, 0.5, out);

/** Component of v perpendicular to the UNIT axis: v − (v·axis)·axis. */
export const perp = (v: Readonly<Vec3>, axis: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 => addScaled(v, axis, -dot(v, axis), out);

/** Unsigned angle between two vectors, radians 0..π (0 for a zero vector). */
export function angleBetween(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const c = cross(a, b);
  return Math.atan2(len(c), dot(a, b));
}

/** Rotate v about world +Y by `angle` radians (right-hand rule): R_y(angle)·v. */
export function rotateY(v: Readonly<Vec3>, angle: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return set3(out, c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]);
}

// ---------- quaternion ----------

export function setQ(out: Quat, x: number, y: number, z: number, w: number): Quat {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
}

export const qCopy = (q: Readonly<Quat>, out: Quat = [0, 0, 0, 1]): Quat => setQ(out, q[0], q[1], q[2], q[3]);

/** a·b: rotate by b first, then a (three.js multiplyQuaternions). */
export function qMul(a: Readonly<Quat>, b: Readonly<Quat>, out: Quat = [0, 0, 0, 1]): Quat {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** Conjugate = inverse for unit quaternions. */
export const qConj = (q: Readonly<Quat>, out: Quat = [0, 0, 0, 1]): Quat => setQ(out, -q[0], -q[1], -q[2], q[3]);

/** a⁻¹·b for unit a (the local rotation of b in a's frame), without a temporary. */
export function qMulConjA(a: Readonly<Quat>, b: Readonly<Quat>, out: Quat = [0, 0, 0, 1]): Quat {
  const ax = -a[0], ay = -a[1], az = -a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export const qDot = (a: Readonly<Quat>, b: Readonly<Quat>): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

export function qNormalize(q: Readonly<Quat>, out: Quat = [0, 0, 0, 1]): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (l < EPS)
    return setQ(out, 0, 0, 0, 1);
  return setQ(out, q[0] / l, q[1] / l, q[2] / l, q[3] / l);
}

/** Rotate v by unit q (q·v·q*). */
export function qRotate(q: Readonly<Quat>, v: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + qy * tz - qz * ty;
  out[1] = vy + qw * ty + qz * tx - qx * tz;
  out[2] = vz + qw * tz + qx * ty - qy * tx;
  return out;
}

/** Rotate v by the inverse of unit q (q*·v·q). */
export function qRotateInv(q: Readonly<Quat>, v: Readonly<Vec3>, out: Vec3 = [0, 0, 0]): Vec3 {
  const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + qy * tz - qz * ty;
  out[1] = vy + qw * ty + qz * tx - qx * tz;
  out[2] = vz + qw * tz + qx * ty - qy * tx;
  return out;
}

/** Right-hand rotation of `angle` radians about `axis` (normalized internally). */
export function qFromAxisAngle(axis: Readonly<Vec3>, angle: number, out: Quat = [0, 0, 0, 1]): Quat {
  const l = len(axis);
  if (l < EPS)
    return setQ(out, 0, 0, 0, 1);
  const s = Math.sin(angle / 2) / l;
  return setQ(out, axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2));
}

/** Rotation about world +Y (yaw). */
export const qYaw = (angle: number, out: Quat = [0, 0, 0, 1]): Quat => setQ(out, 0, Math.sin(angle / 2), 0, Math.cos(angle / 2));

/** Shortest-arc rotation taking unit a onto unit b (three.js setFromUnitVectors; antiparallel picks a perpendicular axis). */
export function qFromUnitVectors(a: Readonly<Vec3>, b: Readonly<Vec3>, out: Quat = [0, 0, 0, 1]): Quat {
  let r = dot(a, b) + 1;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(a[0]) > Math.abs(a[2]))
      setQ(out, -a[1], a[0], 0, r);
    else
      setQ(out, 0, -a[2], a[1], r);
  } else
    setQ(out, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], r);
  return qNormalize(out, out);
}

/** Spherical interpolation along the shortest path; t = 0 → a, 1 → b. */
export function qSlerp(a: Readonly<Quat>, b: Readonly<Quat>, t: number, out: Quat = [0, 0, 0, 1]): Quat {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = qDot(a, b);
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let ka = 1 - t;
  let kb = t;
  if (cos < 1 - 1e-9) {
    const theta = Math.acos(Math.min(1, cos));
    const s = Math.sin(theta);
    ka = Math.sin((1 - t) * theta) / s;
    kb = Math.sin(t * theta) / s;
  }
  setQ(out, a[0] * ka + bx * kb, a[1] * ka + by * kb, a[2] * ka + bz * kb, a[3] * ka + bw * kb);
  return qNormalize(out, out);
}

/** slerp(identity, q, t) along the shortest path; robust near identity (q^t). */
export function qPow(q: Readonly<Quat>, t: number, out: Quat = [0, 0, 0, 1]): Quat {
  const sgn = q[3] < 0 ? -1 : 1;
  const x = q[0] * sgn, y = q[1] * sgn, z = q[2] * sgn, w = q[3] * sgn;
  const sv = Math.hypot(x, y, z);
  if (sv < 1e-15)
    return setQ(out, 0, 0, 0, 1);
  const half = Math.atan2(sv, w) * t;
  const k = Math.sin(half) / sv;
  return setQ(out, x * k, y * k, z * k, Math.cos(half));
}

/**
 * Swing-twist split q = swing·twist about the UNIT `axis`: twist turns about the axis, swing about an axis
 * perpendicular to it (the shortest arc taking `axis` to q·axis). A 180° swing (no twist part) gives twist = identity.
 */
export function qSwingTwist(q: Readonly<Quat>, axis: Readonly<Vec3>): { swing: Quat; twist: Quat } {
  const p = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
  const tx = axis[0] * p, ty = axis[1] * p, tz = axis[2] * p;
  const l = Math.hypot(tx, ty, tz, q[3]);
  const twist: Quat = l < 1e-9 ? [0, 0, 0, 1] : [tx / l, ty / l, tz / l, q[3] / l];
  const swing = qNormalize(qMul(q, qConj(twist)));
  return { swing, twist };
}

/** Rotation whose matrix has COLUMNS X, Y, Z (orthonormal, right-handed: Z = X × Y). */
export function qFromBasis(X: Readonly<Vec3>, Y: Readonly<Vec3>, Z: Readonly<Vec3>, out: Quat = [0, 0, 0, 1]): Quat {
  const m11 = X[0], m21 = X[1], m31 = X[2];
  const m12 = Y[0], m22 = Y[1], m32 = Y[2];
  const m13 = Z[0], m23 = Z[1], m33 = Z[2];
  const tr = m11 + m22 + m33;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return setQ(out, (m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return setQ(out, 0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return setQ(out, (m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return setQ(out, (m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
}

/** Rotation angle in radians, 0..π (atan2 form: accurate for tiny angles too). */
export const qAngle = (q: Readonly<Quat>): number => 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));

/** Angle of the relative rotation a⁻¹·b, radians 0..π (sign-insensitive). */
export const qAngleBetween = (a: Readonly<Quat>, b: Readonly<Quat>): number => qAngle(qMulConjA(a, b));

// ---------- rotation fit ----------

/** Eigenvector of the largest eigenvalue of a symmetric 4×4 matrix (cyclic Jacobi). `a` is overwritten. */
function maxEigenvectorSym4(a: number[][]): number[] {
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  let scaleSq = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++)
      scaleSq += a[i][j] * a[i][j];
  }
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++)
        off += a[p][q] * a[p][q];
    }
    if (off <= 1e-30 * scaleSq || off === 0)
      break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-300)
          continue;
        const theta = (a[q][q] - a[p][p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          if (k === p || k === q)
            continue;
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = a[p][k] = c * akp - s * akq;
          a[k][q] = a[q][k] = s * akp + c * akq;
        }
        a[p][p] -= t * apq;
        a[q][q] += t * apq;
        a[p][q] = a[q][p] = 0;
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) {
    if (a[i][i] > a[best][best])
      best = i;
  }
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * Weighted, centred rotation fit (Kabsch via Horn's quaternion method): the unit quaternion R minimizing
 * Σ w_k |R·(src_k − src̄) − (dst_k − dst̄)|². `prior` (weight priorWeight × the data spread) regularizes degenerate
 * sets (collinear or coincident points) and is returned when the weights or the spread vanish.
 */
export function fitRotation(src: readonly Readonly<Vec3>[], dst: readonly Readonly<Vec3>[], weights: readonly number[], prior: Readonly<Quat>, priorWeight = 1e-4, out: Quat = [0, 0, 0, 1]): Quat {
  let wSum = 0;
  const cs: Vec3 = [0, 0, 0];
  const cd: Vec3 = [0, 0, 0];
  for (let k = 0; k < src.length; k++) {
    const w = Math.max(0, weights[k] ?? 1);
    wSum += w;
    addScaled(cs, src[k], w, cs);
    addScaled(cd, dst[k], w, cd);
  }
  if (wSum < 1e-9)
    return qCopy(prior, out);
  scale(cs, 1 / wSum, cs);
  scale(cd, 1 / wSum, cd);
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let spread = 0;
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [0, 0, 0];
  for (let k = 0; k < src.length; k++) {
    const w = Math.max(0, weights[k] ?? 1);
    sub(src[k], cs, a);
    sub(dst[k], cd, b);
    spread += w * Math.sqrt(lenSq(a) * lenSq(b));
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++)
        S[i][j] += w * a[i] * b[j];
    }
  }
  if (spread < 1e-18)
    return qCopy(prior, out);
  // Prior pairs e_m → prior·e_m
  const lam = priorWeight * spread;
  const e: Vec3 = [0, 0, 0];
  for (let m = 0; m < 3; m++) {
    set3(e, m === 0 ? 1 : 0, m === 1 ? 1 : 0, m === 2 ? 1 : 0);
    qRotate(prior, e, b);
    for (let j = 0; j < 3; j++)
      S[m][j] += lam * b[j];
  }
  const [[sxx, sxy, sxz], [syx, syy, syz], [szx, szy, szz]] = S;
  const N = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz]
  ];
  const q = maxEigenvectorSym4(N);
  return qNormalize(setQ(out, q[1], q[2], q[3], q[0]), out);
}
