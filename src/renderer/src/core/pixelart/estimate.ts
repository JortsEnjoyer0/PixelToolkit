// Grid estimator for Rectify To Grid (docs/img2pixel/img2pixel.md "Algorithm"): finds the fake-pixel size (may be
// fractional) and the grid offsets of an AI-generated, pixel-art-like image. Pipeline:
//  1. Colour steps between neighbouring pixels (premultiplied, luma / chroma basis with smoothed chroma), pairs that
//     are both background zeroed (border-band model: one colour as a robust plane, or a fake transparency
//     checkerboard; speckle-filtered when noise would unmask it), averaged a few px along the line direction and
//     thresholded against the image's own step noise (lower quantiles when edges dominate). Two edge scales:
//     adjacent pixels, and pixels 5 apart for soft or blurred edges.
//  2. Per column / row a saturating support profile (non-maximum suppressed across the line on the fine scale) whose
//     local maxima become candidate grid lines: sub-pixel position + weight (support length, floored and capped).
//  3. Hough-like vote over (size, phase): for each size the best phase's kernel-weighted share of line weight,
//     normalised against chance (with whole-pixel and JPEG 4:2:0 position quantisation). The largest size scoring
//     near the best wins, then a fine vote, robust least squares of position = phase + k * size (shared size) and a
//     lock to a whole-pixel size when that drifts less than half a pixel over the art.
//  4. Harmonic decision on the fine profile: divide by 2 / 3 while the sub-lattice lines are about as strong as the
//     grid lines (and the fine lines vote for the divided lattice), promote to twice the size while the in-between
//     lines are nearly empty. Mixels (detail on half cells) are common in AI pseudo pixel art, so dividing needs
//     strong, significant evidence.
//  5. Half-cell check: a phase shifted by half a cell wins when its cells are clearly more uniform.
//  6. Diagnostic for nearest-upscaled inputs: when the result is a whole 2 .. 4 px lattice that explains everything, the
//     image is also analysed at 1 / k and that grid (x k) is reported as `upscaled` (the estimate stays k).
// Pure functions over RgbaImage: no dependencies, deterministic, no DOM or node APIs. Tested by scripts/test-pixelart.ts.
import type { RgbaImage } from '@shared/image';
import type { GridEstimate } from './grid';

/** Search options. Sizes are in px; integerOnly restricts sizes (and offsets) to whole pixels. */
export interface EstimateOptions { minSize?: number; maxSize?: number; integerOnly?: boolean }

// ---------------------------------------------------------------- constants

/** Default size range: below 2 px there is nothing to downscale; above 160 px the art is a handful of pixels. */
export const DEFAULT_MIN_SIZE = 2;
export const DEFAULT_MAX_SIZE = 160;
/** Smallest size an explicit range may ask for (a 1 px grid is the identity). */
const ABS_MIN_SIZE = 1;
/** The art must span at least this many cells along its shorter extent (caps the default size range). */
const MIN_CELLS = 8;
/** With an explicit maxSize the art still needs this many cells (a user-typed size is honoured up to there). */
const MIN_CELLS_EXPLICIT = 2;

/** Weight of luma against the two chroma channels in a colour step (luma carries most edge contrast). */
const Y_WEIGHT = 2;
/** Half window (px) of the running mean of step magnitudes along the line direction (noise vs. short lines). */
const ALONG_RADIUS = 2;
/** Step threshold = median + NOISE_K * sigma + 1 of the smoothed step map (sigma: lower-half MAD). */
const NOISE_K = 3;
/**
 * Fallback threshold when the regular one leaves too few lines (edges on most neighbour pairs, e.g. a 1-cell checker
 * over the whole canvas, push the median into the edge population): the noise is then estimated from the lower
 * quantiles, sigma = (q25 - q10) / LOW_Q_SPREAD (Gaussian spacing of those quantiles), median = q25 + LOW_Q_MED * sigma.
 */
const LOW_Q_SPREAD = 0.6076;
const LOW_Q_MED = 0.674;
/** Step excess over the threshold that counts as one full row of line support (saturation). */
const SUPPORT_SAT = 24;

/** Background model: border band width = max(BG_BAND_MIN, min(w, h) / BG_BAND_DIV) px, ~BG_SAMPLES samples. */
const BG_BAND_MIN = 2;
const BG_BAND_DIV = 256;
const BG_SAMPLES = 6000;
/** Initial inlier tolerance, then clamp(BG_TOL_K * median residual + BG_TOL_ADD, BG_TOL_MIN, BG_TOL_MAX). */
const BG_TOL_START = 30;
const BG_TOL_K = 2.5;
const BG_TOL_ADD = 3;
const BG_TOL_MIN = 6;
const BG_TOL_MAX = 40;
/** Plane-fit iterations; the fit is abandoned below BG_FIT_MIN inliers, the mask below BG_COVERAGE of the band. */
const BG_ITERS = 3;
const BG_FIT_MIN = 0.3;
const BG_COVERAGE = 0.5;
/** Erosion (px) of the background mask, so blurred edge flanks stay symmetric (unbiased line centroids). */
const BG_ERODE = 3;
/**
 * Speckled background: when the erosion keeps less than BG_SPECKLE_KEEP of the background pixels, isolated noise / JPEG
 * outliers are being grown until most of the background is unmasked (its JPEG block edges then vote for an 8 px grid).
 * The mask is then rebuilt with a speckle filter before the erosion: a non-background pixel stays non-background only
 * when at least BG_SPECKLE of its 3 x 3 neighbourhood are. (Not applied otherwise: the noise threshold's statistics
 * include the unmasked pixels, and edge-dense art such as dithers needs those noise-only pairs.)
 */
const BG_SPECKLE_KEEP = 0.6;
const BG_SPECKLE = 5;
/**
 * Fake transparency checkerboard (AI images asked for a transparent background often paint one): the border band is
 * two near-neutral colours (max - min channel <= CHECK_CHROMA, luma apart by CHECK_DIFF_MIN .. CHECK_DIFF_MAX) covering
 * >= CHECK_COVERAGE of it, each >= CHECK_SHARE, in square runs: on at least one border row and one border column, >=
 * CHECK_REGULAR of >= CHECK_RUNS interior runs have the same length q (CHECK_Q_MIN .. CHECK_Q_MAX px, rows and columns
 * agreeing). Both colours, and the blend between them, are then background.
 */
const CHECK_CHROMA = 24;
const CHECK_DIFF_MIN = 8;
const CHECK_DIFF_MAX = 128;
const CHECK_COVERAGE = 0.85;
const CHECK_SHARE = 0.2;
const CHECK_RUNS = 4;
const CHECK_REGULAR = 0.75;
const CHECK_Q_MIN = 4;
const CHECK_Q_MAX = 96;
/**
 * Checker colour tolerance: the noise tolerance, but at least CHECK_TOL_DIFF and at most CHECK_TOL_MAX of the distance
 * between the two colours (JPEG noise in the squares would otherwise punch holes that the erosion grows into lines).
 */
const CHECK_TOL_DIFF = 0.35;
const CHECK_TOL_MAX = 0.45;

/** Content extent: this share of the profile mass is trimmed from each end. */
const EXTENT_TRIM = 0.005;
/** Prominence of a profile maximum is measured against the minima within this many px. */
const LINE_PROM_RADIUS = 3;
/** Line weights: the LINE_REF_RANK-th strongest is the reference; floor / cap relative to it (and to the max). */
const LINE_REF_RANK = 4;
const LINE_FLOOR_MAX = 0.01;
const LINE_FLOOR_REF = 0.03;
const LINE_CAP_REF = 0.35;

/** JPEG 8x8 blocks: lines within JPEG_NEAR px of multiples of JPEG_BLOCK from the origin. */
const JPEG_BLOCK = 8;
const JPEG_NEAR = 0.5;
/** Guard applies when that weight is >= JPEG_RATIO x its uniform share and the half-block lines are not elevated. */
const JPEG_RATIO = 2;
const JPEG_MID_RATIO = 1.5;

/** 4:2:0 chroma detection: step threshold, odd/even chroma ratio below, odd/even luma ratio above, sampled rows. */
const C420_STEP = 12;
const C420_CHROMA = 0.3;
const C420_LUMA = 0.2;
const C420_ROW_STEP = 3;

/** Vote kernel half-width max(KH_MIN, KH_REL * size) px; the fine vote uses FINE_KH_REL within +-FINE_SPAN. */
const KH_REL = 0.15;
const KH_MIN = 0.6;
const FINE_KH_REL = 0.08;
const FINE_SPAN = 0.03;
/** A line within WHOLE_PX_TOL px of a whole pixel counts as whole-pixel positioned (chance correction). */
const WHOLE_PX_TOL = 0.15;
/** A lattice that would catch this share of the lines by chance carries no information (score 0). */
const CHANCE_MAX = 0.9;
/** Largest size scoring >= ALPHA * best wins (ALPHA_HARM for 2x / 3x the best); PEAK_MERGE groups side lobes. */
const ALPHA = 0.75;
const ALPHA_HARM = 0.62;
const PEAK_MERGE = 1.15;
/** Size steps: the lattice drifts ~SIZE_STEP px over the extent per coarse step, FINE_STEP per fine step. */
const SIZE_STEP = 1;
const FINE_STEP = 0.25;
/** A scale needs this many lines on each axis (or 4x on one axis); the coarse scale must win by SCALE_MARGIN. */
const MIN_AXIS_LINES = 3;
const SCALE_MARGIN = 0.05;
/**
 * ... unless the fine lattice explains at least FINE_STRONG of its line weight above chance and the coarse size is
 * a whole multiple of it (within MULTIPLE_TOL relative).
 */
const FINE_STRONG = 0.5;
const MULTIPLE_TOL = 0.03;

/**
 * Edge scales: pair (b - 1 - gap, b + gap) straddles the line at b; smallest size it searches (the 5 px pairs of the
 * coarse scale cannot resolve cells below 7 px); smallest image side it runs on; profile treatment.
 */
const SCALES: readonly { gap: number; sMin: number; minSide: number; smooth: boolean; nms: boolean }[] = [
  { gap: 0, sMin: ABS_MIN_SIZE, minSide: 16, smooth: false, nms: true },
  { gap: 2, sMin: 7, minSide: 32, smooth: true, nms: false }
];
/** Gaussian (sigma 1 px) used to smooth the coarse profile. */
const SMOOTH_KERNEL = [0.0044, 0.054, 0.242, 0.399, 0.242, 0.054, 0.0044];

/** Least squares: iterations, biweight cut max(LSQ_TAU_MIN, LSQ_TAU_EARLY * s) then LSQ_TAU_LATE * s. */
const LSQ_ITERS = 6;
const LSQ_TAU_MIN = 0.6;
const LSQ_TAU_EARLY = 0.3;
const LSQ_TAU_LATE = 0.22;
const LSQ_MAX_STEP = 0.05;
/** Whole-pixel lock: integer size when it drifts less than this many px over the extent. */
const LOCK_DRIFT = 0.5;
/** integerOnly: a free size within WHOLE_TIE px of the midpoint between two whole sizes lets the vote choose. */
const WHOLE_TIE = 0.1;

/** Division by k (2, 3) when the sub-lattice carries >= SUB_RATIO of the grid lines' profile excess. */
const SUB_DIVISORS = [2, 3];
const SUB_RATIO = 0.4;
/** The grid lines must stand out: excess over the in-between level >= SUB_SIGNIFICANCE of their level. */
const SUB_SIGNIFICANCE = 0.3;
/** Sub-lattice windows +-max(SUB_WIN_MIN, SUB_WIN * s / k) px; sub-lattice spacing must be >= SUB_MIN_S px. */
const SUB_WIN = 0.15;
const SUB_WIN_MIN = 0.75;
const SUB_MIN_S = 2.9;
const HARMONIC_ROUNDS = 4;
/**
 * ... and when the fine lines themselves vote for the divided lattice: its fine score must be >= DIV_VOTE_GAIN x both
 * the fine score of the undivided size and the chosen lattice's score. Every correct division on the pools and the real
 * images had >= 1.23x, the wrong ones <= 0.8x: the profile ratio alone also fires on profiles without line structure
 * (bilinear-like ramps over whole cells, where only the coarse scale sees the grid) and on strong JPEG block grids.
 */
const DIV_VOTE_GAIN = 1.1;
/** Promotion to PROMOTE_FACTOR x the size when its in-between lines carry < PROMOTE_RATIO of its lines' excess. */
const PROMOTE_FACTOR = 2;
const PROMOTE_RATIO = 0.2;
/** ... and when the doubled lattice keeps >= PROMOTE_VOTE of the current lattice's vote score (line support). */
const PROMOTE_VOTE = 0.45;

/** Half-cell check: shift a phase by half a cell when that lowers the whole-cell error by FLIP_GAIN or more. */
const FLIP_GAIN = 0.02;
/** Pixel budget of the half-cell check (rows are strided above it). */
const FLIP_PIXELS = 2e6;

/**
 * Confidence = fine-profile coherence with the grid x min(1, size / CONF_SMALL_SIZE) (cells under 4 px are decided
 * by blur and compression) x (1 - CONF_AMBIGUITY * ambiguity), ambiguity = how close the harmonic statistics are to
 * halving / doubling the size.
 */
const CONF_SMALL_SIZE = 4;
const CONF_AMBIGUITY = 0.5;
/**
 * Integer-upscale diagnostic: when the result is a whole size k <= UPSCALE_MAX whose lattice scores >= UPSCALE_VOTE
 * (every edge on one residue mod k, as after a nearest k x upscale), the image is also analysed at 1 / k (k x k block
 * means at that phase). A nearest-upscaled pseudo-pixel-art image then shows its fake-pixel grid (k x the coarse size),
 * reported in `upscaled` and first in the alternatives. The estimate stays k: true pixel art upscaled by k looks the same.
 */
const UPSCALE_MAX = 4;
const UPSCALE_VOTE = 0.8;
/** Fallback size when nothing grid-like is found: min(w, h) / FALLBACK_DIV. */
const FALLBACK_DIV = 64;
/** Diagnostics: at most ALT_MAX alternative sizes are reported. */
const ALT_MAX = 6;

// ---------------------------------------------------------------- types

/** Candidate grid lines of one axis: sub-pixel positions (line x = b is the boundary left of pixel b) and weights. */
interface AxisLines {
  pos: Float64Array;
  w: Float64Array;
  n: number;
  /** Content extent along the axis (px), from the cumulative edge profile. */
  lo: number;
  hi: number;
  total: number;
}

/** A lattice: size, per-axis phase, normalised vote score (share of line weight explained above chance). */
interface Lattice { s: number; ox: number; oy: number; v: number; ok: boolean }

interface ScaleResult {
  /** Support profiles (index b = line at b) and their lines. */
  px: Float64Array;
  py: Float64Array;
  lx: AxisLines;
  ly: AxisLines;
  lat: Lattice;
  /** Local maxima of the vote score (best first) and the scorer itself. */
  peaks: { s: number; v: number }[];
  vote: Voter;
}

interface Planes { w: number; h: number; Y: Float32Array; cb: Float32Array; cr: Float32Array; A: Float32Array }

interface SizeRange { min: number; max: number; explicitMax: boolean }

/** Estimate plus diagnostics for UI hints (alternative sizes, non-square cells) and debugging. */
export interface GridAnalysis {
  estimate: GridEstimate;
  /** Other strong lattice sizes (vote peaks, best first), e.g. to offer x2 / half alternatives. */
  alternatives: { size: number; score: number }[];
  /** Steps applied after the vote: 'div2', 'div3', 'x2', 'flipX', 'flipY', 'whole' (integerOnly rounding). */
  steps: string[];
  /** Separate per-axis least-squares sizes (a large mismatch suggests non-square cells). */
  sizeX: number;
  sizeY: number;
  /** Solid background found (and masked); JPEG 4:2:0 chroma detected. */
  background: boolean;
  chroma420: boolean;
  /**
   * Harmonic statistics of the result (fine profile): halfEvidence is the half-size sub-lattice's share of the grid
   * lines' excess (>= SUB_RATIO would have halved the size), doubleEvidence the in-between lines' share for twice the
   * size (< PROMOTE_RATIO would have doubled it; Infinity when not resolved). Values near the thresholds flag a
   * plausible x2 / half alternative; vote is the lattice score (share of line weight explained above chance).
   */
  halfEvidence: number;
  doubleEvidence: number;
  vote: number;
  /** Fine-profile phase coherence with the result grid (mean of both axes, 0 .. 1). */
  coherence: number;
  /**
   * The image looks like a nearest upscale by `factor` (the estimate is that whole size): the grid found in the image
   * scaled down by `factor`, in the original's pixels (size = factor x the coarse size). It is the fake-pixel grid when the
   * input is upscaled pseudo pixel art; null when not applicable or nothing was found at the coarse level.
   */
  upscaled: { factor: number; size: number; offsetX: number; offsetY: number; confidence: number } | null;
}

function mod(a: number, m: number): number {
  const r = a % m;
  return r < 0 ? r + m : r;
}

/** Offset wrapped into [0, size), rounded to 1e-4 px so whole-pixel phases come out exact. */
function cleanOffset(o: number, s: number): number {
  const r = mod(Math.round(o * 1e4) / 1e4, s);
  return r >= s - 1e-6 ? 0 : r;
}

// ---------------------------------------------------------------- colour planes and background

/**
 * Premultiplied colour in a luma / chroma basis (luma scaled by Y_WEIGHT). The chroma planes are smoothed with a
 * separable [1, 2, 1] / 4 filter: subsampled chroma (JPEG 4:2:0) otherwise steps on every second boundary, which reads
 * as a period-2 grid.
 */
function colourPlanes(img: RgbaImage): Planes {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const Y = new Float32Array(n);
  const cb = new Float32Array(n);
  const cr = new Float32Array(n);
  const A = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const a = data[p * 4 + 3];
    const f = a / 255;
    const r = data[p * 4] * f;
    const g = data[p * 4 + 1] * f;
    const b = data[p * 4 + 2] * f;
    Y[p] = (0.299 * r + 0.587 * g + 0.114 * b) * Y_WEIGHT;
    cb[p] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[p] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    A[p] = a;
  }
  smooth121(cb, w, h);
  smooth121(cr, w, h);
  return { w, h, Y, cb, cr, A };
}

/** In-place separable [1, 2, 1] / 4 filter with clamped edges. */
function smooth121(p: Float32Array, w: number, h: number): void {
  const line = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++)
      line[x] = p[row + x];
    for (let x = 0; x < w; x++)
      p[row + x] = (line[x > 0 ? x - 1 : 0] + 2 * line[x] + line[x < w - 1 ? x + 1 : w - 1]) * 0.25;
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++)
      line[y] = p[y * w + x];
    for (let y = 0; y < h; y++)
      p[y * w + x] = (line[y > 0 ? y - 1 : 0] + 2 * line[y] + line[y < h - 1 ? y + 1 : h - 1]) * 0.25;
  }
}

/**
 * Nearest-upsampled 4:2:0 chroma (JPEG): significant chroma steps sit almost only on even pixel boundaries while luma
 * steps also occur on odd ones. Art whose edges are all on even boundaries has neither and is left alone.
 */
function chromaSubsampled(img: RgbaImage): boolean {
  const { width: w, height: h, data } = img;
  const lum = [1e-9, 1e-9];
  const chr = [1e-9, 1e-9];
  for (let y = 1; y < h; y += C420_ROW_STEP) {
    for (let x = 0; x + 1 < w; x++) {
      const i = (y * w + x) * 4;
      const j = i + 4;
      const dr = data[j] - data[i];
      const dg = data[j + 1] - data[i + 1];
      const db = data[j + 2] - data[i + 2];
      const par = (x + 1) & 1;
      lum[par] += Math.max(0, 3 * Math.abs(0.299 * dr + 0.587 * dg + 0.114 * db) - C420_STEP);
      chr[par] += Math.max(0, 2 * (Math.abs(-0.1687 * dr - 0.3313 * dg + 0.5 * db) + Math.abs(0.5 * dr - 0.4187 * dg - 0.0813 * db)) - C420_STEP);
    }
  }
  const rc = chr[1] / chr[0];
  const rl = lum[1] / lum[0];
  return chr[0] > 1 && rc < C420_CHROMA && rl > C420_LUMA && rc < 0.5 * rl;
}

/** Border-band sample positions of the background model, strided to about BG_SAMPLES pixels. */
function borderSamples(w: number, h: number): number[] {
  const band = Math.max(BG_BAND_MIN, Math.round(Math.min(w, h) / BG_BAND_DIV));
  const idx: number[] = [];
  const stride = Math.max(1, Math.floor((2 * (w + h) * band) / BG_SAMPLES));
  let k = 0;
  for (let y = 0; y < h; y++) {
    const edgeRow = y < band || y >= h - band;
    for (let x = 0; x < w; x++) {
      if (edgeRow || x < band || x >= w - band) {
        if (k++ % stride === 0)
          idx.push(y * w + x);
      } else if (x === band) {
        x = w - band - 1;
      }
    }
  }
  return idx;
}

/**
 * Background model from the border band: a robust per-channel plane (c + gx * x + gy * y) over premultiplied RGBA,
 * with a tolerance from the residual noise. Returns a per-pixel mask (1 = background, eroded by BG_ERODE, speckle-filtered
 * first when the background is speckled; see BG_SPECKLE_KEEP) or null when the border is not dominated by one colour
 * (e.g. full-canvas tiles).
 */
function backgroundMask(img: RgbaImage): Uint8Array | null {
  const { width: w, height: h, data } = img;
  const checker = checkerBackground(img);
  if (checker) {
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++)
      mask[p] = data[p * 4 + 3] >= 250 && segmentDist(data[p * 4], data[p * 4 + 1], data[p * 4 + 2], checker.a, checker.b) <= checker.tol ? 1 : 0;
    return finishMask(mask, w, h);
  }
  const idx = borderSamples(w, h);
  const n = idx.length;
  if (n === 0)
    return null;
  const ch = new Float64Array(n * 4);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = idx[i];
    const a = data[p * 4 + 3];
    const f = a / 255;
    ch[i * 4] = data[p * 4] * f;
    ch[i * 4 + 1] = data[p * 4 + 1] * f;
    ch[i * 4 + 2] = data[p * 4 + 2] * f;
    ch[i * 4 + 3] = a;
    xs[i] = (p % w) / w - 0.5;
    ys[i] = Math.floor(p / w) / h - 0.5;
  }
  // Start flat at the per-channel median, then fit planes on the inliers.
  const model = new Float64Array(12);
  for (let c = 0; c < 4; c++) {
    const v: number[] = [];
    for (let i = 0; i < n; i++)
      v.push(ch[i * 4 + c]);
    v.sort((a, b) => a - b);
    model[c * 3] = v[n >> 1];
  }
  const resid = (i: number): number => {
    let d2 = 0;
    for (let c = 0; c < 4; c++) {
      const e = ch[i * 4 + c] - (model[c * 3] + model[c * 3 + 1] * xs[i] + model[c * 3 + 2] * ys[i]);
      d2 += e * e;
    }
    return Math.sqrt(d2);
  };
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++)
    dist[i] = resid(i);
  let tol = BG_TOL_START;
  for (let iter = 0; iter < BG_ITERS; iter++) {
    let s1 = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    const bz = new Float64Array(12);
    for (let i = 0; i < n; i++) {
      if (resid(i) > tol)
        continue;
      s1++;
      sx += xs[i];
      sy += ys[i];
      sxx += xs[i] * xs[i];
      syy += ys[i] * ys[i];
      sxy += xs[i] * ys[i];
      for (let c = 0; c < 4; c++) {
        const v = ch[i * 4 + c];
        bz[c * 3] += v;
        bz[c * 3 + 1] += v * xs[i];
        bz[c * 3 + 2] += v * ys[i];
      }
    }
    if (s1 < n * BG_FIT_MIN)
      return null;
    // 3x3 normal equations in [1, x, y], solved by Cramer's rule.
    const m = [s1, sx, sy, sx, sxx, sxy, sy, sxy, syy];
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-9)
      break;
    for (let c = 0; c < 4; c++) {
      const b0 = bz[c * 3];
      const b1 = bz[c * 3 + 1];
      const b2 = bz[c * 3 + 2];
      model[c * 3] = (b0 * (m[4] * m[8] - m[5] * m[7]) - m[1] * (b1 * m[8] - m[5] * b2) + m[2] * (b1 * m[7] - m[4] * b2)) / det;
      model[c * 3 + 1] = (m[0] * (b1 * m[8] - m[5] * b2) - b0 * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * b2 - b1 * m[6])) / det;
      model[c * 3 + 2] = (m[0] * (m[4] * b2 - b1 * m[7]) - m[1] * (m[3] * b2 - b1 * m[6]) + b0 * (m[3] * m[7] - m[4] * m[6])) / det;
    }
    for (let i = 0; i < n; i++)
      dist[i] = resid(i);
    const sorted = Array.from(dist).sort((a, b) => a - b);
    tol = Math.max(BG_TOL_MIN, Math.min(BG_TOL_MAX, BG_TOL_K * sorted[n >> 1] + BG_TOL_ADD));
  }
  let inliers = 0;
  for (let i = 0; i < n; i++) {
    if (dist[i] <= tol)
      inliers++;
  }
  if (inliers < n * BG_COVERAGE)
    return null;
  const mask = new Uint8Array(w * h);
  const tol2 = tol * tol;
  for (let y = 0; y < h; y++) {
    const yy = y / h - 0.5;
    for (let x = 0; x < w; x++) {
      const xx = x / w - 0.5;
      const p = y * w + x;
      const a = data[p * 4 + 3];
      const f = a / 255;
      let d2 = 0;
      for (let c = 0; c < 4; c++) {
        const v = c < 3 ? data[p * 4 + c] * f : a;
        const e = v - (model[c * 3] + model[c * 3 + 1] * xx + model[c * 3 + 2] * yy);
        d2 += e * e;
      }
      mask[p] = d2 <= tol2 ? 1 : 0;
    }
  }
  return finishMask(mask, w, h);
}

/** Erosion of a raw background mask, speckle-filtered first when the erosion would unmask most of it (BG_SPECKLE_KEEP). */
function finishMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const eroded = erode(mask, w, h, BG_ERODE);
  if (count(eroded) >= BG_SPECKLE_KEEP * count(mask))
    return eroded;
  despeckle(mask, w, h, BG_SPECKLE);
  return erode(mask, w, h, BG_ERODE);
}

/** RGB distance from (r, g, b) to the segment between colours a and b. */
function segmentDist(r: number, g: number, bl: number, a: number[], b: number[]): number {
  const dr = b[0] - a[0];
  const dg = b[1] - a[1];
  const db = b[2] - a[2];
  const len2 = dr * dr + dg * dg + db * db;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((r - a[0]) * dr + (g - a[1]) * dg + (bl - a[2]) * db) / len2)) : 0;
  return Math.hypot(r - a[0] - t * dr, g - a[1] - t * dg, bl - a[2] - t * db);
}

/** Fake transparency checkerboard in the border band (see CHECK_CHROMA): its two colours and tolerance, or null. */
function checkerBackground(img: RgbaImage): { a: number[]; b: number[]; tol: number } | null {
  const { width: w, height: h, data } = img;
  const idx = borderSamples(w, h);
  const lum: number[] = [];
  const ps: number[] = [];
  for (const p of idx) {
    if (data[p * 4 + 3] >= 250) {
      ps.push(p);
      lum.push(0.299 * data[p * 4] + 0.587 * data[p * 4 + 1] + 0.114 * data[p * 4 + 2]);
    }
  }
  const n = ps.length;
  if (n < 64 || n < 0.95 * idx.length)
    return null;
  // Two-means on luma, started at the 10 % / 90 % quantiles.
  const sorted = lum.slice().sort((p, q) => p - q);
  let c0 = sorted[Math.floor(0.1 * (n - 1))];
  let c1 = sorted[Math.floor(0.9 * (n - 1))];
  if (c1 - c0 < CHECK_DIFF_MIN)
    return null;
  const lab = new Uint8Array(n);
  for (let it = 0; it < 6; it++) {
    let s0 = 0;
    let s1 = 0;
    let n0 = 0;
    let n1 = 0;
    for (let i = 0; i < n; i++) {
      lab[i] = Math.abs(lum[i] - c1) < Math.abs(lum[i] - c0) ? 1 : 0;
      if (lab[i]) {
        s1 += lum[i];
        n1++;
      } else {
        s0 += lum[i];
        n0++;
      }
    }
    if (n0 === 0 || n1 === 0)
      return null;
    c0 = s0 / n0;
    c1 = s1 / n1;
  }
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  let na = 0;
  for (let i = 0; i < n; i++) {
    const t = lab[i] ? b : a;
    for (let c = 0; c < 3; c++)
      t[c] += data[ps[i] * 4 + c];
    na += lab[i] ? 0 : 1;
  }
  for (let c = 0; c < 3; c++) {
    a[c] /= na;
    b[c] /= n - na;
  }
  const chroma = (c: number[]): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  const diff = Math.abs(c1 - c0);
  if (chroma(a) > CHECK_CHROMA || chroma(b) > CHECK_CHROMA || diff < CHECK_DIFF_MIN || diff > CHECK_DIFF_MAX)
    return null;
  // Tolerance from the residuals to the nearer colour; coverage and shares.
  const dist = (p: number, c: number[]): number => Math.hypot(data[p * 4] - c[0], data[p * 4 + 1] - c[1], data[p * 4 + 2] - c[2]);
  const res = ps.map((p) => Math.min(dist(p, a), dist(p, b))).sort((p, q) => p - q);
  const tol = Math.max(BG_TOL_MIN, Math.min(BG_TOL_MAX, Math.max(BG_TOL_K * res[n >> 1] + BG_TOL_ADD, CHECK_TOL_DIFF * diff), CHECK_TOL_MAX * diff));
  let inA = 0;
  let inB = 0;
  let near = 0;
  for (const p of ps) {
    const da = dist(p, a);
    const db = dist(p, b);
    inA += da <= tol ? 1 : 0;
    inB += db <= tol ? 1 : 0;
    near += segmentDist(data[p * 4], data[p * 4 + 1], data[p * 4 + 2], a, b) <= tol ? 1 : 0;
  }
  if (near < CHECK_COVERAGE * n || inA < CHECK_SHARE * n || inB < CHECK_SHARE * n)
    return null;
  // Square runs along the border rows and columns.
  const runLength = (len: number, at: (i: number) => number): number => {
    const label = (i: number): number => {
      const p = at(i);
      if (data[p * 4 + 3] < 250)
        return -1;
      return dist(p, a) <= tol ? 0 : dist(p, b) <= tol ? 1 : -1;
    };
    const edges: number[] = [];
    let last = -1;
    let lastAt = -1;
    for (let i = 0; i < len; i++) {
      const l = label(i);
      if (l < 0)
        continue;
      if (last >= 0 && l !== last)
        edges.push((lastAt + i + 1) / 2);
      last = l;
      lastAt = i;
    }
    const runs: number[] = [];
    for (let i = 1; i < edges.length; i++)
      runs.push(edges[i] - edges[i - 1]);
    if (runs.length < CHECK_RUNS)
      return 0;
    const q = runs.slice().sort((p, r) => p - r)[runs.length >> 1];
    const ok = runs.filter((r) => Math.abs(r - q) <= Math.max(1.5, 0.1 * q)).length;
    return ok >= CHECK_REGULAR * runs.length && q >= CHECK_Q_MIN && q <= CHECK_Q_MAX ? q : 0;
  };
  const rows = [runLength(w, (i) => i), runLength(w, (i) => (h - 1) * w + i)].filter((q) => q > 0);
  const cols = [runLength(h, (i) => i * w), runLength(h, (i) => i * w + w - 1)].filter((q) => q > 0);
  const agree = rows.some((qr) => cols.some((qc) => Math.abs(qr - qc) <= Math.max(1.5, 0.1 * qr)));
  return agree ? { a, b, tol } : null;
}

/** Number of set entries of a 0 / 1 mask. */
function count(m: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < m.length; i++)
    n += m[i];
  return n;
}

/** Speckle filter (in place): non-background pixels (0) with fewer than k non-background pixels in their 3 x 3 become 1. */
function despeckle(m: Uint8Array, w: number, h: number, k: number): void {
  const col = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      col[p] = (m[p] ? 0 : 1) + (y > 0 && !m[p - w] ? 1 : 0) + (y < h - 1 && !m[p + w] ? 1 : 0);
    }
  }
  const flip: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (!m[p] && col[p] + (x > 0 ? col[p - 1] : 0) + (x < w - 1 ? col[p + 1] : 0) < k)
        flip.push(p);
    }
  }
  for (const p of flip)
    m[p] = 1;
}

/** Binary erosion with a (2r+1)^2 square (separable run lengths); pixels outside the image count as set. */
function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const left = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let run = 0;
    for (let x = 0; x < w; x++) {
      run = m[row + x] ? run + 1 : 0;
      left[x] = run;
    }
    run = 0;
    for (let x = w - 1; x >= 0; x--) {
      run = m[row + x] ? run + 1 : 0;
      tmp[row + x] = m[row + x] && (left[x] > r || left[x] === x + 1) && (run > r || run === w - x) ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  const run = new Int32Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      run[x] = tmp[y * w + x] ? run[x] + 1 : 0;
      out[y * w + x] = run[x] > r || run[x] === y + 1 ? 1 : 0;
    }
  }
  run.fill(0);
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      run[x] = tmp[y * w + x] ? run[x] + 1 : 0;
      if (!(run[x] > r || run[x] === h - y))
        out[y * w + x] = 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- line profiles

/**
 * Step magnitudes across every line position of one axis. alongX: d[y * w + b] compares pixels (b - 1 - gap, y) and
 * (b + gap, y), i.e. it straddles the vertical line x = b; otherwise rows b - 1 - gap and b + gap. Pairs that are
 * both background are zero (kills JPEG blocks and gradient noise in the background).
 */
function stepMap(pl: Planes, bg: Uint8Array | null, gap: number, alongX: boolean): Float32Array {
  const { w, h, Y, cb, cr, A } = pl;
  const d = new Float32Array(w * h);
  const step = (i: number, k: number): number => {
    if (bg && bg[i] && bg[k])
      return 0;
    return Math.abs(Y[i] - Y[k]) + Math.abs(cb[i] - cb[k]) + Math.abs(cr[i] - cr[k]) + Math.abs(A[i] - A[k]);
  };
  if (alongX) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let b = gap + 1; b < w - gap; b++)
        d[row + b] = step(row + b + gap, row + b - 1 - gap);
    }
  } else {
    for (let b = gap + 1; b < h - gap; b++) {
      const r0 = (b + gap) * w;
      const r1 = (b - 1 - gap) * w;
      for (let x = 0; x < w; x++)
        d[b * w + x] = step(r0 + x, r1 + x);
    }
  }
  return d;
}

/** Running mean of a step map along the line direction (vertical for alongX maps), window 2r + 1. */
function smoothAlong(d: Float32Array, w: number, h: number, alongX: boolean, r: number): Float32Array {
  const out = new Float32Array(w * h);
  if (alongX) {
    const acc = new Float64Array(w);
    for (let y = 0; y < Math.min(r, h); y++) {
      for (let x = 0; x < w; x++)
        acc[x] += d[y * w + x];
    }
    for (let y = 0; y < h; y++) {
      if (y + r < h) {
        const ra = (y + r) * w;
        for (let x = 0; x < w; x++)
          acc[x] += d[ra + x];
      }
      if (y - r - 1 >= 0) {
        const rs = (y - r - 1) * w;
        for (let x = 0; x < w; x++)
          acc[x] -= d[rs + x];
      }
      const inv = 1 / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
      const row = y * w;
      for (let x = 0; x < w; x++)
        out[row + x] = acc[x] * inv;
    }
  } else {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = 0; x < Math.min(r, w); x++)
        acc += d[row + x];
      for (let x = 0; x < w; x++) {
        if (x + r < w)
          acc += d[row + x + r];
        if (x - r - 1 >= 0)
          acc -= d[row + x - r - 1];
        out[row + x] = acc / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
      }
    }
  }
  return out;
}

/**
 * Noise threshold: median + NOISE_K * (lower-half MAD sigma) + 1 of the smoothed steps over non-background pairs, and
 * the low-quantile fallback (see LOW_Q_SPREAD).
 */
function stepThreshold(m: Float32Array, pl: Planes, bg: Uint8Array | null, alongX: boolean, gap: number): { T: number; low: number } {
  const { w, h } = pl;
  const bins = 4096;
  const perUnit = 4;
  const hist = new Float64Array(bins);
  let count = 0;
  const x0 = alongX ? gap + 1 : 0;
  const x1 = alongX ? w - gap : w;
  const y0 = alongX ? 0 : gap + 1;
  const y1 = alongX ? h : h - gap;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = y * w + x;
      if (bg) {
        const i = alongX ? p + gap : p + gap * w;
        const k = alongX ? p - 1 - gap : p - (1 + gap) * w;
        if (bg[i] && bg[k])
          continue;
      }
      hist[Math.min(bins - 1, Math.floor(m[p] * perUnit))]++;
      count++;
    }
  }
  const quant = (q: number): number => {
    let acc = 0;
    for (let v = 0; v < bins; v++) {
      acc += hist[v];
      if (acc >= count * q)
        return (v + 0.5) / perUnit;
    }
    return bins / perUnit;
  };
  const med = quant(0.5);
  const q25 = quant(0.25);
  const sigma = Math.max(0, (med - q25) * 1.4826);
  const sigmaLow = Math.max(0, (q25 - quant(0.1)) / LOW_Q_SPREAD);
  return { T: med + NOISE_K * sigma + 1, low: q25 + (LOW_Q_MED + NOISE_K) * sigmaLow + 1 };
}

/**
 * Saturating support profile: prof[b] = sum along the line of min(1, max(0, step - T) / SUPPORT_SAT). With nms, a
 * step only counts where it is a local maximum across the line direction (ties kept), so blurred edges do not smear
 * into their neighbours (this is what makes 2 .. 3.6 px cells detectable under blur).
 */
function profile(ds: Float32Array, w: number, h: number, alongX: boolean, T: number, nms: boolean): Float64Array {
  const len = alongX ? w : h;
  const prof = new Float64Array(len + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      const d = ds[p];
      const v = d - T;
      if (v <= 0)
        continue;
      if (nms) {
        if (alongX) {
          if ((x > 0 && ds[p - 1] > d) || (x < w - 1 && ds[p + 1] > d))
            continue;
        } else if ((y > 0 && ds[p - w] > d) || (y < h - 1 && ds[p + w] > d)) {
          continue;
        }
      }
      const c = v >= SUPPORT_SAT ? 1 : v / SUPPORT_SAT;
      if (alongX)
        prof[x] += c;
      else
        acc += c;
    }
    if (!alongX)
      prof[y] = acc;
  }
  prof[0] = 0;
  return prof;
}

/** In-place Gaussian smoothing (sigma 1 px) of a profile. */
function smoothProfile(p: Float64Array): void {
  const src = Float64Array.from(p);
  const r = SMOOTH_KERNEL.length >> 1;
  for (let i = 0; i < p.length; i++) {
    let s = 0;
    for (let t = -r; t <= r; t++) {
      const q = i + t;
      if (q >= 0 && q < p.length)
        s += SMOOTH_KERNEL[t + r] * src[q];
    }
    p[i] = s;
  }
}

/** Local maxima of a profile as sub-pixel line candidates (centroid above half prominence), weighted by prominence. */
function detectLines(prof: Float64Array, len: number): AxisLines {
  let total = 0;
  for (let b = 1; b < len; b++)
    total += prof[b];
  let lo = 0;
  let hi = len;
  if (total > 0) {
    let acc = 0;
    for (let b = 1; b < len; b++) {
      acc += prof[b];
      if (acc >= total * EXTENT_TRIM) {
        lo = b;
        break;
      }
    }
    acc = 0;
    for (let b = len - 1; b >= 1; b--) {
      acc += prof[b];
      if (acc >= total * EXTENT_TRIM) {
        hi = b;
        break;
      }
    }
  }
  const pos: number[] = [];
  const wt: number[] = [];
  for (let b = 1; b < len; b++) {
    const v = prof[b];
    if (v <= 0 || prof[b - 1] === v)
      continue;
    // Plateau-aware local maximum: [b, e] equal values, strictly above both neighbours.
    let e = b;
    while (e + 1 < len && prof[e + 1] === v)
      e++;
    const right = e + 1 < len ? prof[e + 1] : 0;
    if (!(v > prof[b - 1] && v > right))
      continue;
    let minL = v;
    let minR = v;
    for (let k = 1; k <= LINE_PROM_RADIUS && b - k >= 1; k++)
      minL = Math.min(minL, prof[b - k]);
    for (let k = 1; k <= LINE_PROM_RADIUS && e + k < len; k++)
      minR = Math.min(minR, prof[e + k]);
    const base = Math.max(minL, minR);
    const prom = v - base;
    if (prom <= 0)
      continue;
    // Centroid of the part above half prominence, walking out while the profile decreases.
    const half = base + prom * 0.5;
    let sw = 0;
    let sp = 0;
    for (let k = b; k <= e; k++) {
      sw += prof[k] - half;
      sp += (prof[k] - half) * k;
    }
    let prev = v;
    for (let k = b - 1; k >= 1 && prof[k] > half && prof[k] <= prev; k--) {
      sw += prof[k] - half;
      sp += (prof[k] - half) * k;
      prev = prof[k];
    }
    prev = v;
    for (let k = e + 1; k < len && prof[k] > half && prof[k] <= prev; k++) {
      sw += prof[k] - half;
      sp += (prof[k] - half) * k;
      prev = prof[k];
    }
    pos.push(sw > 0 ? sp / sw : (b + e) / 2);
    wt.push(prom);
    b = e;
  }
  // Robust reference weight: a floor drops noise maxima, a cap keeps a few long silhouette lines from outvoting the
  // many short interior ones.
  const desc = wt.slice().sort((a, b) => b - a);
  const ref = desc.length ? desc[Math.min(LINE_REF_RANK, desc.length - 1)] : 0;
  const floorW = Math.max((desc[0] ?? 0) * LINE_FLOOR_MAX, ref * LINE_FLOOR_REF);
  const capW = ref * LINE_CAP_REF;
  const P: number[] = [];
  const W: number[] = [];
  let tw = 0;
  for (let i = 0; i < pos.length; i++) {
    if (wt[i] < floorW)
      continue;
    const c = Math.min(wt[i], capW);
    P.push(pos[i]);
    W.push(c);
    tw += c;
  }
  return { pos: Float64Array.from(P), w: Float64Array.from(W), n: P.length, lo, hi, total: tw };
}

/**
 * JPEG guard: 8x8 DCT blocks leave weak lines on multiples of 8 px from the image origin. When the line weight there
 * is R >= JPEG_RATIO times its uniform share while the half-block positions are not elevated (a genuine period-4 or
 * period-2 grid), those lines are scaled by 1 / R^2. A genuine period-8 / period-16 grid at phase 0 loses all its lines
 * equally, so its relative scores are unchanged.
 */
function jpegGuard(lx: AxisLines, ly: AxisLines): void {
  let w0 = 0;
  let w4 = 0;
  let tot = 0;
  const half = JPEG_BLOCK / 2;
  for (const a of [lx, ly]) {
    for (let i = 0; i < a.n; i++) {
      const r = mod(a.pos[i], JPEG_BLOCK);
      tot += a.w[i];
      if (Math.min(r, JPEG_BLOCK - r) < JPEG_NEAR)
        w0 += a.w[i];
      else if (Math.abs(r - half) < JPEG_NEAR)
        w4 += a.w[i];
    }
  }
  const share = tot / JPEG_BLOCK;
  const R = share > 0 ? w0 / share : 0;
  if (R < JPEG_RATIO || w4 / share > JPEG_MID_RATIO)
    return;
  for (const a of [lx, ly]) {
    let t = 0;
    for (let i = 0; i < a.n; i++) {
      const r = mod(a.pos[i], JPEG_BLOCK);
      if (Math.min(r, JPEG_BLOCK - r) < JPEG_NEAR)
        a.w[i] /= R * R;
      t += a.w[i];
    }
    a.total = t;
  }
}

// ---------------------------------------------------------------- lattice fit

const kernelHalf = (s: number): number => Math.max(KH_MIN, KH_REL * s);
/** Phase histogram bins of the vote (upper bound; a period uses ceil(s / (h / 3)) of them). */
const VOTE_BINS = 4096;

/** Best phase of one axis' lines on a lattice of period s: max over phase of sum w * (1 - (d / h)^2)+. */
function axisVote(a: AxisLines, s: number, h: number, hist: Float64Array): { score: number; phase: number } {
  const nb = Math.min(hist.length, Math.max(8, Math.ceil(s / (h / 3))));
  const bw = s / nb;
  hist.fill(0, 0, nb);
  for (let i = 0; i < a.n; i++) {
    const u = mod(a.pos[i], s) / bw;
    const i0 = Math.floor(u);
    const f = u - i0;
    hist[i0 % nb] += a.w[i] * (1 - f);
    hist[(i0 + 1) % nb] += a.w[i] * f;
  }
  const kr = Math.floor(h / bw);
  let best = -1;
  let bestJ = 0;
  for (let j = 0; j < nb; j++) {
    let sum = hist[j];
    for (let t = 1; t <= kr; t++) {
      const d = (t * bw) / h;
      sum += (1 - d * d) * (hist[(j + t) % nb] + hist[(j - t + nb) % nb]);
    }
    if (sum > best) {
      best = sum;
      bestJ = j;
    }
  }
  return { score: best, phase: bestJ * bw };
}

/** Biweight least squares of pos = phase_axis + k * s over both axes with a shared s (s fixed when fixedSize). */
function refine(lx: AxisLines, ly: AxisLines, s0: number, ox0: number, oy0: number, fixedSize: boolean): { s: number; ox: number; oy: number } {
  let s = s0;
  let ox = ox0;
  let oy = oy0;
  for (let iter = 0; iter < LSQ_ITERS; iter++) {
    const tau = Math.max(LSQ_TAU_MIN, (iter < 2 ? LSQ_TAU_EARLY : LSQ_TAU_LATE) * s);
    let Skk = 0;
    let Skx = 0;
    let Sky = 0;
    let Sx = 0;
    let Sy = 0;
    let Skp = 0;
    let Spx = 0;
    let Spy = 0;
    for (let ai = 0; ai < 2; ai++) {
      const a = ai === 0 ? lx : ly;
      const o = ai === 0 ? ox : oy;
      for (let i = 0; i < a.n; i++) {
        const p = a.pos[i];
        const k = Math.round((p - o) / s);
        const r = p - o - k * s;
        if (Math.abs(r) >= tau)
          continue;
        const u = r / tau;
        const wt = a.w[i] * (1 - u * u) * (1 - u * u);
        Skk += wt * k * k;
        Skp += wt * k * p;
        if (ai === 0) {
          Skx += wt * k;
          Sx += wt;
          Spx += wt * p;
        } else {
          Sky += wt * k;
          Sy += wt;
          Spy += wt * p;
        }
      }
    }
    if (Sx <= 0 && Sy <= 0)
      break;
    if (!fixedSize) {
      // [[Skk, Skx, Sky], [Skx, Sx, 0], [Sky, 0, Sy]] [s, ox, oy] = [Skp, Spx, Spy]; an axis without inliers drops out.
      const cx = Sx > 0 ? 1 / Sx : 0;
      const cy = Sy > 0 ? 1 / Sy : 0;
      const den = Skk - Skx * Skx * cx - Sky * Sky * cy;
      if (den <= 1e-9)
        break;
      const sNew = (Skp - Skx * Spx * cx - Sky * Spy * cy) / den;
      if (!Number.isFinite(sNew) || Math.abs(sNew / s - 1) > LSQ_MAX_STEP)
        break;
      s = sNew;
    }
    if (Sx > 0)
      ox = (Spx - Skx * s) / Sx;
    if (Sy > 0)
      oy = (Spy - Sky * s) / Sy;
  }
  return { s, ox, oy };
}

/** Robust least squares of pos = o + k * s on one axis alone (diagnostic per-axis size). */
function refineAxis(a: AxisLines, s0: number, o0: number): number {
  let s = s0;
  let o = o0;
  for (let iter = 0; iter < LSQ_ITERS; iter++) {
    const tau = Math.max(LSQ_TAU_MIN, LSQ_TAU_LATE * s);
    let S0 = 0;
    let Sk = 0;
    let Skk = 0;
    let Sp = 0;
    let Skp = 0;
    for (let i = 0; i < a.n; i++) {
      const k = Math.round((a.pos[i] - o) / s);
      const r = a.pos[i] - o - k * s;
      if (Math.abs(r) >= tau)
        continue;
      const u = r / tau;
      const wt = a.w[i] * (1 - u * u) * (1 - u * u);
      S0 += wt;
      Sk += wt * k;
      Skk += wt * k * k;
      Sp += wt * a.pos[i];
      Skp += wt * k * a.pos[i];
    }
    const den = S0 * Skk - Sk * Sk;
    if (S0 <= 0 || den <= 1e-9)
      break;
    const sNew = (S0 * Skp - Sk * Sp) / den;
    if (!Number.isFinite(sNew) || Math.abs(sNew / s - 1) > LSQ_MAX_STEP)
      break;
    s = sNew;
    o = (Sp - Sk * s) / S0;
  }
  return s;
}

/** Least-squares refinement, then the whole-pixel lock (integer size when that drifts < LOCK_DRIFT px over the art). */
function finalise(lx: AxisLines, ly: AxisLines, s0: number, ox0: number, oy0: number, range: SizeRange): { s: number; ox: number; oy: number } {
  let { s, ox, oy } = refine(lx, ly, s0, ox0, oy0, false);
  if (s < range.min || s > range.max) {
    s = Math.min(range.max, Math.max(range.min, s));
    ({ ox, oy } = refine(lx, ly, s, ox, oy, true));
  }
  const ext = Math.max(lx.hi - lx.lo, ly.hi - ly.lo, 16);
  const rs = Math.round(s);
  if (rs >= range.min && rs <= range.max && Math.abs(s - rs) * (ext / s) < LOCK_DRIFT) {
    ({ ox, oy } = refine(lx, ly, rs, ox, oy, true));
    s = rs;
  }
  return { s, ox, oy };
}

/**
 * Largest size whose cells the content can show enough of: the shorter content extent over MIN_CELLS (or
 * MIN_CELLS_EXPLICIT with a user-given maxSize), never below the range minimum + 2 so the search is not empty.
 */
function contentMaxSize(lx: AxisLines, ly: AxisLines, range: SizeRange): number {
  const extMin = Math.max(16, Math.min(lx.hi - lx.lo, ly.hi - ly.lo));
  return Math.max(range.min + 2, extMin / (range.explicitMax ? MIN_CELLS_EXPLICIT : MIN_CELLS));
}

/** Normalised vote of a lattice size: score (share of line weight explained above chance) and best phases. */
type Voter = (s: number) => { v: number; ox: number; oy: number };

/**
 * Vote scorer over one scale's lines. raw = kernel-weighted share of line weight on the best-phase lattice of each
 * axis; chance = the kernel area (4h / 3) over the period, or, for whole-number periods, the whole-pixel hit rate:
 * whole-pixel lines hit such a lattice once per period (with subsampled chroma, colour edges are quantised to even
 * positions and an even period catches them with probability 2 / n). Score = (raw - chance) / (1 - chance), 0 when
 * the chance level reaches CHANCE_MAX (the lattice cannot discriminate).
 */
function makeVoter(lx: AxisLines, ly: AxisLines, chroma420: boolean): Voter {
  const ext = Math.max(lx.hi - lx.lo, ly.hi - ly.lo, 16);
  const hist = new Float64Array(VOTE_BINS);
  const tw = lx.total + ly.total;
  let wInt = 0;
  let wEven = 0;
  for (const a of [lx, ly]) {
    for (let i = 0; i < a.n; i++) {
      const r = Math.round(a.pos[i]);
      if (Math.abs(a.pos[i] - r) < WHOLE_PX_TOL) {
        wInt += a.w[i];
        if (r % 2 === 0)
          wEven += a.w[i];
      }
    }
  }
  const fInt = tw > 0 ? wInt / tw : 0;
  const parity = chroma420 && wInt > 0 ? Math.max(wEven, wInt - wEven) / wInt : 0.5;
  return (s: number): { v: number; ox: number; oy: number } => {
    const h = kernelHalf(s);
    const vx = axisVote(lx, s, h, hist);
    const vy = axisVote(ly, s, h, hist);
    const raw = tw > 0 ? (vx.score + vy.score) / tw : 0;
    let chance = Math.min(CHANCE_MAX, (4 * h) / (3 * s));
    const n = Math.round(s);
    if (Math.abs(s - n) * (ext / s) < LOCK_DRIFT) {
      const hit = n % 2 === 0 ? (2 * parity) / n : 1 / n;
      chance = Math.max(chance, fInt * hit + (1 - fInt) * chance);
    }
    return { v: chance >= CHANCE_MAX ? 0 : (raw - chance) / (1 - chance), ox: vx.phase, oy: vy.phase };
  };
}

/** A scale needs MIN_AXIS_LINES lines on each axis, or 4x that on one axis. */
function enoughLines(lx: AxisLines, ly: AxisLines): boolean {
  return Math.min(lx.n, ly.n) >= MIN_AXIS_LINES || Math.max(lx.n, ly.n) >= 4 * MIN_AXIS_LINES;
}

/**
 * Lattice search on one scale's lines: coarse vote over the size range, harmonic choice (largest size scoring near
 * the best), fine vote, least squares and whole-pixel lock.
 */
function searchLattice(lx: AxisLines, ly: AxisLines, range: SizeRange, chroma420: boolean): { lat: Lattice; peaks: { s: number; v: number }[]; vote: Voter } {
  const ext = Math.max(lx.hi - lx.lo, ly.hi - ly.lo, 16);
  const fail = { lat: { s: range.min, ox: 0, oy: 0, v: 0, ok: false }, peaks: [], vote: (): { v: number; ox: number; oy: number } => ({ v: 0, ox: 0, oy: 0 }) };
  const sMax = Math.min(range.max, contentMaxSize(lx, ly, range));
  const sizes: number[] = [];
  const ratio = 1 + SIZE_STEP / ext;
  for (let s = range.min; s <= sMax * (1 + 1e-9); s *= ratio)
    sizes.push(s);
  if (sizes.length === 0 || !enoughLines(lx, ly))
    return fail;
  const vote = makeVoter(lx, ly, chroma420);
  const scores = new Float64Array(sizes.length);
  const phX = new Float64Array(sizes.length);
  const phY = new Float64Array(sizes.length);
  for (let j = 0; j < sizes.length; j++) {
    const r = vote(sizes[j]);
    scores[j] = r.v;
    phX[j] = r.ox;
    phY[j] = r.oy;
  }
  const peaks: { s: number; v: number; j: number }[] = [];
  let vMax = -Infinity;
  for (let j = 0; j < sizes.length; j++) {
    const v = scores[j];
    const l = j > 0 ? scores[j - 1] : -Infinity;
    const r = j < sizes.length - 1 ? scores[j + 1] : -Infinity;
    if (v >= l && v > r) {
      peaks.push({ s: sizes[j], v, j });
      vMax = Math.max(vMax, v);
    }
  }
  if (peaks.length === 0)
    return fail;
  const outPeaks = peaks.map((p) => ({ s: p.s, v: p.v })).sort((a, b) => b.v - a.v);
  // Suppress side lobes (peaks within PEAK_MERGE of a stronger one), then take the largest size scoring near the
  // best: sub-multiples of the true size explain the lines as well as it does, multiples clearly worse. Multiples
  // 2x / 3x of the best get a lower bar: the division check below takes them back when the profile disagrees.
  const kept: typeof peaks = [];
  for (const p of peaks.slice().sort((a, b) => b.v - a.v)) {
    if (!kept.some((q) => p.s / q.s < PEAK_MERGE && q.s / p.s < PEAK_MERGE))
      kept.push(p);
  }
  const top = kept[0];
  let chosen = top;
  for (const p of kept) {
    const r = p.s / top.s;
    const harm = top.s >= SUB_MIN_S && (Math.abs(r - 2) < 0.06 || Math.abs(r - 3) < 0.09);
    if (p.v >= (harm ? ALPHA_HARM : ALPHA) * vMax && p.s > chosen.s)
      chosen = p;
  }
  let s0 = chosen.s;
  let phx = phX[chosen.j];
  let phy = phY[chosen.j];
  // Fine vote with a narrower kernel around the chosen peak.
  const hist = new Float64Array(VOTE_BINS);
  let best = -Infinity;
  const fr = 1 + FINE_STEP / ext;
  const lo = Math.max(range.min, chosen.s / (1 + FINE_SPAN));
  const hi = Math.min(range.max, chosen.s * (1 + FINE_SPAN));
  for (let sf = lo; sf <= hi * (1 + 1e-9); sf *= fr) {
    const hf = Math.max(KH_MIN, FINE_KH_REL * sf);
    const vx = axisVote(lx, sf, hf, hist);
    const vy = axisVote(ly, sf, hf, hist);
    if (vx.score + vy.score > best) {
      best = vx.score + vy.score;
      s0 = sf;
      phx = vx.phase;
      phy = vy.phase;
    }
  }
  const { s, ox, oy } = finalise(lx, ly, s0, phx, phy, range);
  return { lat: { s, ox, oy, v: chosen.v, ok: true }, peaks: outPeaks, vote };
}

// ---------------------------------------------------------------- harmonic checks

/** Maximum of a line profile within +-r px of a continuous position (linear interpolation when no sample is inside). */
function windowMax(p: Float64Array, x: number, r: number): number {
  const a = Math.max(1, Math.ceil(x - r));
  const b = Math.min(p.length - 2, Math.floor(x + r));
  if (a > b) {
    if (x < 1 || x > p.length - 2)
      return 0;
    const i = Math.floor(x);
    const f = x - i;
    return p[i] * (1 - f) + p[i + 1] * f;
  }
  let m = 0;
  for (let i = a; i <= b; i++)
    m = Math.max(m, p[i]);
  return m;
}

/**
 * Sub-lattice evidence on one axis: the profile excess on the k - 1 interior points of each period (s / k apart)
 * relative to the excess on the lattice lines, both over the half-way points between sub-lattice points. ~0 when s
 * is the true size, ~1 when it is k times the true size. Returns `insignificant` when the lattice lines do not stand
 * out from the in-between level (excess < SUB_SIGNIFICANCE of their level): the profile does not resolve this lattice.
 */
function subRatio(p: Float64Array, lo: number, hi: number, s: number, o: number, k: number, insignificant: number): number {
  const r = Math.max(SUB_WIN_MIN, (SUB_WIN * s) / k);
  const k0 = Math.ceil((lo - o) / s);
  const k1 = Math.floor((hi - o) / s);
  let on = 0;
  let sub = 0;
  let base = 0;
  for (let q = k0; q <= k1; q++) {
    const x = o + q * s;
    on += windowMax(p, x, r);
    for (let m = 1; m < k; m++)
      sub += windowMax(p, x + (m * s) / k, r) / (k - 1);
    for (let m = 0; m < k; m++)
      base += windowMax(p, x + ((m + 0.5) * s) / k, r) / k;
  }
  const den = on - base;
  return den > 0 && den > SUB_SIGNIFICANCE * on ? (sub - base) / den : insignificant;
}

/** Strongest per-axis evidence for dividing size s by k (one axis suffices: cells are square). */
function divisionEvidence(f: ScaleResult, s: number, ox: number, oy: number, k: number): number {
  return Math.max(subRatio(f.px, f.lx.lo, f.lx.hi, s, ox, k, 0), subRatio(f.py, f.ly.lo, f.ly.hi, s, oy, k, 0));
}

/**
 * Evidence against promoting size s to k s: per axis the sub-lattice ratio of the k s lattice at its best phase
 * (o + m s), the larger of the two axes, and those phases. Infinite when the k s lattice is not resolved.
 */
function promotionEvidence(f: ScaleResult, s: number, ox: number, oy: number, k: number): { ratio: number; ox: number; oy: number } {
  let bestX = Infinity;
  let bestY = Infinity;
  let phx = ox;
  let phy = oy;
  for (let m = 0; m < k; m++) {
    const rx = subRatio(f.px, f.lx.lo, f.lx.hi, k * s, ox + m * s, k, Infinity);
    const ry = subRatio(f.py, f.ly.lo, f.ly.hi, k * s, oy + m * s, k, Infinity);
    if (rx < bestX) {
      bestX = rx;
      phx = ox + m * s;
    }
    if (ry < bestY) {
      bestY = ry;
      phy = oy + m * s;
    }
  }
  return { ratio: Math.max(bestX, bestY), ox: phx, oy: phy };
}

/**
 * Phase coherence of a profile with the lattice o + k s over [lo, hi]: the profile-weighted mean of
 * cos(2 pi (b - o) / s), clipped at 0. 1 when all edge support sits on the grid lines, ~0 for no relation.
 */
function coherence(p: Float64Array, lo: number, hi: number, s: number, o: number): number {
  let re = 0;
  let tot = 0;
  for (let b = Math.max(1, Math.floor(lo)); b <= Math.min(p.length - 1, Math.ceil(hi)); b++) {
    re += p[b] * Math.cos((2 * Math.PI * (b - o)) / s);
    tot += p[b];
  }
  return tot > 0 ? Math.max(0, re / tot) : 0;
}

// ---------------------------------------------------------------- whole-cell error

/**
 * Whole-cell squared error per pixel (premultiplied RGBA) over the window [x0, x1) x [y0, y1), every rowStep-th row:
 * each pixel belongs to the cell holding its centre, and a cell's error is the squared deviation from its mean.
 */
function makeCellError(img: RgbaImage, x0: number, x1: number, y0: number, y1: number, rowStep: number): (s: number, ox: number, oy: number) => number {
  const { width: w, data } = img;
  const ww = x1 - x0;
  const colIdx = new Int32Array(ww);
  const acc = new Float64Array((ww + 2) * 6);
  return (s: number, ox: number, oy: number): number => {
    const kx0 = Math.floor((x0 + 0.5 - ox) / s);
    let ncx = 0;
    for (let x = 0; x < ww; x++) {
      const k = Math.floor((x0 + x + 0.5 - ox) / s) - kx0;
      colIdx[x] = k;
      ncx = k + 1;
    }
    let sse = 0;
    let npx = 0;
    const flush = (): void => {
      for (let c = 0; c < ncx; c++) {
        const o = c * 6;
        const n = acc[o + 5];
        if (n > 0) {
          sse += acc[o + 4] - (acc[o] * acc[o] + acc[o + 1] * acc[o + 1] + acc[o + 2] * acc[o + 2] + acc[o + 3] * acc[o + 3]) / n;
          npx += n;
        }
      }
      acc.fill(0, 0, ncx * 6);
    };
    let rowCell = Math.floor((y0 + 0.5 - oy) / s);
    for (let y = y0; y < y1; y += rowStep) {
      const rc = Math.floor((y + 0.5 - oy) / s);
      if (rc !== rowCell) {
        flush();
        rowCell = rc;
      }
      let p = (y * w + x0) * 4;
      for (let x = 0; x < ww; x++, p += 4) {
        const o = colIdx[x] * 6;
        const a = data[p + 3];
        let r = data[p];
        let g = data[p + 1];
        let b = data[p + 2];
        if (a !== 255) {
          const f = a / 255;
          r *= f;
          g *= f;
          b *= f;
        }
        acc[o] += r;
        acc[o + 1] += g;
        acc[o + 2] += b;
        acc[o + 3] += a;
        acc[o + 4] += r * r + g * g + b * b + a * a;
        acc[o + 5]++;
      }
    }
    flush();
    return npx > 0 ? sse / npx : 0;
  };
}

/**
 * Half-cell check: the line fit can lock onto mid-cell lines (mixels) instead of the cell borders. Each axis' phase is
 * shifted by half a cell when that lowers the whole-cell error over the content extent by FLIP_GAIN or more (same
 * size, so the comparison is fair).
 */
function halfCellCheck(img: RgbaImage, f: ScaleResult, s: number, ox: number, oy: number): { ox: number; oy: number; flipX: boolean; flipY: boolean } {
  const x0 = Math.max(0, Math.floor(f.lx.lo));
  const x1 = Math.min(img.width, Math.ceil(f.lx.hi) + 1);
  const y0 = Math.max(0, Math.floor(f.ly.lo));
  const y1 = Math.min(img.height, Math.ceil(f.ly.hi) + 1);
  if (x1 - x0 < 4 * s || y1 - y0 < 4 * s)
    return { ox, oy, flipX: false, flipY: false };
  const rowStep = Math.max(1, Math.min(Math.floor(s / 4), Math.ceil(((x1 - x0) * (y1 - y0)) / FLIP_PIXELS)));
  const err = makeCellError(img, x0, x1, y0, y1, rowStep);
  const e00 = err(s, ox, oy);
  const flipX = err(s, ox + s / 2, oy) < (1 - FLIP_GAIN) * e00;
  const flipY = err(s, ox, oy + s / 2) < (1 - FLIP_GAIN) * e00;
  return { ox: flipX ? ox + s / 2 : ox, oy: flipY ? oy + s / 2 : oy, flipX, flipY };
}

// ---------------------------------------------------------------- entry points

/** Lines and lattice of one edge scale; both axes share the larger of their two noise thresholds. */
function analyseScale(pl: Planes, bg: Uint8Array | null, sc: { gap: number; smooth: boolean; nms: boolean }, range: SizeRange, chroma420: boolean): ScaleResult {
  const { w, h } = pl;
  const dsx = smoothAlong(stepMap(pl, bg, sc.gap, true), w, h, true, ALONG_RADIUS);
  const dsy = smoothAlong(stepMap(pl, bg, sc.gap, false), w, h, false, ALONG_RADIUS);
  const tx = stepThreshold(dsx, pl, bg, true, sc.gap);
  const ty = stepThreshold(dsy, pl, bg, false, sc.gap);
  const lines = (T: number): { px: Float64Array; py: Float64Array; lx: AxisLines; ly: AxisLines } => {
    const px = profile(dsx, w, h, true, T, sc.nms);
    const py = profile(dsy, w, h, false, T, sc.nms);
    if (sc.smooth) {
      smoothProfile(px);
      smoothProfile(py);
    }
    return { px, py, lx: detectLines(px, w), ly: detectLines(py, h) };
  };
  const T = Math.max(tx.T, ty.T);
  let { px, py, lx, ly } = lines(T);
  const low = Math.max(tx.low, ty.low);
  if (!enoughLines(lx, ly) && low < T)
    ({ px, py, lx, ly } = lines(low));
  jpegGuard(lx, ly);
  const r = searchLattice(lx, ly, range, chroma420);
  return { px, py, lx, ly, lat: r.lat, peaks: r.peaks, vote: r.vote };
}

/** Effective size range: options, defaults, and the content extent (the art spans enough cells). */
function sizeRange(opts: EstimateOptions, w: number, h: number): SizeRange {
  // Non-finite values (e.g. a parsed empty input box) count as not given.
  const given = (v: number | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const optMin = given(opts.minSize);
  const optMax = given(opts.maxSize);
  const explicitMax = optMax !== undefined;
  let max = Math.max(ABS_MIN_SIZE, optMax ?? DEFAULT_MAX_SIZE);
  let min = Math.max(ABS_MIN_SIZE, optMin ?? Math.min(DEFAULT_MIN_SIZE, max));
  if (opts.integerOnly) {
    min = Math.ceil(min);
    max = Math.max(min, Math.floor(max));
  }
  max = Math.min(max, Math.max(min, Math.min(w, h) / (explicitMax ? MIN_CELLS_EXPLICIT : MIN_CELLS)));
  return { min, max: Math.max(min, max), explicitMax };
}

/**
 * Whole-pixel grid for integerOnly: the nearest whole size to the free estimate (within the range); when the estimate
 * sits near the middle between two whole sizes (within WHOLE_TIE px), the one the fine lines vote for more strongly.
 * Phases are re-fitted at that size and rounded to whole pixels. An image scaled by a whole factor already comes out
 * whole; for a fractional scale this is the nearest whole-pixel reading.
 */
function wholePixelGrid(fine: ScaleResult, range: SizeRange, s: number): { s: number; ox: number; oy: number } {
  const lo = Math.ceil(range.min);
  const hi = Math.max(lo, Math.floor(range.max));
  const near = Math.abs(s - Math.round(s)) < 0.5 - WHOLE_TIE ? [Math.round(s)] : [Math.floor(s), Math.ceil(s)];
  const cands = [...new Set(near.map((n) => Math.min(hi, Math.max(lo, n))))];
  let best = cands[0];
  let bestV = -Infinity;
  for (const n of cands) {
    const v = fine.vote(n).v;
    if (v > bestV) {
      bestV = v;
      best = n;
    }
  }
  const ph = fine.vote(best);
  const r = refine(fine.lx, fine.ly, best, ph.ox, ph.oy, true);
  return { s: best, ox: Math.round(r.ox), oy: Math.round(r.oy) };
}

/**
 * Full analysis: the estimate plus diagnostics. Sizes are searched within opts.minSize .. opts.maxSize (defaults
 * DEFAULT_MIN_SIZE .. DEFAULT_MAX_SIZE, the latter also capped so the art spans MIN_CELLS cells); minSize ===
 * maxSize fits only the offsets for that size. integerOnly restricts the size and the offsets to whole pixels.
 */
export function analyseGrid(img: RgbaImage, opts: EstimateOptions = {}): GridAnalysis {
  return analyse(img, opts, 0);
}

/** analyseGrid at a recursion depth (the integer-upscale diagnostic analyses a downscaled copy once). */
function analyse(img: RgbaImage, opts: EstimateOptions, depth: number): GridAnalysis {
  const { width: w, height: h } = img;
  const range = sizeRange(opts, w, h);
  const fallbackSize = Math.min(range.max, Math.max(range.min, Math.min(w, h) / FALLBACK_DIV));
  const empty: GridAnalysis = {
    estimate: { size: fallbackSize, offsetX: 0, offsetY: 0, confidence: 0 },
    alternatives: [], steps: [], sizeX: fallbackSize, sizeY: fallbackSize, background: false, chroma420: false,
    halfEvidence: 0, doubleEvidence: Infinity, vote: 0, coherence: 0, upscaled: null
  };
  if (Math.min(w, h) < SCALES[0].minSide)
    return empty;
  const pl = colourPlanes(img);
  const bg = backgroundMask(img);
  const c420 = chromaSubsampled(img);
  const scales: ScaleResult[] = [];
  for (const sc of SCALES) {
    const scaleRange = { ...range, min: Math.max(range.min, sc.sMin) };
    if (scales.length > 0 && (scaleRange.min > range.max || Math.min(w, h) < sc.minSide))
      continue;
    if (scales.length === 0 && scaleRange.min > range.max)
      scaleRange.min = range.min;
    scales.push(analyseScale(pl, bg, sc, scaleRange, c420));
  }
  let chosen = 0;
  for (let i = 1; i < scales.length; i++) {
    if (scales[i].lat.ok && (!scales[chosen].lat.ok || scales[i].lat.v > scales[chosen].lat.v + SCALE_MARGIN)) {
      // The coarse pairs cannot resolve small cells: when a strong fine lattice divides the coarse one, the coarse
      // lattice is a pattern pitch (tiles, icon slots, 2x2 blocks) and the fine one stays.
      const r = scales[i].lat.s / scales[0].lat.s;
      const k = Math.round(r);
      const fineDivides = scales[0].lat.ok && scales[0].lat.v >= FINE_STRONG && k >= 2 && Math.abs(r - k) < MULTIPLE_TOL * k;
      if (!fineDivides)
        chosen = i;
    }
  }
  const lat = scales[chosen].lat;
  if (!lat.ok)
    return { ...empty, background: bg !== null, chroma420: c420 };
  const fine = scales[0];
  let { s, ox, oy } = lat;
  const steps: string[] = [];
  // Divide while a sub-lattice carries edges about as strong as the grid lines (the line detector missed them, or
  // the vote preferred a structured multiple such as a tile or icon pitch).
  for (let round = 0; round < HARMONIC_ROUNDS; round++) {
    const k = SUB_DIVISORS.find((d) => {
      if (s / d < Math.max(SUB_MIN_S, range.min) || divisionEvidence(fine, s, ox, oy, d) < SUB_RATIO)
        return false;
      return fine.vote(s / d).v >= DIV_VOTE_GAIN * Math.max(fine.vote(s).v, lat.v);
    });
    if (k === undefined)
      break;
    ({ s, ox, oy } = finalise(fine.lx, fine.ly, s / k, ox, oy, range));
    steps.push(`div${k}`);
  }
  // Promote while twice the size explains the fine profile with nearly empty in-between lines (the complement of the
  // division test, with hysteresis: a lattice whose half-lines carry PROMOTE_RATIO .. SUB_RATIO of its excess stays).
  for (let round = 0; round < HARMONIC_ROUNDS && steps.length === 0; round++) {
    const big = PROMOTE_FACTOR * s;
    if (s < SUB_MIN_S || big > Math.min(range.max, contentMaxSize(fine.lx, fine.ly, range)))
      break;
    const ev = promotionEvidence(fine, s, ox, oy, PROMOTE_FACTOR);
    const voter = scales[chosen].vote;
    if (!(ev.ratio < PROMOTE_RATIO) || voter(big).v < PROMOTE_VOTE * voter(s).v)
      break;
    ({ s, ox, oy } = finalise(fine.lx, fine.ly, big, ev.ox, ev.oy, range));
    steps.push(`x${PROMOTE_FACTOR}`);
  }
  const flip = halfCellCheck(img, fine, s, ox, oy);
  ox = flip.ox;
  oy = flip.oy;
  if (flip.flipX)
    steps.push('flipX');
  if (flip.flipY)
    steps.push('flipY');
  if (opts.integerOnly && (!Number.isInteger(s) || !Number.isInteger(ox) || !Number.isInteger(oy))) {
    ({ s, ox, oy } = wholePixelGrid(fine, range, s));
    steps.push('whole');
  }
  // Confidence: share of edge support on the grid lines, reduced for tiny cells and when the harmonic statistics sit
  // near the halving / doubling thresholds (half or double the size is then a plausible reading).
  const half = s / 2 >= SUB_MIN_S ? divisionEvidence(fine, s, ox, oy, 2) : 0;
  const dbl = s >= SUB_MIN_S ? promotionEvidence(fine, s, ox, oy, PROMOTE_FACTOR).ratio : Infinity;
  let ambiguity = Math.min(1, Math.max(0, half / SUB_RATIO));
  if (Number.isFinite(dbl))
    ambiguity = Math.max(ambiguity, Math.min(1, Math.max(0, (SUB_RATIO - dbl) / (SUB_RATIO - PROMOTE_RATIO))));
  const coh = 0.5 * (coherence(fine.px, fine.lx.lo, fine.lx.hi, s, ox) + coherence(fine.py, fine.ly.lo, fine.ly.hi, s, oy));
  const confidence = Math.min(1, Math.max(0, coh * Math.min(1, s / CONF_SMALL_SIZE) * (1 - CONF_AMBIGUITY * ambiguity)));
  const alternatives: { size: number; score: number }[] = [];
  for (const p of scales[chosen].peaks) {
    if (alternatives.length < ALT_MAX && Math.abs(p.s / s - 1) > MULTIPLE_TOL && !alternatives.some((a) => Math.abs(a.size / p.s - 1) < MULTIPLE_TOL))
      alternatives.push({ size: p.s, score: p.v });
  }
  const used = steps.some((t) => t.startsWith('div') || t.startsWith('x')) ? fine : scales[chosen];
  let upscaled: GridAnalysis['upscaled'] = null;
  if (depth === 0 && Number.isInteger(s) && s >= 2 && s <= UPSCALE_MAX && lat.v >= UPSCALE_VOTE && steps.every((t) => t.startsWith('flip'))) {
    const k = s;
    const px0 = mod(Math.round(ox), k);
    const py0 = mod(Math.round(oy), k);
    const sub = analyse(downsample(img, k, px0, py0), { maxSize: range.explicitMax ? range.max / k : undefined }, depth + 1);
    if (sub.vote > 0 && k * sub.estimate.size <= range.max) {
      const S = k * sub.estimate.size;
      upscaled = {
        factor: k, size: S, offsetX: cleanOffset(px0 + k * sub.estimate.offsetX, S), offsetY: cleanOffset(py0 + k * sub.estimate.offsetY, S),
        confidence: sub.estimate.confidence ?? 0
      };
      alternatives.unshift({ size: S, score: sub.vote });
      alternatives.length = Math.min(alternatives.length, ALT_MAX);
    }
  }
  return {
    estimate: { size: s, offsetX: cleanOffset(ox, s), offsetY: cleanOffset(oy, s), confidence },
    alternatives,
    steps,
    sizeX: refineAxis(used.lx, s, ox),
    sizeY: refineAxis(used.ly, s, oy),
    background: bg !== null,
    chroma420: c420,
    halfEvidence: half,
    doubleEvidence: dbl,
    vote: lat.v,
    coherence: coh,
    upscaled
  };
}

/** k x k block means (premultiplied, then straightened) of the image starting at pixel (x0, y0). */
function downsample(img: RgbaImage, k: number, x0: number, y0: number): RgbaImage {
  const { width: w, data } = img;
  const W = Math.max(0, Math.floor((img.width - x0) / k));
  const H = Math.max(0, Math.floor((img.height - y0) / k));
  const out = new Uint8Array(W * H * 4);
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < k; j++) {
        let p = ((y0 + Y * k + j) * w + x0 + X * k) * 4;
        for (let i = 0; i < k; i++, p += 4) {
          const al = data[p + 3];
          r += data[p] * al;
          g += data[p + 1] * al;
          b += data[p + 2] * al;
          a += al;
        }
      }
      const q = (Y * W + X) * 4;
      if (a > 0) {
        out[q] = Math.round(r / a);
        out[q + 1] = Math.round(g / a);
        out[q + 2] = Math.round(b / a);
      }
      out[q + 3] = Math.round(a / (k * k));
    }
  }
  return { width: W, height: H, data: out };
}

/**
 * Estimates the fake-pixel grid of a pseudo-pixel-art image: size in px (may be fractional), offsets in [0, size)
 * (grid lines at offset + k * size; a line at x = 5 is the left edge of pixel column 5) and a confidence in [0, 1].
 * Options restrict the size range or force whole-pixel sizes; with minSize === maxSize only the offsets are fitted
 * (e.g. after the user typed a size).
 */
export function estimateGrid(img: RgbaImage, opts: EstimateOptions = {}): GridEstimate {
  return analyseGrid(img, opts).estimate;
}
