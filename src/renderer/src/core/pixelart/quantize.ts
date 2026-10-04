// Colour quantizer for Rectify To Grid's "Max colours" (docs/img2pixel/img2pixel.md "Algorithm"): reduces a finished
// pixel-art image to at most N opaque colours. Weighted k-means in OKLab (perceptual distances) over the image's
// unique colours, seeded deterministically (most frequent colour, then the colour with the largest count x squared
// distance to the chosen ones), so the same image always gets the same palette. Above MAX_CLUSTER_COLOURS unique
// colours the clustering runs on coarse colour bins (bounded cost) and every colour then maps to its nearest centre.
// Transparent pixels are untouched; a `keep` colour (the solid background when it is kept) stays exact and takes one
// palette slot. Framework-free; tested by scripts/test-pixelart.ts.
import type { RgbaImage } from '@shared/image';

/** The "Max colours" settings, in slider order: 0 = no limit. */
export const COLOR_LIMITS: readonly number[] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 128, 256];

/** Lloyd iterations at most (assignments usually settle much earlier), and the centre movement that counts as settled. */
const MAX_ITERATIONS = 24;
const SETTLED = 1e-5;
/** More unique colours than this are clustered as coarse bins (BIN_BITS per channel) to bound the cost. */
const MAX_CLUSTER_COLOURS = 4096;
const BIN_BITS = 4;

type Rgb = [number, number, number];

/** The COLOR_LIMITS entry for `n`: 0 (no limit) for zero, negative or invalid values, else the nearest real limit. */
export function snapColorLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0)
    return 0;
  const limits = COLOR_LIMITS.filter((v) => v > 0);
  if (n >= limits[limits.length - 1])
    return limits[limits.length - 1];
  let best = limits[0];
  for (const v of limits) {
    if (Math.abs(v - n) < Math.abs(best - n))
      best = v;
  }
  return best;
}

const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const toSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
};

/** sRGB 0..255 → OKLab (Björn Ottosson's matrices). */
function toOklab(r: number, g: number, b: number, out: Float64Array, i: number): void {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[i] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[i + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[i + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

/** OKLab → sRGB 0..255 (rounded, clamped). */
function fromOklab(L: number, a: number, b: number): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ];
}

/**
 * `img` with at most `maxColors` opaque colours (a new image; `img` itself when nothing needs to change: maxColors 0,
 * or no more colours than that). Pixels with alpha 0 are left as they are. `keep` (when present in the image) is kept
 * exactly and counts toward the limit.
 */
export function quantizeColors(img: RgbaImage, maxColors: number, keep: Rgb | null = null): RgbaImage {
  const limit = Math.floor(maxColors);
  if (!(limit > 0))
    return img;
  const px = img.data;
  const counts = new Map<number, number>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0)
      continue;
    const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size <= limit)
    return img;
  const keepKey = keep ? (keep[0] << 16) | (keep[1] << 8) | keep[2] : -1;
  const kept = counts.has(keepKey);
  const k = limit - (kept ? 1 : 0);
  // The colours to cluster (everything but `keep`), heaviest first so ties resolve the same way every time
  const keys = [...counts.keys()].filter((key) => key !== keepKey).sort((p, q) => counts.get(q)! - counts.get(p)! || p - q);
  const n = keys.length;
  const lab = new Float64Array(n * 3);
  const weight = new Float64Array(n);
  keys.forEach((key, i) => {
    toOklab((key >> 16) & 255, (key >> 8) & 255, key & 255, lab, i * 3);
    weight[i] = counts.get(key)!;
  });
  const mapped = new Map<number, Rgb>();
  if (k < 1) {
    // The kept colour fills the only slot
    for (const key of keys)
      mapped.set(key, keep as Rgb);
  } else {
    const set = n > MAX_CLUSTER_COLOURS ? binColours(keys, lab, weight) : { lab, weight };
    const centres = seedCentres(set.lab, set.weight, Math.min(k, set.weight.length));
    lloyd(set.lab, set.weight, centres);
    const palette: Rgb[] = [];
    for (let c = 0; c < centres.length / 3; c++)
      palette.push(fromOklab(centres[c * 3], centres[c * 3 + 1], centres[c * 3 + 2]));
    keys.forEach((key, i) => mapped.set(key, palette[nearestCentre(lab, i, centres)]));
  }
  const data = new Uint8Array(px);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0)
      continue;
    const to = mapped.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    if (to) {
      data[i] = to[0];
      data[i + 1] = to[1];
      data[i + 2] = to[2];
    }
  }
  return { width: img.width, height: img.height, data };
}

/** Squared OKLab distance between colour i of `lab` and centre c of `centres`. */
function dist2(lab: Float64Array, i: number, centres: Float64Array, c: number): number {
  const d0 = lab[i * 3] - centres[c * 3];
  const d1 = lab[i * 3 + 1] - centres[c * 3 + 1];
  const d2 = lab[i * 3 + 2] - centres[c * 3 + 2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

/** Index of the centre nearest to colour i of `lab`. */
function nearestCentre(lab: Float64Array, i: number, centres: Float64Array): number {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < centres.length / 3; c++) {
    const d = dist2(lab, i, centres, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** The colours merged into BIN_BITS-per-channel bins: each bin's weighted mean OKLab colour and total weight. */
function binColours(keys: number[], lab: Float64Array, weight: Float64Array): { lab: Float64Array; weight: Float64Array } {
  const shift = 8 - BIN_BITS;
  const index = new Map<number, number>();
  const sums: number[] = [];
  keys.forEach((key, i) => {
    const bin = ((key >> 16 & 255) >> shift) << (2 * BIN_BITS) | ((key >> 8 & 255) >> shift) << BIN_BITS | (key & 255) >> shift;
    let b = index.get(bin);
    if (b === undefined) {
      b = index.size;
      index.set(bin, b);
      sums.push(0, 0, 0, 0);
    }
    const w = weight[i];
    sums[b * 4] += w * lab[i * 3];
    sums[b * 4 + 1] += w * lab[i * 3 + 1];
    sums[b * 4 + 2] += w * lab[i * 3 + 2];
    sums[b * 4 + 3] += w;
  });
  const n = index.size;
  const out = { lab: new Float64Array(n * 3), weight: new Float64Array(n) };
  for (let b = 0; b < n; b++) {
    const w = sums[b * 4 + 3];
    out.lab[b * 3] = sums[b * 4] / w;
    out.lab[b * 3 + 1] = sums[b * 4 + 1] / w;
    out.lab[b * 3 + 2] = sums[b * 4 + 2] / w;
    out.weight[b] = w;
  }
  return out;
}

/** Deterministic k-means++-style seeds: the heaviest colour, then repeatedly the largest weight x squared distance. */
function seedCentres(lab: Float64Array, weight: Float64Array, k: number): Float64Array {
  const n = weight.length;
  const centres = new Float64Array(k * 3);
  const nearest = new Float64Array(n).fill(Infinity);
  let pick = 0;
  for (let c = 0; c < k; c++) {
    centres.set(lab.subarray(pick * 3, pick * 3 + 3), c * 3);
    let best = -1;
    for (let i = 0; i < n; i++) {
      nearest[i] = Math.min(nearest[i], dist2(lab, i, centres, c));
      const score = weight[i] * nearest[i];
      if (score > best) {
        best = score;
        pick = i;
      }
    }
  }
  return centres;
}

/** Weighted Lloyd iterations; centres updated in place until the assignment or the centres settle. */
function lloyd(lab: Float64Array, weight: Float64Array, centres: Float64Array): void {
  const n = weight.length;
  const k = centres.length / 3;
  const assign = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * 4);
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(lab, i, centres, c);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed++;
      }
    }
    if (changed === 0)
      break;
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      const w = weight[i];
      sums[c * 4] += w * lab[i * 3];
      sums[c * 4 + 1] += w * lab[i * 3 + 1];
      sums[c * 4 + 2] += w * lab[i * 3 + 2];
      sums[c * 4 + 3] += w;
    }
    let moved = 0;
    for (let c = 0; c < k; c++) {
      const w = sums[c * 4 + 3];
      // An emptied centre keeps its position (it is a real colour from the seeding, so it may win members back)
      if (w > 0) {
        const L = sums[c * 4] / w;
        const a = sums[c * 4 + 1] / w;
        const b = sums[c * 4 + 2] / w;
        moved = Math.max(moved, Math.abs(L - centres[c * 3]) + Math.abs(a - centres[c * 3 + 1]) + Math.abs(b - centres[c * 3 + 2]));
        centres[c * 3] = L;
        centres[c * 3 + 1] = a;
        centres[c * 3 + 2] = b;
      }
    }
    if (moved < SETTLED)
      break;
  }
}
