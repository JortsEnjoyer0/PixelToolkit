// Rectifier for Rectify To Grid (docs/img2pixel/img2pixel.md "Algorithm"): one solid colour per grid cell, palette
// consolidation, background detection / removal and make-square padding. Pure, deterministic functions over straight
// RGBA; no dependencies, no DOM or node APIs. Tested by scripts/test-pixelart.ts.
//
// Pipeline (rectifyDetailed)
//   1. PSF / phase fit (opaque inputs): on the busiest crop, a forward model (cell colours blurred by a Gaussian
//      PSF, edges on pixel boundaries) is fitted to the pixels for sigma and a phase correction (dx, dy) within
//      +-0.3 cell; crops near both ends of the busy extent add a linear phase drift (a size error). Every sampling
//      window follows the corrected cell positions (clamped to +-0.45 cell); the output grid is unchanged.
//  1b. Edge snapping ("Snap to pixel edges", RectifyOptions.snapToEdges; cells >= snap.minSize px). AI sprite sheets
//      are not one uniform grid: each sprite can sit at its own sub-cell phase. The grid and the output size stay
//      as they are (one output pixel per uniform cell), but each cell's sampling window follows the real fake-pixel
//      edges near it. Edge profiles per band of snap.band output rows (for the vertical lines) and columns (for the
//      horizontal lines; mode 'line': one whole-image profile per axis): the summed luma + alpha difference across
//      every pixel boundary, pairs that are both background skipped, JPEG 8 x 8 block steps removed. Every line of
//      the phase-corrected grid then moves on its own (anchored on its unsnapped position, so errors never
//      accumulate) to the strongest profile peak within +-snap.window cell when that peak is a local maximum >=
//      snap.gain x the profile at the line's current boundary (sub-pixel parabola). With the default window of half
//      a cell every output cell samples the real fake pixel nearest to it. regularise() rejects moves that
//      neighbouring lines do not share (clutter) and fills lines whose edge sits just outside the window;
//      neighbouring bands are median-smoothed, and bands without edge evidence (background) take their neighbours'
//      lines or the whole-image result. Lines keep their order with a gap >= snap.minGap cell. A cell's window is
//      built from its own snapped left / right (top / bottom) lines.
//   2. Cell windows: per axis, the pixels whose centres lie at least `margin` (0.25 cell) inside the cell. For cells
//      of 6 px and more a window that is not homogeneous may shift by up to 0.25 cell to the most homogeneous spot.
//   3. Cell colour: alpha majority (window mostly transparent -> transparent cell), then a mean-shift mode of the
//      opaque samples started at the per-channel median (rejects neighbour bleed, averages noise away).
//   4. Small cells (< 6 px) with a fitted PSF sigma >= 0.2 px: Jacobi deconvolution of the window means in cell
//      space with the fitted PSF and phase (recovers colours that blur mixed with the neighbours).
//   5. Palette merge: leader clustering of the cell colours with a tolerance from the art cells' neighbour noise,
//      Lloyd refinement, then overlapping clusters (centre distance <= sum of their RMS radii) merge; every member
//      cell takes the cluster mean, so flat regions come out as exactly one colour.
//   6. Background (on output cells, after their colours are known): detectBackground() on the source border band
//      (dominant colour, tolerance from its noise; null when it covers < 60 % of the border pixels or of the border's
//      4 x 4 block means within 20 RGB, i.e. not one solid colour). With the default pockets 'all' every cell within
//      the cell tolerance is background, enclosed or not (the user picks background colours the art does not use);
//      'size' keeps only border-connected regions plus tight enclosed ones. Then one ring of silhouette cells within
//      2x the tolerance (soft-edge halo) and isolated specks. On a chroma-key background keyFringe also removes
//      off-key cells and un-blends key-tinted edge cells (skipped when the art itself uses the key's hue).
//      Removed -> transparent; kept -> painted in the solid background colour.
//   7. makeSquare: pad to max(w, h), centred (floor): transparent with removeBackground or a transparent input,
//      otherwise the background colour (the dominant output border colour when no solid background was found).
// Output size: one pixel per grid cell whose centre lies inside the image (outputDims, gridCells in grid.ts).
import type { RgbaImage } from '@shared/image';
import { gridCells, type GridSpec } from './grid';
import { quantizeColors } from './quantize';

export interface RectifyOptions {
  /** Make the background cells transparent (otherwise they are painted in the one solid background colour). */
  removeBackground: boolean;
  /** Pad the output to a square (background colour, or transparent when removing the background). */
  makeSquare: boolean;
  /** Merge near-identical colours (noise) into one (palette merge, step 5). */
  mergeColors: boolean;
  /**
   * Let each cell's sampling follow nearby fake-pixel edges instead of the exact uniform grid (sprites offset from the
   * global grid, e.g. on sprite sheets; step 1b). The grid and the output size are unchanged.
   */
  snapToEdges: boolean;
  /** At most this many opaque colours (quantize.ts, one of COLOR_LIMITS); 0 = no limit. */
  maxColors: number;
}

export interface RectifyResult {
  image: RgbaImage;
  /** Detected solid background colour; null when the border is not one solid colour (or is transparent). */
  background: [number, number, number] | null;
  /** Distinct opaque colours in the output. */
  colorCount: number;
}

// ---------------------------------------------------------------- grid convention

function mod(a: number, m: number): number {
  const r = a % m;
  return r < 0 ? r + m : r;
}

/** Smallest cell size rectify() accepts: a 1 px grid is the identity (smaller would output more cells than pixels). */
const MIN_CELL_SIZE = 1;

/**
 * Grid with a valid size (>= MIN_CELL_SIZE, finite) and offsets wrapped into [0, size) (non-finite offsets become 0),
 * not rounded (unlike normalizeGrid), so a hand-typed or corrupted grid can neither produce NaN dimensions nor hang.
 */
function normaliseGrid(g: GridSpec): GridSpec {
  const size = Number.isFinite(g.size) && g.size > MIN_CELL_SIZE ? g.size : MIN_CELL_SIZE;
  const off = (o: number): number => (Number.isFinite(o) ? mod(o, size) : 0);
  return { size, offsetX: off(g.offsetX), offsetY: off(g.offsetY) };
}

/**
 * Output size of rectify() for a grid and an input size (before makeSquare): one output pixel per grid cell whose
 * centre lies inside the image. firstX / firstY are the grid indices of output column / row 0 (0 or -1 for a partial
 * first cell). Input pixel x belongs to column k iff offsetX + k * size <= x + 0.5 < offsetX + (k + 1) * size.
 */
export function outputDims(grid: GridSpec, width: number, height: number): { width: number; height: number; firstX: number; firstY: number } {
  const g = normaliseGrid(grid);
  const x = gridCells(width, g.size, g.offsetX);
  const y = gridCells(height, g.size, g.offsetY);
  return { width: x.count, height: y.count, firstX: x.first, firstY: y.first };
}

/**
 * Edge snapping (step 1b), used when RectifyOptions.snapToEdges is set. DEFAULTS.snap was tuned on synthetic sprite
 * sheets (sprites at their own phase and fake-pixel size on one sheet) and checked on the single-grid synthetic sets.
 */
export interface SnapConfig {
  /**
   * 'off' never snaps; 'line' whole-image profiles (one set of lines for the whole image: it cannot follow two sprites
   * of one column at different phases); 'band' one profile per band of `band` cells (2-D).
   */
  mode: 'off' | 'line' | 'band';
  /**
   * Search half-window around each line, as a fraction of the cell size. Half a cell reaches every phase a sprite can
   * have against the grid; smaller windows (0.15..0.4) leave the sprites furthest out of phase unchanged.
   */
  window: number;
  /** A line moves only to a peak >= gain x the profile at its current boundary. */
  gain: number;
  /**
   * Evidence floor: the peak's strength per counted pair, with the pair count raised to at least floorPairs cells'
   * worth of pixels, must reach floor x the q25 per-pair strength of the whole-image profile (0 = off). Below it the
   * line is WEAK (no evidence: it does not move, and in band mode takes its neighbouring bands' or the fallback).
   */
  floor: number;
  floorPairs: number;
  /**
   * No snapping below this cell size (px): smaller cells leave too few pixels between edges for reliable peaks
   * (raising it to 5 or 6 px gave up a third to a half of the sprite-sheet gain).
   */
  minSize: number;
  /** Band height (width) in cells for mode 'band'. */
  band: number;
  /** Pixel difference: luma |dY| or colour L1 |dR| + |dG| + |dB| (both + |dA|). */
  profile: 'luma' | 'colour';
  /** Skip pixel pairs that are both background (detectBackground colour within its tolerance, or transparent). */
  bgPairs: boolean;
  /** Remove the JPEG 8 x 8 block steps from the profiles (see deblock). */
  deblock: boolean;
  /** Shrinkage: each pair adds max(0, difference - shrink x median pair difference) (0 = plain differences). */
  shrink: number;
  /** Parabolic sub-pixel refinement of the peak position. */
  subpixel: boolean;
  /** Minimum distance between neighbouring snapped lines, as a fraction of the cell size. */
  minGap: number;
  /**
   * Band mode, 'median3': a line takes the median of its own and its two neighbouring bands' displacements when both
   * neighbours have evidence (compared modulo the size with wrap), and a WEAK line the mean of its neighbouring bands
   * that have evidence. 'none': bands stay independent (WEAK lines take the fallback).
   */
  smooth: 'none' | 'median3';
  /**
   * Wrap consistency bound and gap filling (fraction of the size; 0 = off): see regularise. At most `window`, so a
   * line ends up at most half a cell (plus SUBPIXEL_REACH) from its unsnapped position (each cell keeps the nearest fake pixel;
   * larger bounds such as 0.75 keep a sprite drawn at another fake-pixel size on one phase for longer, which
   * samples cells up to 0.75 cell away from their uniform position).
   */
  wrap: number;
  /** Supporters a move > coherenceMin cell needs (0 = off), and their tolerance (cells): see regularise. */
  coherence: number;
  coherenceMin: number;
  coherenceTol: number;
  /** Band mode, WEAK line without a neighbouring band with evidence: whole-image result ('line') or no move ('base'). */
  fallback: 'base' | 'line';
  /**
   * Keep the per-cell window re-centring (step 2) on snapped windows: it still fixes residual offsets of >= 6 px
   * cells (turning it off lost a quarter to two thirds of the sprite-sheet gain).
   */
  recentre: boolean;
}

export interface RectifyConfig {
  /** Edge snapping (step 1b): only with RectifyOptions.snapToEdges. */
  snap: SnapConfig;
  /** Window margin as a fraction of the cell size (0.25 = inner 50 %). */
  margin: number;
  /** Max window samples per cell (stride-subsampled above this). */
  maxSamples: number;
  /** Cell colour estimator: mean-shift mode (default) or per-channel median. */
  colour: 'meanshift' | 'median';
  /** Mean-shift radius = max(msMin, msK * pixel sigma), iterations. */
  msK: number;
  msMin: number;
  msIters: number;
  /** Palette merge on/off; leader tolerance tau = clamp(mergeK * neighbour noise, mergeMin, mergeMax). */
  merge: boolean;
  mergeK: number;
  mergeMin: number;
  mergeMax: number;
  /** Quantile of the art cells' nearest-neighbour colour distance used as the cell noise scale. */
  mergeQ: number;
  /** Lloyd refinement iterations after the leader pass. */
  mergeIters: number;
  /** Overlap merge: clusters merge when centre distance <= absorbSep * (sum of their RMS radii). */
  absorbSep: number;
  /** RMS radius floor of a cluster = spreadFloorK * neighbour noise (singletons get a nominal spread). */
  spreadFloorK: number;
  /** Small-cell deconvolution: 0 = off, -1 = auto (fitted sigma), > 0 = fixed sigma in px. */
  deconv: number;
  /** Deconvolution runs for cells smaller than this (px) when the fitted sigma >= deconvMinSigma. */
  deconvMaxSize: number;
  deconvMinSigma: number;
  /** Jacobi iterations of the final deconvolution and inside the PSF fit. */
  deconvIters: number;
  psfFitIters: number;
  /** PSF / phase fit crop: about psfCropPx px per side, 12..psfCropCells cells; residual pixel budget. */
  psfCropPx: number;
  psfCropCells: number;
  psfPixels: number;
  /** Shift the sampling windows by the fitted phase; also fit a linear drift (min drift in cells to accept it). */
  phaseFix: boolean;
  drift: boolean;
  driftMin: number;
  /** Per-cell window re-centring: max shift as a fraction of the cell, min cell size (px), homogeneity factor. */
  recentre: number;
  recentreMinS: number;
  recentreHomog: number;
  /** Minimum share of border pixels matching the dominant border colour for a solid background. */
  bgCoverage: number;
  /** Cell background tolerance = clamp(max(6, 3 * median, 1.5 * p95 of border cells, bgTolFrac * px tol), px tol). */
  bgTolFrac: number;
  /** Enclosed bg-like regions: 'size' removes those of >= pocketMin cells within pocketTight * tolerance. */
  pockets: 'none' | 'size' | 'all';
  pocketMin: number;
  pocketTight: number;
  /**
   * Chroma-key background: max - min channel >= keyChroma. With pockets 'size' single enclosed cells within
   * pocketTight * tolerance are removed too (art rarely uses the key colour, while 1-cell gaps of key colour are
   * common in AI sprites); with any policy it enables keyFringe. Infinity disables both.
   */
  keyChroma: number;
  /** Chroma-key cleanup (keyFringe): key-like cells within keyTolFrac * key saturation join the background. */
  keyTolFrac: number;
  /**
   * Edge-cell un-blending against the key (keyFringe): rings from the background, max fit residual (RGB) against a
   * neighbour colour and against a neutral colour, and the smallest key share acted on.
   */
  keyRings: number;
  keyBlendResidual: number;
  keyNeutralResidual: number;
  keyBlendMin: number;
  /** Largest share of interior art cells fitting as neutral + key for which the un-blending still runs. */
  keyArtShare: number;
  /** One ring of cells touching the background within halo * cell tolerance joins it (0 = off). */
  halo: number;
  /** Isolated opaque cells within despeckle * cell tolerance of the background join it (0 = off). */
  despeckle: number;
  /** removeBackground off: paint the detected background region in the one solid background colour. */
  flattenBg: boolean;
}

export const DEFAULTS: RectifyConfig = {
  snap: {
    mode: 'band',
    window: 0.5,
    gain: 1.5,
    floor: 2,
    floorPairs: 2,
    minSize: 4,
    band: 16,
    profile: 'luma',
    bgPairs: true,
    shrink: 0,
    deblock: true,
    subpixel: true,
    minGap: 0.5,
    smooth: 'median3',
    wrap: 0.5,
    coherence: 2,
    coherenceMin: 0.2,
    coherenceTol: 0.2,
    fallback: 'line',
    recentre: true
  },
  margin: 0.25,
  maxSamples: 96,
  colour: 'meanshift',
  msK: 3,
  msMin: 12,
  msIters: 3,
  merge: true,
  mergeK: 2.5,
  mergeMin: 4,
  mergeMax: 22,
  mergeQ: 0.25,
  mergeIters: 2,
  absorbSep: 1,
  spreadFloorK: 1.5,
  deconv: -1,
  deconvMaxSize: 6,
  deconvMinSigma: 0.2,
  deconvIters: 5,
  psfFitIters: 4,
  psfCropPx: 320,
  psfCropCells: 40,
  psfPixels: 12000,
  phaseFix: true,
  drift: true,
  driftMin: 0.12,
  recentre: 0.25,
  recentreMinS: 6,
  recentreHomog: 4,
  bgCoverage: 0.6,
  bgTolFrac: 0.75,
  pockets: 'all',
  pocketMin: 2,
  pocketTight: 0.75,
  keyChroma: 128,
  keyTolFrac: 0.15,
  keyRings: 2,
  keyBlendResidual: 24,
  keyNeutralResidual: 12,
  keyBlendMin: 0.25,
  keyArtShare: 0.05,
  halo: 2,
  despeckle: 2,
  flattenBg: true
};

type Rgb = [number, number, number];

/** Largest key share a neutral un-blend solves for (t = (c - a * key) / (1 - a) explodes as a nears 1). */
const KEY_MAX_SHARE = 0.95;

function sortedQuantile(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0)
    return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

// ---------------------------------------------------------------- background detection

export interface BackgroundInfo {
  /** Solid background colour, or null when the border is not dominated by one colour (or is transparent). */
  color: Rgb | null;
  /** Pixel-level RGB (Euclidean) tolerance around `color`, derived from the border noise. */
  tolerance: number;
  /** The border is mostly transparent already (input with alpha): the background is transparency. */
  transparent: boolean;
  /** Share of opaque border-band pixels within `tolerance` of the dominant colour. */
  coverage: number;
  /** Robust per-channel noise sigma of the border pixels near the dominant colour. */
  noise: number;
  /** Share of 4 x 4 px block means along the border within SOLID_RADIUS of the dominant colour (texture test). */
  solidity: number;
  /** Dominant border colour even when it is not a solid background. */
  dominant: Rgb | null;
}

/** Block-mean distance (RGB) within which border blocks count as the solid background colour. */
const SOLID_RADIUS = 20;

/**
 * Share of the 4 x 4 px blocks along the image border whose mean colour lies within radius of c. Block means
 * average pixel noise away but keep texture, so a noisy solid background scores ~1 and a textured scene low.
 */
function blockCoverage(img: RgbaImage, c: Rgb, radius: number, bs = 4): number {
  const { width: w, height: h, data } = img;
  let n = 0;
  let ok = 0;
  const block = (x0: number, y0: number): void => {
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let m = 0;
    for (let y = y0; y < Math.min(h, y0 + bs); y++) {
      for (let x = x0; x < Math.min(w, x0 + bs); x++) {
        const p = (y * w + x) * 4;
        if (data[p + 3] < 128)
          continue;
        s0 += data[p];
        s1 += data[p + 1];
        s2 += data[p + 2];
        m++;
      }
    }
    if (m === 0)
      return;
    n++;
    if (Math.hypot(s0 / m - c[0], s1 / m - c[1], s2 / m - c[2]) <= radius)
      ok++;
  };
  for (let x = 0; x + bs <= w; x += bs) {
    block(x, 0);
    block(x, h - bs);
  }
  for (let y = bs; y + 2 * bs <= h; y += bs) {
    block(0, y);
    block(w - bs, y);
  }
  return n ? ok / n : 1;
}

/**
 * Dominant colour of RGB samples (Float32 triples): fullest bin of two offset 16-level histograms, then mean shift
 * (radius 32, 32, 24, 24).
 */
function dominantColour(rgb: Float32Array, n: number): Rgb {
  let best = -1;
  let bestKey = 0;
  let bestShift = 0;
  for (const shift of [0, 8]) {
    const hist = new Int32Array(17 * 17 * 17);
    for (let i = 0; i < n; i++) {
      const k = (((rgb[i * 3] + shift) >> 4) * 17 + ((rgb[i * 3 + 1] + shift) >> 4)) * 17 + ((rgb[i * 3 + 2] + shift) >> 4);
      hist[k]++;
      if (hist[k] > best) {
        best = hist[k];
        bestKey = k;
        bestShift = shift;
      }
    }
  }
  let c: Rgb = [Math.floor(bestKey / 289) * 16 + 8 - bestShift, (Math.floor(bestKey / 17) % 17) * 16 + 8 - bestShift, (bestKey % 17) * 16 + 8 - bestShift];
  for (const radius of [32, 32, 24, 24]) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let m = 0;
    const r2 = radius * radius;
    for (let i = 0; i < n; i++) {
      const dr = rgb[i * 3] - c[0];
      const dg = rgb[i * 3 + 1] - c[1];
      const db = rgb[i * 3 + 2] - c[2];
      if (dr * dr + dg * dg + db * db <= r2) {
        sr += rgb[i * 3];
        sg += rgb[i * 3 + 1];
        sb += rgb[i * 3 + 2];
        m++;
      }
    }
    if (m === 0)
      break;
    c = [sr / m, sg / m, sb / m];
  }
  return c;
}

/** Border band (`band` px wide) as RGB floats of its opaque pixels, strided to about maxSamples pixels. */
function borderBand(img: RgbaImage, band: number, maxSamples = 24000): { rgb: Float32Array; n: number; transparent: number; total: number } {
  const { width: w, height: h, data } = img;
  const bw = Math.max(1, Math.min(band, Math.floor(w / 2), Math.floor(h / 2)));
  const cap = 2 * bw * (w + h);
  const st = Math.max(1, Math.ceil(cap / maxSamples));
  const rgb = new Float32Array(cap * 3);
  let n = 0;
  let transparent = 0;
  let total = 0;
  const take = (x: number, y: number): void => {
    const p = (y * w + x) * 4;
    total++;
    if (data[p + 3] < 128) {
      transparent++;
      return;
    }
    rgb[n * 3] = data[p];
    rgb[n * 3 + 1] = data[p + 1];
    rgb[n * 3 + 2] = data[p + 2];
    n++;
  };
  for (let y = 0; y < h; y++) {
    if (y < bw || y >= h - bw) {
      for (let x = y % st; x < w; x += st)
        take(x, y);
    } else if (y % st === 0) {
      for (let x = 0; x < bw; x++) {
        take(x, y);
        take(w - 1 - x, y);
      }
    }
  }
  return { rgb, n, transparent, total };
}

/**
 * Detects a solid background colour from the image border band (max(2, min(w, h) / 256) px). The background is
 * assumed to be one colour plus a little noise (and possibly a gentle gradient): the dominant border colour, a
 * tolerance of clamp(max(1.25 * p95, 3.5 * sigma), 10, 60) from the border pixels within 48 of it, and coverage =
 * the share of border pixels within that tolerance. color is null when the border is mostly transparent, or when
 * the coverage or the solidity (border block means within SOLID_RADIUS) is below minCoverage: no solid background,
 * e.g. a full-canvas tile or a painted scene.
 */
export function detectBackground(img: RgbaImage, minCoverage = DEFAULTS.bgCoverage): BackgroundInfo {
  const b = borderBand(img, Math.max(2, Math.round(Math.min(img.width, img.height) / 256)));
  if (b.transparent >= 0.5 * b.total || b.n === 0)
    return { color: null, tolerance: 0, transparent: true, coverage: 0, noise: 0, solidity: 0, dominant: null };
  const c = dominantColour(b.rgb, b.n);
  const d = new Float32Array(b.n);
  let nNear = 0;
  for (let i = 0; i < b.n; i++) {
    d[i] = Math.hypot(b.rgb[i * 3] - c[0], b.rgb[i * 3 + 1] - c[1], b.rgb[i * 3 + 2] - c[2]);
    if (d[i] <= 48)
      nNear++;
  }
  // Noise from the pixels near the dominant colour, robust to the non-background border pixels.
  const near = new Float32Array(nNear);
  nNear = 0;
  for (let i = 0; i < b.n; i++) {
    if (d[i] <= 48)
      near[nNear++] = d[i];
  }
  near.sort();
  // For isotropic Gaussian noise the 3D distance has median ~1.54 sigma.
  const noise = sortedQuantile(near, 0.5) / 1.54;
  const tolerance = Math.min(60, Math.max(10, 1.25 * sortedQuantile(near, 0.95), 3.5 * noise));
  let inl = 0;
  for (let i = 0; i < b.n; i++) {
    if (d[i] <= tolerance)
      inl++;
  }
  const coverage = inl / b.n;
  const dominant: Rgb = [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
  const solidity = blockCoverage(img, dominant, SOLID_RADIUS);
  const solid = coverage >= minCoverage && solidity >= minCoverage;
  return { color: solid ? dominant : null, tolerance, transparent: false, coverage, noise, solidity, dominant };
}

// ---------------------------------------------------------------- cell windows

interface AxisWindows {
  count: number;
  /** Inner window [lo, hi] (inclusive pixel indices) per output cell. */
  lo: Int32Array;
  hi: Int32Array;
}

/**
 * Per-axis sampling windows of `count` cells starting at grid index `first`: pixels whose centres lie at least
 * margin * size inside the cell (cell k spans [offset + shift[k] + k * size, ... + size)), clipped to the image
 * and the cell; at least the pixel containing the cell centre. With `disp` (count + 1 snapped line displacements,
 * step 1b) cell k spans [start + disp[k], start + size + disp[k + 1]) and its margin is margin x its own width.
 */
function axisWindows(offset: number, size: number, length: number, first: number, count: number, margin: number, shift?: Float64Array, disp?: Float64Array): AxisWindows {
  const lo = new Int32Array(count);
  const hi = new Int32Array(count);
  const m0 = Math.min(margin * size, (size - 1) / 2);
  for (let i = 0; i < count; i++) {
    const a0 = offset + (shift ? shift[i] : 0) + (first + i) * size;
    let a = a0;
    let b = a0 + size;
    let m = m0;
    if (disp) {
      const cw = size + disp[i + 1] - disp[i];
      a = a0 + disp[i];
      b = a0 + size + disp[i + 1];
      m = Math.min(margin * cw, (cw - 1) / 2);
    }
    // Pixel x is inside the window iff a + m <= x + 0.5 < b - m.
    let x0 = Math.ceil(a + m - 0.5);
    let x1 = Math.ceil(b - m - 0.5) - 1;
    const c0 = Math.max(0, Math.ceil(a - 0.5));
    const c1 = Math.min(length - 1, Math.ceil(b - 0.5) - 1);
    x0 = Math.max(x0, c0);
    x1 = Math.min(x1, c1);
    if (x1 < x0) {
      // Defensive: a partial edge cell shifted (phase fix + drift) out of the image keeps its nearest pixel inside it
      const c = Math.min(length - 1, Math.max(0, Math.min(c1, Math.max(c0, Math.floor((a + b) / 2)))));
      x0 = c;
      x1 = c;
    }
    lo[i] = x0;
    hi[i] = x1;
  }
  return { count, lo, hi };
}

/**
 * Sampling windows of every cell: x windows per band of output rows, y windows per band of output columns (a single
 * band without snapping or in snap mode 'line'). Cell (i, j) samples columns wx[rowBand[j]] at i and rows
 * wy[colBand[i]] at j.
 */
interface CellWindows {
  wx: AxisWindows[];
  wy: AxisWindows[];
  rowBand: Int32Array;
  colBand: Int32Array;
}

/** The plain separable windows (no snapping). */
function plainWindows(wx: AxisWindows, wy: AxisWindows): CellWindows {
  return { wx: [wx], wy: [wy], rowBand: new Int32Array(wy.count), colBand: new Int32Array(wx.count) };
}

// ---------------------------------------------------------------- edge snapping (step 1b)

/** JPEG block size (px): a JPEG adds a step at every pixel boundary on a multiple of it (deblock). */
const JPEG_BLOCK = 8;
/** deblock acts when the per-pair strength on block boundaries exceeds the other residues' median by this share. */
const DEBLOCK_MIN_EXCESS = 0.25;
/** deblock is skipped when at least this share of the lines sits on block boundaries (the steps are fake-pixel edges). */
const DEBLOCK_MAX_ON_BLOCK = 0.25;
/** Quantile of the whole-image per-pair edge strength that the evidence floor (snap.floor) is relative to. */
const FLOOR_QUANTILE = 0.25;
/** Gap filling (regularise): the nearest good lines on both sides must agree within this many cells. */
const GAP_FILL_AGREE = 0.25;

/** Edge snapping diagnostics. */
export interface SnapInfo {
  mode: SnapConfig['mode'];
  /** Number of row bands (x lines) and column bands (y lines); 1 each in mode 'line'. */
  rowBands: number;
  colBands: number;
  /** Lines over all bands, lines moved, and the mean |displacement| of the moved ones (cells). */
  lines: number;
  moved: number;
  meanMove: number;
  /** Unsnapped (phase-corrected) positions of the count + 1 lines per axis, and per band their displacement (px). */
  baseX: Float64Array;
  baseY: Float64Array;
  dispX: Float64Array[];
  dispY: Float64Array[];
}

/**
 * Position of each of the count + 1 lines of an axis on the phase-corrected grid: line j is shared by cells j - 1 and
 * j, whose per-cell phases (shift) differ only by the drift, so it sits at their mean.
 */
function baseLines(offset: number, size: number, first: number, count: number, shift?: Float64Array): Float64Array {
  const P = new Float64Array(count + 1);
  for (let j = 0; j <= count; j++) {
    let ph = 0;
    if (shift && count > 0)
      ph = j === 0 ? shift[0] : j === count ? shift[count - 1] : (shift[j - 1] + shift[j]) / 2;
    P[j] = offset + (first + j) * size + ph;
  }
  return P;
}

/** Per-band edge profiles and pair counts (edgeProfiles). */
interface EdgeProfiles { ex: Float64Array; nx: Float64Array; ey: Float64Array; ny: Float64Array }

/**
 * Edge profiles: ex[band * (W + 1) + x] sums the pixel difference across the boundary between columns x - 1 and x
 * over the pixel rows of a row band (rowBandPx), nx counts the pairs summed; ey / ny likewise per column band. Pairs
 * that are both transparent are always skipped, pairs that are both background (detectBackground colour within its
 * pixel tolerance) with bgPairs, so the background's noise and gradient do not vote.
 */
function edgeProfiles(img: RgbaImage, bg: BackgroundInfo, sc: SnapConfig, rowBandPx: Int32Array, nRB: number, colBandPx: Int32Array, nCB: number): EdgeProfiles {
  const { width: W, height: H, data } = img;
  const N = W * H;
  const skip = new Uint8Array(N);
  const c = sc.bgPairs ? bg.color : null;
  const t2 = bg.tolerance * bg.tolerance;
  for (let p = 0; p < N; p++) {
    const q = p * 4;
    if (data[q + 3] < 128) {
      skip[p] = 1;
    } else if (c) {
      const dr = data[q] - c[0];
      const dg = data[q + 1] - c[1];
      const db = data[q + 2] - c[2];
      if (dr * dr + dg * dg + db * db <= t2)
        skip[p] = 1;
    }
  }
  const luma = sc.profile === 'luma';
  const lum = new Float32Array(luma ? N : 0);
  if (luma) {
    for (let p = 0; p < N; p++)
      lum[p] = 0.299 * data[p * 4] + 0.587 * data[p * 4 + 1] + 0.114 * data[p * 4 + 2];
  }
  const diff = (p: number, q: number): number => {
    const a = p * 4;
    const b = q * 4;
    const da = Math.abs(data[a + 3] - data[b + 3]);
    if (luma)
      return Math.abs(lum[p] - lum[q]) + da;
    return Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]) + da;
  };
  // Shrinkage: every pair contributes max(0, difference - T), T = shrink x the median difference of the counted pairs
  // (sampled on every 4th row), so noise and low-contrast clutter (JPEG block steps, gradients) do not vote.
  let T = 0;
  if (sc.shrink > 0) {
    const hist = new Float64Array(1024);
    let cnt = 0;
    for (let y = 1; y < H; y += 4) {
      for (let x = 1; x < W; x++) {
        const p = y * W + x;
        for (const q of [p - 1, p - W]) {
          if (skip[p] && skip[q])
            continue;
          hist[Math.min(1023, Math.round(diff(p, q)))]++;
          cnt++;
        }
      }
    }
    let acc = 0;
    let med = 0;
    while (med < 1023 && acc + hist[med] < cnt / 2) {
      acc += hist[med];
      med++;
    }
    T = sc.shrink * Math.max(1, med);
  }
  const ex = new Float64Array(nRB * (W + 1));
  const nx = new Float64Array(nRB * (W + 1));
  const ey = new Float64Array(nCB * (H + 1));
  const ny = new Float64Array(nCB * (H + 1));
  for (let y = 0; y < H; y++) {
    const o = rowBandPx[y] * (W + 1);
    const row = y * W;
    for (let x = 1; x < W; x++) {
      const p = row + x;
      if (skip[p] && skip[p - 1])
        continue;
      const v = diff(p, p - 1) - T;
      if (v > 0)
        ex[o + x] += v;
      nx[o + x]++;
    }
  }
  for (let y = 1; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const p = row + x;
      if (skip[p] && skip[p - W])
        continue;
      const k = colBandPx[x] * (H + 1) + y;
      const v = diff(p, p - W) - T;
      if (v > 0)
        ey[k] += v;
      ny[k]++;
    }
  }
  return { ex, nx, ey, ny };
}

/** q-quantile of the per-pair strength e[b] / n[b] over the boundaries with at least minPairs pairs (0 when none). */
function perPairQuantile(e: Float64Array, n: Float64Array, minPairs: number, q: number): number {
  const v: number[] = [];
  for (let b = 1; b < e.length - 1; b++) {
    if (n[b] >= minPairs)
      v.push(e[b] / n[b]);
  }
  v.sort((p, r) => p - r);
  return sortedQuantile(v, q);
}

/** Per-line snapping status (snapProfile). */
const STAY = 0;
const MOVED = 1;
const WEAK = 2;
const REJECTED = 3;

/**
 * Snaps the lines `base` against one profile (entries o .. o + len of e / n; entry o + b is boundary b, between pixels
 * b - 1 and b). Per line, anchored on its own position P: the strongest boundary within +-window * size of P moves the
 * line when it is a local maximum of the profile (not the flank of an edge outside the window) and >= gain x the
 * profile at the line's current boundary ceil(P - 0.5); sub-pixel position by a parabola through the peak and its
 * neighbours. Writes displacements (px, 0 = not moved) to disp and a status per line: MOVED; STAY (the peak is the
 * current boundary); WEAK (no evidence: the peak's per-pair strength, pairs raised to floorPairs cells, is below
 * floor x level, or the line lies on / outside the image border); REJECTED (a peak elsewhere failed the tests).
 */
function snapProfile(e: Float64Array, n: Float64Array, o: number, len: number, base: Float64Array, size: number, sc: SnapConfig, level: number,
  disp: Float64Array, status: Uint8Array): void {
  const win = sc.window * size;
  const minPairs = sc.floorPairs * size;
  for (let j = 0; j < base.length; j++) {
    disp[j] = 0;
    status[j] = WEAK;
    const P = base[j];
    const b0 = Math.ceil(P - 0.5);
    const lo = Math.max(1, Math.ceil(P - win));
    const hi = Math.min(len - 1, Math.floor(P + win));
    if (b0 < 1 || b0 > len - 1 || hi < lo)
      continue;
    let best = lo;
    for (let b = lo + 1; b <= hi; b++) {
      if (e[o + b] > e[o + best])
        best = b;
    }
    const eb = e[o + best];
    if (eb <= 0 || eb < sc.floor * level * Math.max(n[o + best], minPairs))
      continue;
    status[j] = REJECTED;
    if (best === b0)
      status[j] = STAY;
    if (best === b0 || eb < sc.gain * e[o + b0])
      continue;
    if ((best > 1 && e[o + best - 1] > eb) || (best < len - 1 && e[o + best + 1] > eb))
      continue;
    let pos = best;
    if (sc.subpixel && best > 1 && best < len - 1) {
      const l = e[o + best - 1];
      const r = e[o + best + 1];
      const den = l - 2 * eb + r;
      if (den < 0)
        pos += Math.max(-SUBPIXEL_REACH, Math.min(SUBPIXEL_REACH, (0.5 * (l - r)) / den));
    }
    disp[j] = pos - P;
    status[j] = MOVED;
  }
}

/**
 * Keeps snapped lines ordered with a gap >= gap px: of two lines that come too close, the one that moved more (the
 * left one on ties) goes back to its unsnapped position, until no pair violates the gap.
 */
function enforceGap(base: Float64Array, disp: Float64Array, gap: number): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 1; j < base.length; j++) {
      if (base[j] + disp[j] - (base[j - 1] + disp[j - 1]) >= gap || (disp[j] === 0 && disp[j - 1] === 0))
        continue;
      if (Math.abs(disp[j]) > Math.abs(disp[j - 1]) || disp[j - 1] === 0)
        disp[j] = 0;
      else
        disp[j - 1] = 0;
      changed = true;
    }
  }
}

/** Largest sub-pixel (parabola) correction of a snapped peak, px. */
const SUBPIXEL_REACH = 0.5;

/** Middle value of three numbers. */
function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * Regularisation of the anchored per-line results of every band (disp / status per band, modified in place):
 * 1. Wrap consistency (snap.wrap > 0): a sprite whose phase is near half a cell has two equally near edges for every
 *    line (at d and d -+ size), and anchored lines pick either, so the cells between them double or vanish. Along
 *    each band every MOVED line takes the representative d + k * size closest to the previous MOVED / STAY line's
 *    displacement, as long as it stays within wrap * size of the unsnapped position (hysteresis: a phase that drifts
 *    on, e.g. a sprite drawn at another fake-pixel size, still flips once it passes wrap). With the default
 *    wrap = window = half a cell the anchored lines already lie within that bound, so this step only settles exact
 *    half-cell ties; larger bounds (e.g. 0.75 with a 0.6 window) scored lower on the size-tolerant measure.
 * 2. Coherence (snap.coherence > 0): a move larger than coherenceMin * size needs at least `coherence` supporters
 *    among the lines j -+ 1, j -+ 2 of its band and line j of the neighbouring bands (MOVED / STAY, displacement
 *    within coherenceTol * size of its own modulo the size); a sprite's phase moves all its lines alike, while edges
 *    of clutter (JPEG blocks, gradients, noise) pull lines by unrelated amounts. Unsupported lines go back.
 * 3. Gap filling (snap.wrap > 0): a REJECTED line (typically an edge right at the window border) whose nearest
 *    MOVED / STAY lines on both sides (within 2 lines) agree within GAP_FILL_AGREE cell takes their mean.
 */
function regularise(disp: Float64Array[], status: Uint8Array[], size: number, sc: SnapConfig): void {
  const nb = disp.length;
  const good = (b: number, j: number): boolean => b >= 0 && b < nb && j >= 0 && j < disp[b].length && (status[b][j] === MOVED || status[b][j] === STAY);
  if (sc.wrap > 0) {
    for (let b = 0; b < nb; b++) {
      let prev = NaN;
      for (let j = 0; j < disp[b].length; j++) {
        if (!good(b, j))
          continue;
        if (status[b][j] === MOVED && !Number.isNaN(prev)) {
          const alt = alignTo(disp[b][j], prev, size);
          // The sub-pixel peak may lie up to SUBPIXEL_REACH past a whole-pixel bound: exact half-cell ties need it
          if (Math.abs(alt) <= sc.wrap * size + SUBPIXEL_REACH)
            disp[b][j] = alt;
        }
        prev = disp[b][j];
      }
    }
  }
  if (sc.coherence > 0) {
    const drop: [number, number][] = [];
    for (let b = 0; b < nb; b++) {
      for (let j = 0; j < disp[b].length; j++) {
        const d = disp[b][j];
        if (status[b][j] !== MOVED || Math.abs(d) <= sc.coherenceMin * size)
          continue;
        let support = 0;
        for (const [bb, jj] of [[b, j - 1], [b, j + 1], [b, j - 2], [b, j + 2], [b - 1, j], [b + 1, j]]) {
          if (good(bb, jj) && Math.abs(alignTo(disp[bb][jj], d, size) - d) <= sc.coherenceTol * size)
            support++;
        }
        if (support < sc.coherence)
          drop.push([b, j]);
      }
    }
    for (const [b, j] of drop) {
      disp[b][j] = 0;
      status[b][j] = REJECTED;
    }
  }
  if (sc.wrap > 0) {
    for (let b = 0; b < nb; b++) {
      const d = disp[b];
      for (let j = 0; j < d.length; j++) {
        if (status[b][j] !== REJECTED)
          continue;
        const l = good(b, j - 1) ? j - 1 : good(b, j - 2) ? j - 2 : -1;
        const r = good(b, j + 1) ? j + 1 : good(b, j + 2) ? j + 2 : -1;
        if (l < 0 || r < 0)
          continue;
        const dr = alignTo(d[r], d[l], size);
        const m = (d[l] + dr) / 2;
        if (Math.abs(dr - d[l]) <= GAP_FILL_AGREE * size && Math.abs(m) <= sc.wrap * size && m !== 0) {
          d[j] = m;
          status[b][j] = MOVED;
        }
      }
    }
  }
}

/**
 * JPEG deblocking (snap.deblock): the JPEG_BLOCK x JPEG_BLOCK blocks of a JPEG add a step at every pixel boundary on a
 * multiple of JPEG_BLOCK that has nothing to do with the fake pixels. When the whole-image per-pair strength on those
 * boundaries exceeds the median of the other residues by more than DEBLOCK_MIN_EXCESS, that excess per pair comes off
 * them in every band profile (e / n: nb profiles of L entries; we / wn: their sum, updated too when it is a separate
 * array). Skipped when DEBLOCK_MAX_ON_BLOCK or more of the lines sit on block boundaries (sizes such as 8 or 16: the
 * steps are fake-pixel edges).
 */
function deblock(e: Float64Array, n: Float64Array, nb: number, L: number, we: Float64Array, wn: Float64Array, base: Float64Array): void {
  let onBlock = 0;
  for (const P of base) {
    if (Math.ceil(P - 0.5) % JPEG_BLOCK === 0)
      onBlock++;
  }
  if (onBlock >= DEBLOCK_MAX_ON_BLOCK * base.length)
    return;
  const sum = new Float64Array(JPEG_BLOCK);
  const cnt = new Float64Array(JPEG_BLOCK);
  for (let b = 1; b < L - 1; b++) {
    sum[b % JPEG_BLOCK] += we[b];
    cnt[b % JPEG_BLOCK] += wn[b];
  }
  const mean = Array.from(sum, (v, r) => (cnt[r] > 0 ? v / cnt[r] : 0));
  const rest = mean.slice(1).sort((p, q) => p - q);
  const median = rest[rest.length >> 1];
  const excess = mean[0] - median;
  if (!(excess > DEBLOCK_MIN_EXCESS * median))
    return;
  for (let b = 0; b < nb; b++) {
    for (let x = JPEG_BLOCK; x < L - 1; x += JPEG_BLOCK)
      e[b * L + x] = Math.max(0, e[b * L + x] - excess * n[b * L + x]);
  }
  if (we !== e) {
    for (let x = JPEG_BLOCK; x < L - 1; x += JPEG_BLOCK)
      we[x] = Math.max(0, we[x] - excess * wn[x]);
  }
}

/** The representative d + k * size closest to ref. */
function alignTo(d: number, ref: number, size: number): number {
  return d + size * Math.round((ref - d) / size);
}

/**
 * Line displacements of one axis per band (`nb` profiles of len + 1 entries in e / n): the whole-image profile (sum
 * of the bands) snaps first; with bands each band then snaps on its own. regularise() runs on each set (wrap,
 * coherence, gap filling); then a weak band line takes the mean of its neighbouring bands with evidence (smooth 'median3')
 * or the whole-image result (fallback 'line') or stays, and with smooth 'median3' a band whose two neighbours have
 * evidence takes the median of the three. Lines keep their order (enforceGap) in every band.
 */
function snapAxis(e: Float64Array, n: Float64Array, nb: number, len: number, base: Float64Array, size: number, sc: SnapConfig): Float64Array[] {
  const L = len + 1;
  let we = e;
  let wn = n;
  if (nb > 1) {
    we = new Float64Array(L);
    wn = new Float64Array(L);
    for (let b = 0; b < nb; b++) {
      for (let x = 0; x < L; x++) {
        we[x] += e[b * L + x];
        wn[x] += n[b * L + x];
      }
    }
  }
  if (sc.deblock)
    deblock(e, n, nb, L, we, wn, base);
  const level = perPairQuantile(we, wn, sc.floorPairs * size, FLOOR_QUANTILE);
  const gap = sc.minGap * size;
  const status = new Uint8Array(base.length);
  const whole = new Float64Array(base.length);
  snapProfile(we, wn, 0, len, base, size, sc, level, whole, status);
  regularise([whole], [status], size, sc);
  enforceGap(base, whole, gap);
  if (nb === 1)
    return [whole];
  const raw: Float64Array[] = [];
  const stB: Uint8Array[] = [];
  for (let b = 0; b < nb; b++) {
    const d = new Float64Array(base.length);
    const st = new Uint8Array(base.length);
    snapProfile(e, n, b * L, len, base, size, sc, level, d, st);
    raw.push(d);
    stB.push(st);
  }
  regularise(raw, stB, size, sc);
  const weakB = stB.map((st) => st.map((v) => (v === WEAK ? 1 : 0)));
  const out: Float64Array[] = [];
  // With wrap consistency, neighbouring bands' displacements are compared modulo the size (their representative
  // closest to this band's), so smoothing corrects small deviations and never flips a band's wrap.
  const nbr = (v: number, ref: number): number => (sc.wrap > 0 ? alignTo(v, ref, size) : v);
  for (let b = 0; b < nb; b++) {
    const d = raw[b].slice();
    for (let j = 0; j < base.length; j++) {
      const up = b > 0 && !weakB[b - 1][j];
      const down = b < nb - 1 && !weakB[b + 1][j];
      if (weakB[b][j]) {
        // No edge evidence here: the mean of the neighbouring bands that have some, else the fallback.
        if (sc.smooth === 'median3' && (up || down))
          d[j] = up && down ? (raw[b - 1][j] + nbr(raw[b + 1][j], raw[b - 1][j])) / 2 : up ? raw[b - 1][j] : raw[b + 1][j];
        else
          d[j] = sc.fallback === 'line' ? whole[j] : 0;
      } else if (sc.smooth === 'median3' && up && down) {
        // Only bands with evidence vote, so a weak (background) neighbour never overrides a sprite's own lines.
        d[j] = median3(nbr(raw[b - 1][j], raw[b][j]), raw[b][j], nbr(raw[b + 1][j], raw[b][j]));
      }
    }
    enforceGap(base, d, gap);
    out.push(d);
  }
  return out;
}

/**
 * Step 1b: snapped sampling windows (see the file header). shX / shY are the per-cell phases the windows follow
 * (undefined without the phase fix): lines snap relative to those phase-corrected positions, so a line that does not
 * move leaves its cells' windows exactly as without snapping.
 */
function snapWindows(img: RgbaImage, g: GridSpec, dims: { width: number; height: number; firstX: number; firstY: number }, shX: Float64Array | undefined,
  shY: Float64Array | undefined, bg: BackgroundInfo, cfg: RectifyConfig): { win: CellWindows; info: SnapInfo } {
  const sc = cfg.snap;
  const { width: W, height: H } = img;
  const ow = dims.width;
  const oh = dims.height;
  const s = g.size;
  const bandCells = Math.max(1, Math.round(sc.band));
  const banded = sc.mode === 'band';
  const nRB = banded ? Math.ceil(oh / bandCells) : 1;
  const nCB = banded ? Math.ceil(ow / bandCells) : 1;
  const rowBand = new Int32Array(oh);
  const colBand = new Int32Array(ow);
  if (banded) {
    for (let j = 0; j < oh; j++)
      rowBand[j] = Math.floor(j / bandCells);
    for (let i = 0; i < ow; i++)
      colBand[i] = Math.floor(i / bandCells);
  }
  // Band of every pixel row (column): the band of the output row (column) whose unshifted cell contains it.
  const bandOfPx = (length: number, offset: number, first: number, count: number, nb: number): Int32Array => {
    const out = new Int32Array(length);
    if (nb > 1) {
      for (let p = 0; p < length; p++) {
        const k = Math.floor((p + 0.5 - offset) / s) - first;
        out[p] = Math.floor(Math.min(count - 1, Math.max(0, k)) / bandCells);
      }
    }
    return out;
  };
  const prof = edgeProfiles(img, bg, sc, bandOfPx(H, g.offsetY, dims.firstY, oh, nRB), nRB, bandOfPx(W, g.offsetX, dims.firstX, ow, nCB), nCB);
  const baseX = baseLines(g.offsetX, s, dims.firstX, ow, shX);
  const baseY = baseLines(g.offsetY, s, dims.firstY, oh, shY);
  const dispX = snapAxis(prof.ex, prof.nx, nRB, W, baseX, s, sc);
  const dispY = snapAxis(prof.ey, prof.ny, nCB, H, baseY, s, sc);
  const wx = dispX.map((d) => axisWindows(g.offsetX, s, W, dims.firstX, ow, cfg.margin, shX, d));
  const wy = dispY.map((d) => axisWindows(g.offsetY, s, H, dims.firstY, oh, cfg.margin, shY, d));
  let lines = 0;
  let moved = 0;
  let sum = 0;
  for (const d of [...dispX, ...dispY]) {
    lines += d.length;
    for (let j = 0; j < d.length; j++) {
      if (d[j] !== 0) {
        moved++;
        sum += Math.abs(d[j]);
      }
    }
  }
  return {
    win: { wx, wy, rowBand, colBand },
    info: { mode: sc.mode, rowBands: nRB, colBands: nCB, lines, moved, meanMove: moved ? sum / moved / s : 0, baseX, baseY, dispX, dispY }
  };
}

// ---------------------------------------------------------------- PSF, phase and deconvolution

interface CellColours {
  w: number;
  h: number;
  /** Colour per cell (RGB floats). */
  rgb: Float32Array;
  /** 1 = opaque cell. */
  opaque: Uint8Array;
  /** Plain mean of each cell's opaque window samples (input of the deconvolution). */
  mean: Float32Array;
  /** Per-channel pixel noise sigma estimate. */
  sigma: number;
}

/** Fitted point-spread function and phase of the true cell edges relative to the given grid. */
export interface Psf {
  /** Gaussian PSF sigma in px. */
  sigma: number;
  /** Phase correction (px) at the main crop centre (cx, cy), and its change per px (a size error). */
  dx: number;
  dy: number;
  cx: number;
  cy: number;
  slopeX: number;
  slopeY: number;
}

const NO_PSF: Psf = { sigma: 0, dx: 0, dy: 0, cx: 0, cy: 0, slopeX: 0, slopeY: 0 };

/** Standard normal CDF (erf approximation, |error| < 1.5e-7). */
function phi(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Per-axis window kernel: K[i * 3 + a + 1] = mean over the window pixels of cell i of the Gaussian PSF mass that
 * falls inside cell i + a (a = -1, 0, 1). Edges sit on pixel boundaries (a pixel belongs to the cell containing its
 * centre); point sampling when sigma is ~0. With `disp` (snapped line displacements, count + 1) every cell boundary
 * follows its snapped line (lines beyond the axis do not move).
 */
function axisKernel(offset: number, size: number, first: number, win: AxisWindows, sigma: number, shift?: Float64Array, disp?: Float64Array): Float32Array {
  const K = new Float32Array(win.count * 3);
  const dl = (j: number): number => (disp && j >= 0 && j < disp.length ? disp[j] : 0);
  for (let i = 0; i < win.count; i++) {
    const L = offset + (shift ? shift[i] : 0) + (first + i) * size;
    let n = 0;
    for (let x = win.lo[i]; x <= win.hi[i]; x++) {
      const c = x + 0.5;
      for (let a = -1; a <= 1; a++) {
        let lo = Math.ceil(L + a * size - 0.5);
        let hi = Math.ceil(L + (a + 1) * size - 0.5);
        if (disp) {
          lo = Math.ceil(L + a * size + dl(i + a) - 0.5);
          hi = Math.ceil(L + (a + 1) * size + dl(i + a + 1) - 0.5);
        }
        K[i * 3 + a + 1] += sigma > 0.02 ? phi((hi - c) / sigma) - phi((lo - c) / sigma) : (c >= lo && c < hi ? 1 : 0);
      }
      n++;
    }
    for (let a = 0; a < 3; a++)
      K[i * 3 + a] /= Math.max(1, n);
  }
  return K;
}

/**
 * Jacobi deconvolution in cell space: finds X with (Ky o Kx o X) ~= mean (the window means), starting from the
 * means; neighbours beyond the output border replicate the edge cell; transparent cells are held. Clamped to
 * [0, 255]. Kernels per band (CellWindows): row j uses KxL[rowBand[j]], column i KyL[colBand[i]].
 */
function deconvolveCells(cells: CellColours, KxL: Float32Array[], KyL: Float32Array[], rowBand: Int32Array, colBand: Int32Array, iters: number): Float32Array {
  const { w, h, mean: O, opaque } = cells;
  const X = O.slice();
  const T = new Float32Array(w * h * 3);
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < h; j++) {
      const Kx = KxL[rowBand[j]];
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const kl = i > 0 ? k - 1 : k;
        const kr = i < w - 1 ? k + 1 : k;
        for (let c = 0; c < 3; c++)
          T[k * 3 + c] = Kx[i * 3] * X[kl * 3 + c] + Kx[i * 3 + 1] * X[k * 3 + c] + Kx[i * 3 + 2] * X[kr * 3 + c];
      }
    }
    for (let j = 0; j < h; j++) {
      const Kx = KxL[rowBand[j]];
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!opaque[k])
          continue;
        const Ky = KyL[colBand[i]];
        const ku = j > 0 ? k - w : k;
        const kd = j < h - 1 ? k + w : k;
        const d = Kx[i * 3 + 1] * Ky[j * 3 + 1];
        for (let c = 0; c < 3; c++) {
          const y = Ky[j * 3] * T[ku * 3 + c] + Ky[j * 3 + 1] * T[k * 3 + c] + Ky[j * 3 + 2] * T[kd * 3 + c];
          const v = X[k * 3 + c] + (O[k * 3 + c] - y) / Math.max(0.3, d);
          X[k * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
  }
  return X;
}

/** Minimum of f over increasing candidates xs, refined by a parabola through the best point and its neighbours. */
function argminParabola(xs: number[], f: (x: number) => number): number {
  const ys = xs.map(f);
  let m = 0;
  for (let t = 1; t < ys.length; t++) {
    if (ys[t] < ys[m])
      m = t;
  }
  if (m === 0 || m === ys.length - 1)
    return xs[m];
  const x0 = xs[m - 1];
  const x1 = xs[m];
  const x2 = xs[m + 1];
  const y0 = ys[m - 1];
  const y1 = ys[m];
  const y2 = ys[m + 1];
  const den = (x0 - x1) * (x0 - x2) * (x1 - x2);
  const A = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / den;
  const B = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / den;
  const v = A > 0 ? -B / (2 * A) : x1;
  return Math.min(x2, Math.max(x0, v));
}

/**
 * Residual of the forward model on one crop of cw x ch cells starting at output cell (bi, bj): mean squared RGB
 * error over the pixels of the crop's inner cells for a PSF sigma and a phase shift (dx, dy). The crop's window
 * means (windows following the shifted cells) are deconvolved first. Null when the crop has no inner pixels.
 */
function cropFitter(img: RgbaImage, g: GridSpec, dims: { firstX: number; firstY: number }, cfg: RectifyConfig, bi: number, bj: number, cw: number, ch: number): ((sigma: number, dx: number, dy: number) => number) | null {
  const { width: W, height: H, data } = img;
  const s = g.size;
  const px0 = Math.max(0, Math.ceil(g.offsetX + (dims.firstX + bi + 1) * s - 0.5));
  const px1 = Math.min(W - 1, Math.ceil(g.offsetX + (dims.firstX + bi + cw - 1) * s - 0.5) - 1);
  const py0 = Math.max(0, Math.ceil(g.offsetY + (dims.firstY + bj + 1) * s - 0.5));
  const py1 = Math.min(H - 1, Math.ceil(g.offsetY + (dims.firstY + bj + ch - 1) * s - 0.5) - 1);
  if (px1 <= px0 || py1 <= py0)
    return null;
  const pstep = Math.max(1, Math.round(Math.sqrt(((px1 - px0 + 1) * (py1 - py0 + 1)) / cfg.psfPixels)));
  const meansFor = (dx: number, dy: number): { sub: CellColours; swx: AxisWindows; swy: AxisWindows } => {
    const swx = axisWindows(g.offsetX + dx, s, W, dims.firstX + bi, cw, cfg.margin);
    const swy = axisWindows(g.offsetY + dy, s, H, dims.firstY + bj, ch, cfg.margin);
    const mean = new Float32Array(cw * ch * 3);
    for (let j = 0; j < ch; j++) {
      const ny = swy.hi[j] - swy.lo[j] + 1;
      for (let i = 0; i < cw; i++) {
        const nx = swx.hi[i] - swx.lo[i] + 1;
        const st = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / 64)));
        let r = 0;
        let gg = 0;
        let b = 0;
        let n = 0;
        for (let y = swy.lo[j]; y <= swy.hi[j]; y += st) {
          for (let x = swx.lo[i]; x <= swx.hi[i]; x += st) {
            const p = (y * W + x) * 4;
            r += data[p];
            gg += data[p + 1];
            b += data[p + 2];
            n++;
          }
        }
        const k = (j * cw + i) * 3;
        mean[k] = r / n;
        mean[k + 1] = gg / n;
        mean[k + 2] = b / n;
      }
    }
    return { sub: { w: cw, h: ch, rgb: mean, opaque: new Uint8Array(cw * ch).fill(1), mean, sigma: 0 }, swx, swy };
  };
  // Per-axis pixel masses: cell index within the crop and the PSF mass in cells a = -1, 0, 1.
  const axis = (p0: number, p1: number, off: number, first: number, sigma: number): { ci: Int32Array; m: Float32Array } => {
    const n = p1 - p0 + 1;
    const ci = new Int32Array(n);
    const m = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) {
      const c = p0 + t + 0.5;
      const kc = Math.floor((c - off) / s);
      ci[t] = kc - first;
      for (let a = -1; a <= 1; a++) {
        const lo = Math.ceil(off + (kc + a) * s - 0.5);
        const hi = Math.ceil(off + (kc + a + 1) * s - 0.5);
        m[t * 3 + a + 1] = sigma > 0.02 ? phi((hi - c) / sigma) - phi((lo - c) / sigma) : (c >= lo && c < hi ? 1 : 0);
      }
    }
    return { ci, m };
  };
  const cache = new Map<string, { sub: CellColours; swx: AxisWindows; swy: AxisWindows }>();
  return (sigma: number, dx: number, dy: number): number => {
    const key = `${dx.toFixed(3)},${dy.toFixed(3)}`;
    let mw = cache.get(key);
    if (!mw) {
      mw = meansFor(dx, dy);
      cache.set(key, mw);
    }
    const Kx = axisKernel(g.offsetX + dx, s, dims.firstX + bi, mw.swx, sigma);
    const Ky = axisKernel(g.offsetY + dy, s, dims.firstY + bj, mw.swy, sigma);
    const X = sigma >= 0.1 ? deconvolveCells(mw.sub, [Kx], [Ky], new Int32Array(ch), new Int32Array(cw), cfg.psfFitIters) : mw.sub.mean;
    const ax = axis(px0, px1, g.offsetX + dx, dims.firstX + bi, sigma);
    const ay = axis(py0, py1, g.offsetY + dy, dims.firstY + bj, sigma);
    let err = 0;
    let n = 0;
    for (let y = py0; y <= py1; y += pstep) {
      const ty = y - py0;
      const cj = ay.ci[ty];
      if (cj < 1 || cj > ch - 2)
        continue;
      for (let x = px0; x <= px1; x += pstep) {
        const tx = x - px0;
        const cI = ax.ci[tx];
        if (cI < 1 || cI > cw - 2)
          continue;
        const p = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let b = -1; b <= 1; b++) {
            const rowK = (cj + b) * cw;
            v += ay.m[ty * 3 + b + 1] * (ax.m[tx * 3] * X[(rowK + cI - 1) * 3 + c] + ax.m[tx * 3 + 1] * X[(rowK + cI) * 3 + c] + ax.m[tx * 3 + 2] * X[(rowK + cI + 1) * 3 + c]);
          }
          const d = data[p + c] - v;
          err += d * d;
        }
        n++;
      }
    }
    return n ? err / n : Infinity;
  };
}

/**
 * Fits the PSF sigma and the phase of the true cell edges on the busiest crop (centre-pixel colour differences):
 * coordinate descent over sigma, dx, dy (+-0.3 cell), sigma. With cfg.drift the phase is also measured (sigma
 * fixed) on crops centred near the 15 % / 85 % points of each axis's busy extent; a line through the three phases
 * models a size error, accepted only when they are monotone and change by >= cfg.driftMin cells.
 */
function estimatePsf(img: RgbaImage, g: GridSpec, dims: { width: number; height: number; firstX: number; firstY: number }, cfg: RectifyConfig): Psf {
  const { width: W, height: H, data } = img;
  const s = g.size;
  const w = dims.width;
  const h = dims.height;
  const cropCells = Math.max(12, Math.min(cfg.psfCropCells, Math.round(cfg.psfCropPx / s)));
  const cw = Math.min(w, cropCells);
  const ch = Math.min(h, cropCells);
  if (cw < 4 || ch < 4)
    return NO_PSF;
  const cpx = new Int32Array(w);
  const cpy = new Int32Array(h);
  for (let i = 0; i < w; i++)
    cpx[i] = Math.min(W - 1, Math.max(0, Math.floor(g.offsetX + (dims.firstX + i + 0.5) * s)));
  for (let j = 0; j < h; j++)
    cpy[j] = Math.min(H - 1, Math.max(0, Math.floor(g.offsetY + (dims.firstY + j + 0.5) * s)));
  const at = (i: number, j: number): number => (cpy[j] * W + cpx[i]) * 4;
  const colBusy = new Float64Array(w);
  const rowBusy = new Float64Array(h);
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) {
    let row = 0;
    for (let i = 0; i < w; i++) {
      const p = at(i, j);
      let b = 0;
      if (i < w - 1) {
        const q = at(i + 1, j);
        b += Math.abs(data[p] - data[q]) + Math.abs(data[p + 1] - data[q + 1]) + Math.abs(data[p + 2] - data[q + 2]);
      }
      if (j < h - 1) {
        const q = at(i, j + 1);
        b += Math.abs(data[p] - data[q]) + Math.abs(data[p + 1] - data[q + 1]) + Math.abs(data[p + 2] - data[q + 2]);
      }
      colBusy[i] += b;
      rowBusy[j] += b;
      row += b;
      sat[(j + 1) * (w + 1) + i + 1] = sat[j * (w + 1) + i + 1] + row;
    }
  }
  const stepC = Math.max(1, Math.floor(cropCells / 8));
  /** Busiest crop whose first cell lies in [i0, i1] x [j0, j1]: [i, j] or [-1, -1]. */
  const busiest = (i0: number, i1: number, j0: number, j1: number): [number, number] => {
    let bi = -1;
    let bj = -1;
    let bestE = 0;
    for (let j = Math.max(0, j0); j <= Math.min(h - ch, j1); j += stepC) {
      for (let i = Math.max(0, i0); i <= Math.min(w - cw, i1); i += stepC) {
        const e = sat[(j + ch) * (w + 1) + i + cw] - sat[j * (w + 1) + i + cw] - sat[(j + ch) * (w + 1) + i] + sat[j * (w + 1) + i];
        if (e > bestE) {
          bestE = e;
          bi = i;
          bj = j;
        }
      }
    }
    return [bi, bj];
  };
  const [bi, bj] = busiest(0, w - cw, 0, h - ch);
  const fit = bi < 0 ? null : cropFitter(img, g, dims, cfg, bi, bj, cw, ch);
  if (!fit)
    return NO_PSF;
  const sigmas = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1, 1.2, 1.45, 1.75, 2.1, 2.5, 3, 3.6].filter((v) => v <= Math.max(0.5, 0.6 * s));
  const shifts = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((v) => v * s);
  let sigma = argminParabola(sigmas, (v) => fit(v, 0, 0));
  const dx = Math.round(argminParabola(shifts, (v) => fit(sigma, v, 0)) * 4) / 4;
  const dy = Math.round(argminParabola(shifts, (v) => fit(sigma, dx, v)) * 4) / 4;
  sigma = argminParabola(sigmas, (v) => fit(v, dx, dy));
  const out: Psf = { sigma, dx, dy, cx: g.offsetX + (dims.firstX + bi + cw / 2) * s, cy: g.offsetY + (dims.firstY + bj + ch / 2) * s, slopeX: 0, slopeY: 0 };
  if (!cfg.drift)
    return out;
  const quantile = (busy: Float64Array, q: number): number => {
    let tot = 0;
    for (let i = 0; i < busy.length; i++)
      tot += busy[i];
    let acc = 0;
    for (let i = 0; i < busy.length; i++) {
      acc += busy[i];
      if (acc >= q * tot)
        return i;
    }
    return busy.length - 1;
  };
  const slope = (axisX: boolean): number => {
    const n = axisX ? w : h;
    const span = axisX ? cw : ch;
    const lo = quantile(axisX ? colBusy : rowBusy, 0.15);
    const hi = quantile(axisX ? colBusy : rowBusy, 0.85);
    if (hi - lo < 1.5 * span)
      return 0;
    const pts: [number, number][] = [[axisX ? out.cx : out.cy, axisX ? dx : dy]];
    for (const centre of [lo, hi]) {
      const start = Math.max(0, Math.min(n - span, Math.round(centre - span / 2)));
      const [ci, cj] = axisX ? busiest(start, start, 0, h - ch) : busiest(0, w - cw, start, start);
      const f = ci < 0 ? null : cropFitter(img, g, dims, cfg, ci, cj, cw, ch);
      if (!f)
        continue;
      const d = axisX ? argminParabola(shifts, (v) => f(sigma, v, dy)) : argminParabola(shifts, (v) => f(sigma, dx, v));
      pts.push([axisX ? g.offsetX + (dims.firstX + ci + cw / 2) * s : g.offsetY + (dims.firstY + cj + ch / 2) * s, d]);
    }
    if (pts.length < 3)
      return 0;
    // A real size error moves the phase monotonically along the axis; jitter gives small, inconsistent changes.
    pts.sort((p, q) => p[0] - q[0]);
    const [[xa, da], [, dm], [xb, db]] = pts;
    if ((dm - da) * (db - dm) < 0 || Math.abs(db - da) < cfg.driftMin * s || xb - xa < 1e-6)
      return 0;
    let mx = 0;
    let my = 0;
    for (const [x, y] of pts) {
      mx += x;
      my += y;
    }
    mx /= pts.length;
    my /= pts.length;
    let sxy = 0;
    let sxx = 0;
    for (const [x, y] of pts) {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) ** 2;
    }
    return sxx > 0 ? sxy / sxx : 0;
  };
  out.slopeX = slope(true);
  out.slopeY = slope(false);
  return out;
}

/** True when any sampled pixel is not fully opaque (input with alpha). */
function hasTransparency(img: RgbaImage): boolean {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 200000));
  for (let p = 0; p < n; p += step) {
    if (img.data[p * 4 + 3] < 250)
      return true;
  }
  return false;
}

// ---------------------------------------------------------------- cell colours

/** k-th smallest of a[0..n) (in place, Hoare quickselect with middle pivots). */
function selectK(a: Float32Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot)
        i++;
      while (a[j] > pivot)
        j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j)
      hi = j;
    else if (k >= i)
      lo = i;
    else
      return a[k];
  }
  return a[k];
}

/** Median of buf[0..n) (buf untouched; tmp is scratch of length >= n). */
function medianOf(buf: Float32Array, n: number, tmp: Float32Array): number {
  for (let i = 0; i < n; i++)
    tmp[i] = buf[i];
  const hi = selectK(tmp, n, n >> 1);
  if (n % 2)
    return hi;
  // Even n: the lower middle is the largest element left of index n >> 1.
  let lo = -Infinity;
  for (let i = 0; i < n >> 1; i++) {
    if (tmp[i] > lo)
      lo = tmp[i];
  }
  return 0.5 * (lo + hi);
}

/** Global per-channel pixel noise: median over up to ~1500 cells of the per-channel MAD, times 1.4826. */
function estimatePixelSigma(img: RgbaImage, win: CellWindows, maxSamples: number): number {
  const { width: W, data } = img;
  const w = win.wx[0].count;
  const cells = w * win.wy[0].count;
  const step = Math.max(1, Math.floor(cells / 1500));
  const mads: number[] = [];
  const buf = [new Float32Array(maxSamples + 8), new Float32Array(maxSamples + 8), new Float32Array(maxSamples + 8)];
  const tmp = new Float32Array(maxSamples + 8);
  for (let k = 0; k < cells; k += step) {
    const i = k % w;
    const j = Math.floor(k / w);
    const wx = win.wx[win.rowBand[j]];
    const wy = win.wy[win.colBand[i]];
    const nx = wx.hi[i] - wx.lo[i] + 1;
    const ny = wy.hi[j] - wy.lo[j] + 1;
    if (nx * ny < 4)
      continue;
    const st = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / maxSamples)));
    let n = 0;
    for (let y = wy.lo[j]; y <= wy.hi[j] && n < maxSamples; y += st) {
      for (let x = wx.lo[i]; x <= wx.hi[i] && n < maxSamples; x += st) {
        const p = (y * W + x) * 4;
        if (data[p + 3] < 128)
          continue;
        buf[0][n] = data[p];
        buf[1][n] = data[p + 1];
        buf[2][n] = data[p + 2];
        n++;
      }
    }
    if (n < 4)
      continue;
    let mad = 0;
    for (let c = 0; c < 3; c++) {
      const m = medianOf(buf[c], n, tmp);
      for (let t = 0; t < n; t++)
        tmp[t] = Math.abs(buf[c][t] - m);
      mad += medianOf(tmp, n, buf[c]);
    }
    mads.push(mad / 3);
  }
  if (mads.length === 0)
    return 2;
  mads.sort((p, q) => p - q);
  return Math.max(0.5, 1.4826 * sortedQuantile(mads, 0.5));
}

/** Colour variance (RGB + alpha) of a window on a sparse lattice of up to 5 x 5 samples. */
function windowVariance(img: RgbaImage, x0: number, x1: number, y0: number, y1: number): number {
  const { width: W, data } = img;
  const nx = Math.min(5, x1 - x0 + 1);
  const ny = Math.min(5, y1 - y0 + 1);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let q = 0;
  let n = 0;
  for (let b = 0; b < ny; b++) {
    const y = ny === 1 ? (y0 + y1) >> 1 : y0 + Math.round((b * (y1 - y0)) / (ny - 1));
    for (let a = 0; a < nx; a++) {
      const x = nx === 1 ? (x0 + x1) >> 1 : x0 + Math.round((a * (x1 - x0)) / (nx - 1));
      const p = (y * W + x) * 4;
      const r = data[p];
      const g = data[p + 1];
      const bl = data[p + 2];
      const al = data[p + 3];
      s0 += r;
      s1 += g;
      s2 += bl;
      s3 += al;
      q += r * r + g * g + bl * bl + al * al;
      n++;
    }
  }
  return (q - (s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3) / n) / n;
}

/**
 * Window shift (dx, dy) within +-R px that makes the window most homogeneous. Keeps (0, 0) when the nominal window
 * is already homogeneous (variance <= homog) or no shift halves its variance; ties go to the earlier (smaller) shift.
 */
function bestShift(img: RgbaImage, x0: number, x1: number, y0: number, y1: number, R: number, homog: number): [number, number] {
  const v0 = windowVariance(img, x0, x1, y0, y1);
  if (v0 <= homog)
    return [0, 0];
  const steps = R >= 2 ? [0, -Math.round(R / 2), Math.round(R / 2), -R, R] : [0, -R, R];
  let best: [number, number] = [0, 0];
  let bv = v0;
  for (const dy of steps) {
    for (const dx of steps) {
      if ((dx === 0 && dy === 0) || x0 + dx < 0 || y0 + dy < 0 || x1 + dx >= img.width || y1 + dy >= img.height)
        continue;
      const v = windowVariance(img, x0 + dx, x1 + dx, y0 + dy, y1 + dy);
      if (v < bv - 1e-9) {
        bv = v;
        best = [dx, dy];
      }
    }
  }
  return bv <= 0.5 * v0 ? best : [0, 0];
}

/**
 * Colour of every cell from its window samples: transparent when at least half the samples have alpha < 128,
 * otherwise the mean-shift mode (radius max(msMin, msK * sigma)) started at the per-channel median, or the median.
 * Also records the plain window mean (deconvolution input). recentre false disables step 2's re-centring.
 */
function extractCells(img: RgbaImage, size: number, win: CellWindows, cfg: RectifyConfig, recentre: boolean): CellColours {
  const { width: W, data } = img;
  const w = win.wx[0].count;
  const h = win.wy[0].count;
  const rgb = new Float32Array(w * h * 3);
  const opaque = new Uint8Array(w * h);
  const mean = new Float32Array(w * h * 3);
  const ms = cfg.maxSamples;
  const sigma = estimatePixelSigma(img, win, ms);
  const radius = Math.max(cfg.msMin, cfg.msK * sigma);
  const r2 = radius * radius;
  const recR = recentre && cfg.recentre > 0 && size >= cfg.recentreMinS ? Math.max(1, Math.round(cfg.recentre * size)) : 0;
  const homog = cfg.recentreHomog * 3 * sigma * sigma;
  const br = new Float32Array(ms + 8);
  const bgc = new Float32Array(ms + 8);
  const bb = new Float32Array(ms + 8);
  const tmp = new Float32Array(ms + 8);
  for (let j = 0; j < h; j++) {
    const wx = win.wx[win.rowBand[j]];
    for (let i = 0; i < w; i++) {
      const wy = win.wy[win.colBand[i]];
      let x0 = wx.lo[i];
      let x1 = wx.hi[i];
      let y0 = wy.lo[j];
      let y1 = wy.hi[j];
      if (recR > 0) {
        const sh = bestShift(img, x0, x1, y0, y1, recR, homog);
        x0 += sh[0];
        x1 += sh[0];
        y0 += sh[1];
        y1 += sh[1];
      }
      const nx = x1 - x0 + 1;
      const ny = y1 - y0 + 1;
      const st = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / ms)));
      // Subsample lattice centred in the window.
      const ox = x0 + Math.floor(((nx - 1) % st) / 2);
      const oy = y0 + Math.floor(((ny - 1) % st) / 2);
      let n = 0;
      let tr = 0;
      for (let y = oy; y <= y1; y += st) {
        for (let x = ox; x <= x1; x += st) {
          if (n + tr >= ms)
            break;
          const p = (y * W + x) * 4;
          if (data[p + 3] < 128) {
            tr++;
            continue;
          }
          br[n] = data[p];
          bgc[n] = data[p + 1];
          bb[n] = data[p + 2];
          n++;
        }
      }
      const k = j * w + i;
      if (n === 0 || tr >= n)
        continue;
      opaque[k] = 1;
      let mr = 0;
      let mg = 0;
      let mb = 0;
      for (let t = 0; t < n; t++) {
        mr += br[t];
        mg += bgc[t];
        mb += bb[t];
      }
      mr /= n;
      mg /= n;
      mb /= n;
      mean[k * 3] = mr;
      mean[k * 3 + 1] = mg;
      mean[k * 3 + 2] = mb;
      if (cfg.colour === 'meanshift') {
        // Exact fast path: when every sample lies within radius / 2 of the mean, the median start is within radius
        // of every sample, so the mean shift returns the plain mean.
        let maxD = 0;
        for (let t = 0; t < n; t++) {
          const d = (br[t] - mr) ** 2 + (bgc[t] - mg) ** 2 + (bb[t] - mb) ** 2;
          if (d > maxD)
            maxD = d;
        }
        if (maxD <= r2 / 4) {
          rgb[k * 3] = mr;
          rgb[k * 3 + 1] = mg;
          rgb[k * 3 + 2] = mb;
          continue;
        }
      }
      let cr = medianOf(br, n, tmp);
      let cg = medianOf(bgc, n, tmp);
      let cb = medianOf(bb, n, tmp);
      if (cfg.colour === 'meanshift') {
        for (let it = 0; it < cfg.msIters; it++) {
          let sr = 0;
          let sg = 0;
          let sb = 0;
          let m = 0;
          for (let t = 0; t < n; t++) {
            const dr = br[t] - cr;
            const dg = bgc[t] - cg;
            const db = bb[t] - cb;
            if (dr * dr + dg * dg + db * db <= r2) {
              sr += br[t];
              sg += bgc[t];
              sb += bb[t];
              m++;
            }
          }
          if (m === 0)
            break;
          cr = sr / m;
          cg = sg / m;
          cb = sb / m;
        }
      }
      rgb[k * 3] = cr;
      rgb[k * 3 + 1] = cg;
      rgb[k * 3 + 2] = cb;
    }
  }
  return { w, h, rgb, opaque, mean, sigma };
}

// ---------------------------------------------------------------- palette merge

/**
 * Cell-colour noise scale: q-quantile of each opaque cell's distance to its nearest opaque 4-neighbour colour, over
 * cells not flagged in `exclude` (the background, whose cells are much cleaner than the art's).
 */
function neighbourNoise(cells: CellColours, q: number, exclude?: Uint8Array): number {
  const { w, h, rgb, opaque } = cells;
  const ds: number[] = [];
  const step = Math.max(1, Math.floor((w * h) / 20000));
  for (let k = 0; k < w * h; k += step) {
    if (!opaque[k] || (exclude && exclude[k]))
      continue;
    const x = k % w;
    const y = Math.floor(k / w);
    let best = Infinity;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h)
        continue;
      const nk = ny * w + nx;
      if (!opaque[nk] || (exclude && exclude[nk]))
        continue;
      best = Math.min(best, Math.hypot(rgb[k * 3] - rgb[nk * 3], rgb[k * 3 + 1] - rgb[nk * 3 + 1], rgb[k * 3 + 2] - rgb[nk * 3 + 2]));
    }
    if (best < Infinity)
      ds.push(best);
  }
  ds.sort((p, r) => p - r);
  return sortedQuantile(ds, q);
}

/**
 * Palette merge of the opaque cell colours (in place). Colours are binned at 4 levels per channel; bins, most
 * frequent first, join the nearest leader within tau or found a new one (leaders fixed); Lloyd iterations recompute
 * the centres and reassign within tau. Then, lightest cluster first, a cluster merges into the nearest heavier one
 * whose centre lies within absorbSep * (sum of the two RMS radii, each at least spreadFloorK * noise; search capped at
 * 2 * mergeMax): one noise blob split in two is reunited, distinct colours stay apart. Every member cell takes its
 * cluster's mean. Returns the number of clusters.
 */
function mergePalette(cells: CellColours, tau: number, noise: number, cfg: RectifyConfig): number {
  const { w, h, rgb, opaque } = cells;
  const n = w * h;
  const binOf = new Int32Array(n).fill(-1);
  const keyIdx = new Int32Array(1 << 18).fill(-1);
  const bc: number[] = [];
  const bs: number[] = [];
  const bq: number[] = [];
  for (let k = 0; k < n; k++) {
    if (!opaque[k])
      continue;
    const key = ((rgb[k * 3] >> 2) << 12) | ((rgb[k * 3 + 1] >> 2) << 6) | (rgb[k * 3 + 2] >> 2);
    let b = keyIdx[key];
    if (b < 0) {
      b = bc.length;
      keyIdx[key] = b;
      bc.push(0);
      bs.push(0, 0, 0);
      bq.push(0);
    }
    bc[b]++;
    bs[b * 3] += rgb[k * 3];
    bs[b * 3 + 1] += rgb[k * 3 + 1];
    bs[b * 3 + 2] += rgb[k * 3 + 2];
    bq[b] += rgb[k * 3] ** 2 + rgb[k * 3 + 1] ** 2 + rgb[k * 3 + 2] ** 2;
    binOf[k] = b;
  }
  const nb = bc.length;
  if (nb === 0)
    return 0;
  const bm = new Float32Array(nb * 3);
  for (let b = 0; b < nb; b++) {
    bm[b * 3] = bs[b * 3] / bc[b];
    bm[b * 3 + 1] = bs[b * 3 + 1] / bc[b];
    bm[b * 3 + 2] = bs[b * 3 + 2] / bc[b];
  }
  const order = Array.from({ length: nb }, (_, i) => i);
  order.sort((p, q) => bc[q] - bc[p] || p - q);
  // Centres in a spatial hash with bucket size tau.
  const cellSz = Math.max(1, tau);
  const hkey = (r: number, g: number, b: number): number => ((Math.floor(r / cellSz) + 1) * 1024 + Math.floor(g / cellSz) + 1) * 1024 + Math.floor(b / cellSz) + 1;
  let cr: number[] = [];
  let cg: number[] = [];
  let cb: number[] = [];
  let buckets = new Map<number, number[]>();
  const addCentre = (r: number, g: number, b: number): number => {
    const id = cr.length;
    cr.push(r);
    cg.push(g);
    cb.push(b);
    const hk = hkey(r, g, b);
    const list = buckets.get(hk);
    if (list)
      list.push(id);
    else
      buckets.set(hk, [id]);
    return id;
  };
  const nearest = (r: number, g: number, b: number): number => {
    const fx = Math.floor(r / cellSz) + 1;
    const fy = Math.floor(g / cellSz) + 1;
    const fz = Math.floor(b / cellSz) + 1;
    let best = -1;
    let bd = tau * tau;
    const reach = Math.ceil(tau / cellSz);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dz = -reach; dz <= reach; dz++) {
          const list = buckets.get(((fx + dx) * 1024 + fy + dy) * 1024 + fz + dz);
          if (!list)
            continue;
          for (const id of list) {
            const d = (cr[id] - r) ** 2 + (cg[id] - g) ** 2 + (cb[id] - b) ** 2;
            if (d < bd || (d === bd && (best < 0 || id < best))) {
              best = id;
              bd = d;
            }
          }
        }
      }
    }
    return best;
  };
  const assign = new Int32Array(nb).fill(-1);
  const assignAll = (): void => {
    for (const b of order) {
      const id = nearest(bm[b * 3], bm[b * 3 + 1], bm[b * 3 + 2]);
      assign[b] = id >= 0 ? id : addCentre(bm[b * 3], bm[b * 3 + 1], bm[b * 3 + 2]);
    }
  };
  const recompute = (): void => {
    const nc = cr.length;
    const sw = new Float64Array(nc);
    const sr = new Float64Array(nc);
    const sg = new Float64Array(nc);
    const sb = new Float64Array(nc);
    for (let b = 0; b < nb; b++) {
      const id = assign[b];
      sw[id] += bc[b];
      sr[id] += bs[b * 3];
      sg[id] += bs[b * 3 + 1];
      sb[id] += bs[b * 3 + 2];
    }
    const nr: number[] = [];
    const ng: number[] = [];
    const nbl: number[] = [];
    for (let id = 0; id < nc; id++) {
      if (sw[id] > 0) {
        nr.push(sr[id] / sw[id]);
        ng.push(sg[id] / sw[id]);
        nbl.push(sb[id] / sw[id]);
      }
    }
    cr = [];
    cg = [];
    cb = [];
    buckets = new Map();
    for (let id = 0; id < nr.length; id++)
      addCentre(nr[id], ng[id], nbl[id]);
  };
  assignAll();
  for (let it = 0; it < cfg.mergeIters; it++) {
    recompute();
    assignAll();
  }
  recompute();
  assignAll();
  // Final cluster weights, means and sums of squares.
  const nc = cr.length;
  const wt = new Float64Array(nc);
  const mr = new Float64Array(nc);
  const mg = new Float64Array(nc);
  const mb = new Float64Array(nc);
  const sq = new Float64Array(nc);
  for (let b = 0; b < nb; b++) {
    const id = assign[b];
    wt[id] += bc[b];
    mr[id] += bs[b * 3];
    mg[id] += bs[b * 3 + 1];
    mb[id] += bs[b * 3 + 2];
    sq[id] += bq[b];
  }
  const alive = new Uint8Array(nc);
  for (let id = 0; id < nc; id++) {
    if (wt[id] > 0) {
      mr[id] /= wt[id];
      mg[id] /= wt[id];
      mb[id] /= wt[id];
      alive[id] = 1;
    }
  }
  const parent = Int32Array.from({ length: nc }, (_, i) => i);
  const sFloor = cfg.spreadFloorK * noise;
  const spread = (id: number): number => Math.max(sFloor, Math.sqrt(Math.max(0, sq[id] / wt[id] - mr[id] ** 2 - mg[id] ** 2 - mb[id] ** 2)));
  // Overlap merge, lightest first (ties by id), via a hash with bucket size D (the search cap).
  const D = Math.max(1.5 * tau, 2 * cfg.absorbSep * cfg.mergeMax);
  const hk = (r: number, g: number, b: number): number => ((Math.floor(r / D) + 1) * 1024 + Math.floor(g / D) + 1) * 1024 + Math.floor(b / D) + 1;
  const hb = new Map<number, number[]>();
  const where = new Int32Array(nc);
  for (let id = 0; id < nc; id++) {
    if (!alive[id])
      continue;
    where[id] = hk(mr[id], mg[id], mb[id]);
    const list = hb.get(where[id]);
    if (list)
      list.push(id);
    else
      hb.set(where[id], [id]);
  }
  const ord = Array.from({ length: nc }, (_, i) => i).filter((i) => alive[i]);
  ord.sort((p, q) => wt[p] - wt[q] || p - q);
  for (const id of ord) {
    const fx = Math.floor(mr[id] / D) + 1;
    const fy = Math.floor(mg[id] / D) + 1;
    const fz = Math.floor(mb[id] / D) + 1;
    let best = -1;
    let bd = D * D;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = hb.get(((fx + dx) * 1024 + fy + dy) * 1024 + fz + dz);
          if (!list)
            continue;
          for (const o of list) {
            if (o === id || !alive[o] || wt[o] < wt[id] || (wt[o] === wt[id] && o > id))
              continue;
            const d = (mr[o] - mr[id]) ** 2 + (mg[o] - mg[id]) ** 2 + (mb[o] - mb[id]) ** 2;
            if (Math.sqrt(d) > cfg.absorbSep * (spread(id) + spread(o)))
              continue;
            if (d < bd || (d === bd && (best < 0 || o < best))) {
              best = o;
              bd = d;
            }
          }
        }
      }
    }
    if (best < 0)
      continue;
    const tw = wt[best] + wt[id];
    mr[best] = (mr[best] * wt[best] + mr[id] * wt[id]) / tw;
    mg[best] = (mg[best] * wt[best] + mg[id] * wt[id]) / tw;
    mb[best] = (mb[best] * wt[best] + mb[id] * wt[id]) / tw;
    wt[best] = tw;
    sq[best] += sq[id];
    alive[id] = 0;
    parent[id] = best;
    const nk = hk(mr[best], mg[best], mb[best]);
    if (nk !== where[best]) {
      const old = hb.get(where[best]) as number[];
      old.splice(old.indexOf(best), 1);
      where[best] = nk;
      const list = hb.get(nk);
      if (list)
        list.push(best);
      else
        hb.set(nk, [best]);
    }
  }
  let count = 0;
  for (let id = 0; id < nc; id++)
    count += alive[id];
  for (let k = 0; k < n; k++) {
    if (binOf[k] < 0)
      continue;
    let id = assign[binOf[k]];
    while (parent[id] !== id)
      id = parent[id];
    rgb[k * 3] = mr[id];
    rgb[k * 3 + 1] = mg[id];
    rgb[k * 3 + 2] = mb[id];
  }
  return count;
}

// ---------------------------------------------------------------- background region

/**
 * Cell-level background tolerance: max(6, 3 * median, 1.5 * p95 of the output border cells' distances to the
 * background (those within the pixel tolerance), bgTolFrac * pixel tolerance), capped at the pixel tolerance.
 */
function cellBgTolerance(cells: CellColours, raw: Float32Array, bg: Rgb, pxTol: number, cfg: RectifyConfig): number {
  const { w, h, opaque } = cells;
  const ds: number[] = [];
  const add = (k: number): void => {
    if (!opaque[k])
      return;
    const d = Math.hypot(raw[k * 3] - bg[0], raw[k * 3 + 1] - bg[1], raw[k * 3 + 2] - bg[2]);
    if (d <= pxTol)
      ds.push(d);
  };
  for (let x = 0; x < w; x++) {
    add(x);
    if (h > 1)
      add((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    add(y * w);
    if (w > 1)
      add(y * w + w - 1);
  }
  if (ds.length < 4)
    return pxTol;
  ds.sort((p, q) => p - q);
  return Math.min(pxTol, Math.max(6, 3 * sortedQuantile(ds, 0.5), 1.5 * sortedQuantile(ds, 0.95), cfg.bgTolFrac * pxTol));
}

/**
 * Background mask over the output cells: 4-connected components of bg-like cells (raw colour within tauBg of the
 * background) that touch the output border or a transparent cell, plus enclosed components per cfg.pockets
 * ('size': at least pocketMin cells with mean distance <= pocketTight * tauBg).
 */
function backgroundMask(cells: CellColours, raw: Float32Array, bg: Rgb, tauBg: number, cfg: RectifyConfig): Uint8Array {
  const { w, h, opaque } = cells;
  const n = w * h;
  const dist = new Float32Array(n);
  const like = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (opaque[k]) {
      dist[k] = Math.hypot(raw[k * 3] - bg[0], raw[k * 3 + 1] - bg[1], raw[k * 3 + 2] - bg[2]);
      like[k] = dist[k] <= tauBg ? 1 : 0;
    }
  }
  const keyBg = Math.max(bg[0], bg[1], bg[2]) - Math.min(bg[0], bg[1], bg[2]) >= cfg.keyChroma;
  const seen = new Uint8Array(n);
  const mask = new Uint8Array(n);
  const stack: number[] = [];
  const members: number[] = [];
  for (let k0 = 0; k0 < n; k0++) {
    if (!like[k0] || seen[k0])
      continue;
    seen[k0] = 1;
    stack.push(k0);
    members.length = 0;
    let touches = false;
    let dsum = 0;
    while (stack.length) {
      const k = stack.pop() as number;
      members.push(k);
      dsum += dist[k];
      const x = k % w;
      const y = Math.floor(k / w);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1)
        touches = true;
      for (const nk of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
        if (nk < 0)
          continue;
        if (!opaque[nk]) {
          // Borders a transparent input cell: connected to the (already transparent) background.
          touches = true;
        } else if (like[nk] && !seen[nk]) {
          seen[nk] = 1;
          stack.push(nk);
        }
      }
    }
    let take = touches || cfg.pockets === 'all';
    if (!take && cfg.pockets === 'size')
      take = (members.length >= cfg.pocketMin || keyBg) && dsum / members.length <= cfg.pocketTight * tauBg;
    if (take) {
      for (const k of members)
        mask[k] = 1;
    }
  }
  return mask;
}

/**
 * Opaque cells with at least three background 4-neighbours and at most one other (isolated specks, 1-cell spurs)
 * whose colour is within maxDist of the background join it; repeated until stable.
 */
function despeckle(mask: Uint8Array, cells: CellColours, raw: Float32Array, bg: Rgb, maxDist: number): void {
  const { w, h, opaque } = cells;
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < w * h; k++) {
      if (mask[k] || !opaque[k])
        continue;
      const x = k % w;
      const y = Math.floor(k / w);
      let other = 0;
      let bgN = 0;
      for (const nk of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
        if (nk < 0)
          continue;
        if (mask[nk] || !opaque[nk])
          bgN++;
        else
          other++;
      }
      if (bgN >= 3 && other <= 1 && Math.hypot(raw[k * 3] - bg[0], raw[k * 3 + 1] - bg[1], raw[k * 3 + 2] - bg[2]) <= maxDist) {
        mask[k] = 1;
        changed = true;
      }
    }
  }
}

/**
 * Halo ring: opaque cells 4-adjacent to the background mask (or a transparent cell) whose raw or merged colour is
 * within maxDist of the background join it. One ring only (the mask before this pass), so near-background art is
 * never eaten progressively. Catches silhouette cells whose window mostly saw background with some art bleed.
 */
function haloRing(mask: Uint8Array, cells: CellColours, raw: Float32Array, bg: Rgb, maxDist: number): void {
  const { w, h, opaque, rgb } = cells;
  const add: number[] = [];
  for (let k = 0; k < w * h; k++) {
    if (mask[k] || !opaque[k])
      continue;
    const x = k % w;
    const y = Math.floor(k / w);
    let touches = false;
    for (const nk of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
      if (nk >= 0 && (mask[nk] || !opaque[nk]))
        touches = true;
    }
    if (!touches)
      continue;
    const dRaw = Math.hypot(raw[k * 3] - bg[0], raw[k * 3 + 1] - bg[1], raw[k * 3 + 2] - bg[2]);
    const dOut = Math.hypot(rgb[k * 3] - bg[0], rgb[k * 3 + 1] - bg[1], rgb[k * 3 + 2] - bg[2]);
    if (Math.min(dRaw, dOut) <= maxDist)
      add.push(k);
  }
  for (const k of add)
    mask[k] = 1;
}

/**
 * Chroma-key cleanup (saturated background, max - min channel >= keyChroma; art rarely uses the key colour):
 * 1. every opaque cell within keyTolFrac * key saturation of the key joins the background (darker or lighter key
 *    shades the cell tolerance misses, e.g. the key in the art's shadow);
 * 2. up to keyRings rings of cells from the background are un-blended, each fitted as c = (1 - a) * t + a * key with
 *    t neutral (dark outlines and greys: c's chroma along the key's, residual within keyNeutralResidual) or t an
 *    opaque, non-background 8-neighbour's colour (residual within keyBlendResidual). With the best fit, a >= 0.5
 *    joins the background and keyBlendMin <= a < 0.5 takes the colour t (a key-tinted fringe of the art). A ring
 *    starts from the background and the cells the previous ring un-blended (2-cell-thick tinted outlines). Skipped
 *    when more than keyArtShare of the interior art cells fit as neutral + key: the art itself uses the key's hue.
 */
function keyFringe(mask: Uint8Array, cells: CellColours, raw: Float32Array, bg: Rgb, cfg: RectifyConfig): void {
  const { w, h, opaque, rgb } = cells;
  const chroma = Math.max(bg[0], bg[1], bg[2]) - Math.min(bg[0], bg[1], bg[2]);
  if (chroma < cfg.keyChroma)
    return;
  const keyTol = cfg.keyTolFrac * chroma;
  for (let k = 0; k < w * h; k++) {
    if (!opaque[k] || mask[k])
      continue;
    const dRaw = Math.hypot(raw[k * 3] - bg[0], raw[k * 3 + 1] - bg[1], raw[k * 3 + 2] - bg[2]);
    const dOut = Math.hypot(rgb[k * 3] - bg[0], rgb[k * 3 + 1] - bg[1], rgb[k * 3 + 2] - bg[2]);
    if (Math.min(dRaw, dOut) <= keyTol)
      mask[k] = 1;
  }
  // The key's chroma (colour minus its grey level): a neutral colour blended with the key has a multiple of it.
  const keyMean = (bg[0] + bg[1] + bg[2]) / 3;
  const kc = [bg[0] - keyMean, bg[1] - keyMean, bg[2] - keyMean];
  const kk = kc[0] * kc[0] + kc[1] * kc[1] + kc[2] * kc[2];
  const frontier = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++)
    frontier[k] = mask[k] || !opaque[k] ? 1 : 0;
  if (keyHuedArtShare(cells, frontier, kc, kk, cfg) > cfg.keyArtShare)
    return;
  const fit = { a: 0, t: [0, 0, 0] };
  for (let ring = 0; ring < cfg.keyRings; ring++) {
    const drop: number[] = [];
    const recolour: { k: number; t: number[] }[] = [];
    for (let k = 0; k < w * h; k++) {
      if (frontier[k] || !opaque[k])
        continue;
      const x = k % w;
      const y = Math.floor(k / w);
      let touches = false;
      for (const nk of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
        if (nk >= 0 && frontier[nk])
          touches = true;
      }
      if (touches && unblendKey(k, x, y, cells, mask, bg, kc, kk, keyTol, cfg, fit)) {
        if (fit.a >= 0.5)
          drop.push(k);
        else
          recolour.push({ k, t: [...fit.t] });
      }
    }
    if (drop.length === 0 && recolour.length === 0)
      break;
    for (const k of drop) {
      mask[k] = 1;
      frontier[k] = 1;
    }
    for (const { k, t } of recolour) {
      rgb.set(t, k * 3);
      frontier[k] = 1;
    }
  }
}

/** Key share a and fit residual of colour c as a neutral colour blended with the key (key chroma kc, kk = |kc|²). */
function neutralKeyFit(c0: number, c1: number, c2: number, kc: number[], kk: number): { a: number; residual: number } {
  const cm = (c0 + c1 + c2) / 3;
  const cc0 = c0 - cm;
  const cc1 = c1 - cm;
  const cc2 = c2 - cm;
  const a = Math.min(KEY_MAX_SHARE, Math.max(0, (cc0 * kc[0] + cc1 * kc[1] + cc2 * kc[2]) / kk));
  return { a, residual: Math.hypot(cc0 - a * kc[0], cc1 - a * kc[1], cc2 - a * kc[2]) };
}

/** Share of the interior art cells (no 4-neighbour in `edge`) that fit as a neutral colour blended with the key. */
function keyHuedArtShare(cells: CellColours, edge: Uint8Array, kc: number[], kk: number, cfg: RectifyConfig): number {
  const { w, h, opaque, rgb } = cells;
  let interior = 0;
  let hued = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (edge[k] || !opaque[k] || edge[k - 1] || edge[k + 1] || edge[k - w] || edge[k + w])
        continue;
      interior++;
      const f = neutralKeyFit(rgb[k * 3], rgb[k * 3 + 1], rgb[k * 3 + 2], kc, kk);
      if (f.a >= cfg.keyBlendMin && f.residual <= cfg.keyNeutralResidual)
        hued++;
    }
  }
  return interior > 0 ? hued / interior : 0;
}

/**
 * Best key-blend fit of cell k (see keyFringe) into `fit` ({ a, t }); false when no fit reaches keyBlendMin within
 * its residual.
 */
function unblendKey(k: number, x: number, y: number, cells: CellColours, mask: Uint8Array, bg: Rgb, kc: number[], kk: number,
  keyTol: number, cfg: RectifyConfig, fit: { a: number; t: number[] }): boolean {
  const { w, h, opaque, rgb } = cells;
  const c0 = rgb[k * 3];
  const c1 = rgb[k * 3 + 1];
  const c2 = rgb[k * 3 + 2];
  let found = false;
  // Neutral t: c's chroma = a * key chroma.
  const nf = neutralKeyFit(c0, c1, c2, kc, kk);
  const an = nf.a;
  if (an >= cfg.keyBlendMin && nf.residual <= cfg.keyNeutralResidual) {
    const t = (c: number, kv: number): number => Math.min(255, Math.max(0, (c - an * kv) / (1 - an)));
    fit.a = an;
    fit.t[0] = t(c0, bg[0]);
    fit.t[1] = t(c1, bg[1]);
    fit.t[2] = t(c2, bg[2]);
    found = true;
  }
  // A neighbour's colour as t: c = n + a * (key - n).
  let bestRes = cfg.keyBlendResidual;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      const nk = yy * w + xx;
      if ((dx === 0 && dy === 0) || xx < 0 || yy < 0 || xx >= w || yy >= h || mask[nk] || !opaque[nk])
        continue;
      const n0 = rgb[nk * 3];
      const n1 = rgb[nk * 3 + 1];
      const n2 = rgb[nk * 3 + 2];
      const v0 = bg[0] - n0;
      const v1 = bg[1] - n1;
      const v2 = bg[2] - n2;
      const vv = v0 * v0 + v1 * v1 + v2 * v2;
      if (vv < keyTol * keyTol)
        continue;
      const a = Math.min(1, Math.max(0, ((c0 - n0) * v0 + (c1 - n1) * v1 + (c2 - n2) * v2) / vv));
      const res = Math.hypot(c0 - n0 - a * v0, c1 - n1 - a * v1, c2 - n2 - a * v2);
      if (res < bestRes && a >= cfg.keyBlendMin && (!found || a > fit.a)) {
        bestRes = res;
        fit.a = a;
        fit.t[0] = n0;
        fit.t[1] = n1;
        fit.t[2] = n2;
        found = true;
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------- output

/** Most frequent exact opaque colour among the output's border cells (lowest packed colour on ties). */
function dominantBorderCell(out: Uint8Array, w: number, h: number): Rgb | null {
  const counts = new Map<number, number>();
  let best = -1;
  let bestKey = -1;
  const add = (k: number): void => {
    if (out[k * 4 + 3] < 128)
      return;
    const key = (out[k * 4] << 16) | (out[k * 4 + 1] << 8) | out[k * 4 + 2];
    const v = (counts.get(key) ?? 0) + 1;
    counts.set(key, v);
    if (v > best || (v === best && key < bestKey)) {
      best = v;
      bestKey = key;
    }
  };
  for (let x = 0; x < w; x++) {
    add(x);
    add((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    add(y * w);
    add(y * w + w - 1);
  }
  return bestKey < 0 ? null : [(bestKey >> 16) & 255, (bestKey >> 8) & 255, bestKey & 255];
}

/** Pads to a max(w, h) square, content centred (floor); fill = colour (opaque) or transparent when null. */
export function padSquare(img: RgbaImage, fill: Rgb | null): RgbaImage {
  const { width: w, height: h, data } = img;
  if (w === h)
    return img;
  const side = Math.max(w, h);
  const sq = new Uint8Array(side * side * 4);
  if (fill) {
    for (let k = 0; k < side * side; k++) {
      sq[k * 4] = fill[0];
      sq[k * 4 + 1] = fill[1];
      sq[k * 4 + 2] = fill[2];
      sq[k * 4 + 3] = 255;
    }
  }
  const ox = (side - w) >> 1;
  const oy = (side - h) >> 1;
  for (let y = 0; y < h; y++)
    sq.set(data.subarray(y * w * 4, (y + 1) * w * 4), ((y + oy) * side + ox) * 4);
  return { width: side, height: side, data: sq };
}

// ---------------------------------------------------------------- entry points

/** Rectified image plus the diagnostics of each stage (for UI hints such as the detected background swatch). */
export interface RectifyDetail {
  image: RgbaImage;
  background: BackgroundInfo;
  /** Fitted PSF / phase (NO_PSF values when not fitted, e.g. inputs with alpha). */
  psf: Psf;
  /** The small-cell deconvolution ran. */
  deconvolved: boolean;
  /** Palette leader tolerance (0 when merging is off) and resulting number of colours. */
  mergeTolerance: number;
  clusters: number;
  /** Cell-level background tolerance (0 without a background colour) and the number of background cells. */
  bgCellTolerance: number;
  bgCells: number;
  /** Per-channel pixel noise sigma estimate. */
  pixelSigma: number;
  /** Edge snapping diagnostics; null when snapping did not run. */
  snap: SnapInfo | null;
}

/**
 * Rectifies a pseudo-pixel-art image on a grid (see the file header for the pipeline): one output pixel per grid cell
 * whose centre lies inside the image (outputDims), binary alpha, optional background removal and square padding.
 * cfg overrides the tuned DEFAULTS (e.g. palette merge off, background tolerance) for advanced UI options.
 */
export function rectifyDetailed(img: RgbaImage, grid: GridSpec, opts: RectifyOptions, cfg: RectifyConfig = DEFAULTS): RectifyDetail {
  const g = normaliseGrid(grid);
  const dims = outputDims(g, img.width, img.height);
  const ow = dims.width;
  const oh = dims.height;
  const n = ow * oh;
  const wantDeconv = cfg.deconv !== 0 && g.size < cfg.deconvMaxSize;
  let psf = NO_PSF;
  if ((wantDeconv || cfg.phaseFix) && !hasTransparency(img))
    psf = cfg.deconv > 0 ? { ...NO_PSF, sigma: cfg.deconv } : estimatePsf(img, g, dims, cfg);
  // Per-cell phase of the true edges, clamped to +-0.45 cell.
  const phaseOf = (count: number, off: number, first: number, d: number, c: number, slope: number): Float64Array => {
    const out = new Float64Array(count);
    const lim = 0.45 * g.size;
    for (let i = 0; i < count; i++) {
      const v = d + slope * (off + (first + i + 0.5) * g.size - c);
      out[i] = v < -lim ? -lim : v > lim ? lim : v;
    }
    return out;
  };
  const phX = phaseOf(ow, g.offsetX, dims.firstX, psf.dx, psf.cx, psf.slopeX);
  const phY = phaseOf(oh, g.offsetY, dims.firstY, psf.dy, psf.cy, psf.slopeY);
  const shX = cfg.phaseFix ? phX : undefined;
  const shY = cfg.phaseFix ? phY : undefined;
  const bgInfo = detectBackground(img, cfg.bgCoverage);
  // Step 1b. Without snapping every cell keeps the separable phase-corrected windows (one band), exactly as before
  // the option existed; snapped lines start from those same positions, so a line that does not move changes nothing.
  let win: CellWindows;
  let snap: SnapInfo | null = null;
  if (opts.snapToEdges && cfg.snap.mode !== 'off' && g.size >= cfg.snap.minSize && ow > 0 && oh > 0) {
    const sw = snapWindows(img, g, dims, shX, shY, bgInfo, cfg);
    win = sw.win;
    snap = sw.info;
  } else {
    win = plainWindows(axisWindows(g.offsetX, g.size, img.width, dims.firstX, ow, cfg.margin, shX), axisWindows(g.offsetY, g.size, img.height, dims.firstY, oh, cfg.margin, shY));
  }
  const cells = extractCells(img, g.size, win, cfg, !snap || cfg.snap.recentre);
  let deconvolved = false;
  if (wantDeconv && psf.sigma >= cfg.deconvMinSigma && !cells.opaque.some((v) => v === 0)) {
    const Kx = win.wx.map((wx, b) => axisKernel(g.offsetX, g.size, dims.firstX, wx, psf.sigma, phX, snap ? snap.dispX[b] : undefined));
    const Ky = win.wy.map((wy, b) => axisKernel(g.offsetY, g.size, dims.firstY, wy, psf.sigma, phY, snap ? snap.dispY[b] : undefined));
    cells.rgb = deconvolveCells(cells, Kx, Ky, win.rowBand, win.colBand, cfg.deconvIters);
    deconvolved = true;
  }
  const raw = cells.rgb.slice();
  let tau = 0;
  let clusters = 0;
  if (cfg.merge && opts.mergeColors) {
    // The noise scale comes from the art: background-like cells (pixel tolerance) are excluded.
    let exclude: Uint8Array | undefined;
    if (bgInfo.color) {
      const bgc = bgInfo.color;
      exclude = new Uint8Array(n);
      let nEx = 0;
      for (let k = 0; k < n; k++) {
        if (cells.opaque[k] && Math.hypot(raw[k * 3] - bgc[0], raw[k * 3 + 1] - bgc[1], raw[k * 3 + 2] - bgc[2]) <= bgInfo.tolerance) {
          exclude[k] = 1;
          nEx++;
        }
      }
      if (n - nEx < 16)
        exclude = undefined;
    }
    const noise = neighbourNoise(cells, cfg.mergeQ, exclude);
    tau = Math.min(cfg.mergeMax, Math.max(cfg.mergeMin, cfg.mergeK * noise));
    clusters = mergePalette(cells, tau, noise, cfg);
  }
  let mask: Uint8Array | null = null;
  let tauBg = 0;
  if (bgInfo.color) {
    tauBg = cellBgTolerance(cells, raw, bgInfo.color, bgInfo.tolerance, cfg);
    mask = backgroundMask(cells, raw, bgInfo.color, tauBg, cfg);
    if (cfg.halo > 0)
      haloRing(mask, cells, raw, bgInfo.color, cfg.halo * tauBg);
    if (cfg.despeckle > 0)
      despeckle(mask, cells, raw, bgInfo.color, cfg.despeckle * tauBg);
    keyFringe(mask, cells, raw, bgInfo.color, cfg);
  }
  const out = new Uint8Array(n * 4);
  let bgCells = 0;
  for (let k = 0; k < n; k++) {
    if (!cells.opaque[k])
      continue;
    if (mask && mask[k]) {
      bgCells++;
      if (opts.removeBackground)
        continue;
      if (cfg.flattenBg && bgInfo.color) {
        out[k * 4] = bgInfo.color[0];
        out[k * 4 + 1] = bgInfo.color[1];
        out[k * 4 + 2] = bgInfo.color[2];
        out[k * 4 + 3] = 255;
        continue;
      }
    }
    out[k * 4] = Math.round(cells.rgb[k * 3]);
    out[k * 4 + 1] = Math.round(cells.rgb[k * 3 + 1]);
    out[k * 4 + 2] = Math.round(cells.rgb[k * 3 + 2]);
    out[k * 4 + 3] = 255;
  }
  let image: RgbaImage = { width: ow, height: oh, data: out };
  if (opts.makeSquare && ow > 0 && oh > 0) {
    // Padding: transparent when removing the background or when the input's background is transparency; else the
    // solid background colour, or the dominant output border colour when no solid background was found.
    const fill = opts.removeBackground || bgInfo.transparent ? null : bgInfo.color ?? dominantBorderCell(out, ow, oh) ?? bgInfo.dominant;
    image = padSquare(image, fill);
  }
  return { image, background: bgInfo, psf, deconvolved, mergeTolerance: tau, clusters, bgCellTolerance: tauBg, bgCells, pixelSigma: cells.sigma, snap };
}

/**
 * The pixel-art image for `img` under `grid` with the default configuration (see rectifyDetailed), then reduced to
 * opts.maxColors colours (a kept background colour stays exact and counts toward them).
 */
export function rectify(img: RgbaImage, grid: GridSpec, opts: RectifyOptions): RectifyResult {
  const d = rectifyDetailed(img, grid, opts, DEFAULTS);
  const image = quantizeColors(d.image, opts.maxColors, opts.removeBackground ? null : d.background.color);
  const colours = new Set<number>();
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] !== 0)
      colours.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
  }
  return { image, background: d.background.color, colorCount: colours.size };
}
