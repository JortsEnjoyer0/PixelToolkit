// npm run test:pixelart (or npx tsx scripts/test-pixelart.ts)
// Node checks for Img to PixelArt's framework-free core (src/renderer/src/core/pixelart, docs/img2pixel/img2pixel.md
// "Algorithm"): the grid model; estimateGrid and rectify on synthetic pseudo pixel art (the true-pixel sprites of
// assets/test_imgs upscaled by known fractional sizes and offsets, with blur and noise); the rectify options; the colour
// quantizer (Max colours); edge snapping on two-sprite sheets (side by side, stacked, small cells); inputs that must not
// throw; and the real AI samples of assets/test_imgs/fakepixelart (sizes checked by eye, locked here).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { RgbaImage } from '../src/shared/image';
import { estimateGrid } from '../src/renderer/src/core/pixelart/estimate';
import { gridCells, normalizeGrid, outputSize, type GridSpec } from '../src/renderer/src/core/pixelart/grid';
import { COLOR_LIMITS, quantizeColors, snapColorLimit } from '../src/renderer/src/core/pixelart/quantize';
import { detectBackground, rectify, type RectifyOptions } from '../src/renderer/src/core/pixelart/rectify';
import { decodePng } from '../src/main/png';

const ROOT = path.resolve(__dirname, '..');
const SPRITES = path.join(ROOT, 'assets', 'test_imgs');
const REAL = path.join(SPRITES, 'fakepixelart');

/** Real samples: the estimate checked by eye (grid overlay on zoomed crops and the rectified output). */
const REAL_SIZES: Record<string, number> = {
  fakepixelart_candleholder: 9.21,
  fakepixelart_cyberpunk_spritesheet_test: 5.358,
  fakepixelart_detailedfairyportrait_no_background_removal: 6.024,
  fakepixelart_fantasy2_spritesheet: 9.359,
  fakepixelart_fantasy_spritesheet: 7.56,
  fakepixelart_knight1: 9.301,
  fakepixelart_knight2: 6.297,
  fakepixelart_peasantboy_transparent_bg: 7.291
};
/** Relative size tolerance for the real samples (a regression, not a re-tuning, should trip it). */
const REAL_TOL = 0.005;
/** Colour match tolerance (RGB distance) between a rectified cell and the true art pixel. */
const COLOUR_TOL = 24;
/** Least recovery of the offset sprite with snapping on (two-sprite sheets; measured values sit a few points above). */
const SNAP_FLOOR_LARGE = 0.97;
const SNAP_FLOOR_SMALL = 0.92;
const ON: RectifyOptions = { removeBackground: true, makeSquare: false, mergeColors: true, snapToEdges: false, maxColors: 0 };

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++;
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

function readImage(file: string): RgbaImage {
  return decodePng(new Uint8Array(readFileSync(file)));
}

/** Deterministic PRNG (mulberry32) and a Gaussian from it. */
function rng(seed: number): { next: () => number; gauss: () => number } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = (): number => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

interface Case {
  name: string;
  img: RgbaImage;
  grid: GridSpec;
  art: RgbaImage;
  /** Grid cell index of art pixel (0, 0). */
  cell0: [number, number];
}

/**
 * Pseudo pixel art: `art` drawn with fake pixels of `size` px (cell k spans offset + k·size …) on a solid background,
 * then a 3x3 blur (weight `blur` for the 8 neighbours) and Gaussian noise (sigma `noise`).
 */
function synth(name: string, art: RgbaImage, size: number, offset: [number, number], bg: [number, number, number], blur: number, noise: number, seed: number): Case {
  const margin = 6;
  const w = Math.round((art.width + 2 * margin) * size);
  const h = Math.round((art.height + 2 * margin) * size);
  const sharp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const j = Math.floor((y + 0.5 - offset[1]) / size) - margin;
    for (let x = 0; x < w; x++) {
      const i = Math.floor((x + 0.5 - offset[0]) / size) - margin;
      const a = i >= 0 && j >= 0 && i < art.width && j < art.height ? (j * art.width + i) * 4 : -1;
      const opaque = a >= 0 && art.data[a + 3] >= 128;
      for (let c = 0; c < 3; c++)
        sharp[(y * w + x) * 3 + c] = opaque ? art.data[a + c] : bg[c];
    }
  }
  const r = rng(seed);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let wsum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            const wt = dx === 0 && dy === 0 ? 1 : blur;
            sum += wt * sharp[(yy * w + xx) * 3 + c];
            wsum += wt;
          }
        }
        data[(y * w + x) * 4 + c] = Math.min(255, Math.max(0, Math.round(sum / wsum + noise * r.gauss())));
      }
      data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return { name, img: { width: w, height: h, data }, grid: { size, offsetX: offset[0], offsetY: offset[1] }, art, cell0: [margin, margin] };
}

/** Worst and mean distance (in cells) from each true grid line over the art to the nearest estimated line. */
function lineError(c: Case, est: GridSpec): { mean: number; max: number } {
  const errs: number[] = [];
  const axis = (off: number, estOff: number, k0: number, n: number): void => {
    for (let k = k0; k <= k0 + n; k++) {
      const p = off + k * c.grid.size;
      const d = (((p - estOff) % est.size) + est.size) % est.size;
      errs.push(Math.min(d, est.size - d) / c.grid.size);
    }
  };
  axis(c.grid.offsetX, est.offsetX, c.cell0[0], c.art.width);
  axis(c.grid.offsetY, est.offsetY, c.cell0[1], c.art.height);
  return { mean: errs.reduce((s, e) => s + e, 0) / errs.length, max: Math.max(...errs) };
}

/** Rectify on the true grid: share of opaque art pixels recovered within COLOUR_TOL, and of transparent ones cleared. */
function recovery(c: Case, opts: RectifyOptions): { colour: number; alpha: number } {
  const out = rectify(c.img, c.grid, opts).image;
  const fx = gridCells(c.img.width, c.grid.size, c.grid.offsetX).first;
  const fy = gridCells(c.img.height, c.grid.size, c.grid.offsetY).first;
  let opaque = 0;
  let hit = 0;
  let clear = 0;
  let cleared = 0;
  for (let j = 0; j < c.art.height; j++) {
    for (let i = 0; i < c.art.width; i++) {
      const a = (j * c.art.width + i) * 4;
      const o = ((c.cell0[1] + j - fy) * out.width + c.cell0[0] + i - fx) * 4;
      if (c.art.data[a + 3] >= 128) {
        opaque++;
        const d = Math.hypot(out.data[o] - c.art.data[a], out.data[o + 1] - c.art.data[a + 1], out.data[o + 2] - c.art.data[a + 2]);
        if (out.data[o + 3] === 255 && d <= COLOUR_TOL)
          hit++;
      } else {
        clear++;
        if (out.data[o + 3] === 0)
          cleared++;
      }
    }
  }
  return { colour: hit / opaque, alpha: clear ? cleared / clear : 1 };
}

const opaqueColours = (img: RgbaImage): number => {
  const set = new Set<number>();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] !== 0)
      set.add((img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2]);
  }
  return set.size;
};

function testGridModel(): void {
  check('normalizeGrid wraps offsets', JSON.stringify(normalizeGrid({ size: 10, offsetX: -3, offsetY: 27 })) === JSON.stringify({ size: 10, offsetX: 7, offsetY: 7 }));
  check('normalizeGrid clamps the size', normalizeGrid({ size: 0.5, offsetX: 0, offsetY: 0 }).size === 2 && normalizeGrid({ size: 1e6, offsetX: 0, offsetY: 0 }).size === 256);
  check('normalizeGrid keeps 3 size decimals and 2 offset decimals', JSON.stringify(normalizeGrid({ size: 5.35812, offsetX: 1.2345, offsetY: 0 })) === JSON.stringify({ size: 5.358, offsetX: 1.23, offsetY: 0 }));
  check('normalizeGrid survives NaN', JSON.stringify(normalizeGrid({ size: NaN, offsetX: NaN, offsetY: Infinity })) === JSON.stringify({ size: 2, offsetX: 0, offsetY: 0 }));
  check('normalizeGrid never yields offset === size', normalizeGrid({ size: 3, offsetX: 2.999, offsetY: 0 }).offsetX === 0);
  check('gridCells: whole cells', JSON.stringify(gridCells(100, 10, 0)) === JSON.stringify({ first: 0, count: 10 }));
  check('gridCells: a partial first cell counts when its centre is inside', JSON.stringify(gridCells(100, 10, 6)) === JSON.stringify({ first: -1, count: 10 }));
  check('gridCells: a partial cell less than half inside is dropped', JSON.stringify(gridCells(100, 10, 4)) === JSON.stringify({ first: 0, count: 10 }));
  check('gridCells: fractional size', gridCells(1254, 5.358, 4.77).count === 234);
  check('outputSize: plain and squared', JSON.stringify(outputSize(100, 50, { size: 10, offsetX: 0, offsetY: 0 }, false)) === JSON.stringify({ width: 10, height: 5 })
    && JSON.stringify(outputSize(100, 50, { size: 10, offsetX: 0, offsetY: 0 }, true)) === JSON.stringify({ width: 10, height: 10 }));
}

function testSynthetic(sprites: { name: string; img: RgbaImage }[]): void {
  const params: [number, [number, number], [number, number, number], number, number][] = [
    [8, [0, 0], [255, 255, 255], 0, 0],
    [7.5, [3.2, 5.9], [250, 250, 248], 0.15, 3],
    [9.3, [1.1, 7.4], [228, 0, 255], 0.2, 4],
    [5.36, [4.77, 1.02], [40, 44, 52], 0.25, 4],
    [12.6, [9.9, 2.5], [120, 160, 200], 0.3, 6],
    [15.6, [0.4, 12.2], [250, 4, 250], 0.15, 5]
  ];
  params.forEach(([size, off, bg, blur, noise], n) => {
    const sp = sprites[n % sprites.length];
    const c = synth(`${sp.name} @ ${size}`, sp.img, size, off, bg, blur, noise, 1000 + n);
    const t0 = performance.now();
    const est = estimateGrid(c.img);
    const ms = performance.now() - t0;
    const err = lineError(c, est);
    check(`estimate ${c.name}: size`, Math.abs(est.size / size - 1) < 0.01, `got ${est.size.toFixed(3)}`);
    check(`estimate ${c.name}: grid lines on the fake pixels`, err.mean < 0.15 && err.max < 0.35, `mean ${err.mean.toFixed(3)} max ${err.max.toFixed(3)} cells`);
    check(`estimate ${c.name}: confidence in [0, 1]`, est.confidence >= 0 && est.confidence <= 1);
    check(`estimate ${c.name}: fast enough`, ms < 3000, `${ms.toFixed(0)} ms`);
    const rec = recovery(c, ON);
    check(`rectify ${c.name}: colours recovered`, rec.colour >= 0.97, `${(rec.colour * 100).toFixed(1)} %`);
    check(`rectify ${c.name}: background removed`, rec.alpha >= 0.98, `${(rec.alpha * 100).toFixed(1)} %`);
  });
  const exact = synth('exact upscale', sprites[0].img, 6, [0, 0], [255, 255, 255], 0, 0, 7);
  const est = estimateGrid(exact.img);
  check('a clean integer upscale is found exactly', est.size === 6 && est.offsetX === 0 && est.offsetY === 0, JSON.stringify(est));
  const lossless = rectify(exact.img, exact.grid, { ...ON, mergeColors: false }).image;
  let same = true;
  for (let j = 0; j < exact.art.height && same; j++) {
    for (let i = 0; i < exact.art.width && same; i++) {
      const a = (j * exact.art.width + i) * 4;
      const o = ((exact.cell0[1] + j) * lossless.width + exact.cell0[0] + i) * 4;
      const opaque = exact.art.data[a + 3] >= 128;
      same = opaque ? [0, 1, 2].every((c) => lossless.data[o + c] === exact.art.data[a + c]) && lossless.data[o + 3] === 255 : lossless.data[o + 3] === 0;
    }
  }
  check('…and rectifies losslessly (exact colours, background cleared)', same);
  // A misaligned grid with partial first cells (offset > size / 2): the edge cells still sample the image
  const edge = synth('edge cells', sprites[0].img, 2.5, [1.6, 1.6], [255, 255, 255], 0.2, 2, 11);
  const shifted = rectify(edge.img, { size: 2.5, offsetX: 1.6 + 0.75, offsetY: 1.6 + 0.75 }, { ...ON, removeBackground: false }).image;
  let dark = 0;
  for (let k = 0; k < shifted.width; k++) {
    for (const o of [k * 4, k * shifted.width * 4]) {
      if (shifted.data[o] + shifted.data[o + 1] + shifted.data[o + 2] < 3 * 128)
        dark++;
    }
  }
  check('edge cells of a misaligned grid keep the background colour', dark === 0, `${dark} dark edge cells`);
}

function testOptions(sprites: { name: string; img: RgbaImage }[]): void {
  // A non-square sprite, so Make square really pads
  const wide = sprites.find((s) => s.img.width !== s.img.height) ?? sprites[0];
  const c = synth('options', wide.img, 9.3, [2, 5], [250, 250, 248], 0.2, 5, 42);
  const plain = rectify(c.img, c.grid, ON);
  const dims = outputSize(c.img.width, c.img.height, c.grid, false);
  check('rectify output is one px per cell', plain.image.width === dims.width && plain.image.height === dims.height);
  check('alpha is binary', plain.image.data.every((v, i) => i % 4 !== 3 || v === 0 || v === 255));
  check('background colour detected', plain.background !== null && Math.hypot(plain.background[0] - 250, plain.background[1] - 250, plain.background[2] - 248) < 6);
  check('colorCount counts the opaque colours', plain.colorCount === opaqueColours(plain.image));
  const kept = rectify(c.img, c.grid, { ...ON, removeBackground: false });
  check('without removal the background is one solid colour', kept.image.data[3] === 255 && opaqueColours(kept.image) <= plain.colorCount + 1);
  const unmerged = rectify(c.img, c.grid, { ...ON, mergeColors: false });
  check('merging reduces the colours', plain.colorCount < unmerged.colorCount, `${plain.colorCount} vs ${unmerged.colorCount}`);
  const sq = rectify(c.img, c.grid, { ...ON, makeSquare: true }).image;
  const side = Math.max(dims.width, dims.height);
  check('the options case is not square', dims.width !== dims.height, JSON.stringify(dims));
  check('makeSquare pads to the larger side', sq.width === side && sq.height === side);
  // Centred (floor): the padding band is the first floor((side - w) / 2) columns (or rows)
  const padX = Math.floor((side - dims.width) / 2);
  const padY = Math.floor((side - dims.height) / 2);
  const bandPixel = ((padY > 0 ? 0 : side >> 1) * side + (padX > 0 ? 0 : side >> 1)) * 4;
  const firstContent = (padY * side + padX) * 4;
  check('makeSquare centres the content', sq.data.subarray(firstContent, firstContent + 4).join() === plain.image.data.subarray(0, 4).join());
  check('makeSquare pads transparent when removing the background', sq.data[bandPixel + 3] === 0);
  const sqKept = rectify(c.img, c.grid, { ...ON, makeSquare: true, removeBackground: false }).image;
  check('makeSquare pads with the background colour when keeping it', sqKept.data[bandPixel + 3] === 255
    && Math.hypot(sqKept.data[bandPixel] - 250, sqKept.data[bandPixel + 1] - 250, sqKept.data[bandPixel + 2] - 248) < 6);
  const empty = outputSize(c.img.width, c.img.height, { size: c.img.height * 3, offsetX: 0, offsetY: c.img.height * 1.4 }, true);
  check('makeSquare never squares an axis without cells', empty.width === 0 || empty.height === 0, JSON.stringify(empty));
  const bg = detectBackground(c.img);
  check('detectBackground finds the solid border colour', bg.color !== null && !bg.transparent);
  const whole = estimateGrid(c.img, { integerOnly: true });
  check('integerOnly gives whole sizes and offsets', [whole.size, whole.offsetX, whole.offsetY].every(Number.isInteger) && whole.size === 9, JSON.stringify(whole));
  const fixed = estimateGrid(c.img, { minSize: 9.3, maxSize: 9.3 });
  check('minSize = maxSize fits only the offsets', fixed.size === 9.3 && lineError(c, fixed).max < 0.35, JSON.stringify(fixed));
}

/**
 * Best share of an art's opaque pixels recovered within COLOUR_TOL by the output, over integer shifts of up to 2 cells
 * around the expected placement (a sprite offset from the grid has no unique cell mapping).
 */
function bestRecovery(out: RgbaImage, art: RgbaImage, x0: number, y0: number): number {
  let best = 0;
  for (let sy = -2; sy <= 2; sy++) {
    for (let sx = -2; sx <= 2; sx++) {
      let opaque = 0;
      let hit = 0;
      for (let j = 0; j < art.height; j++) {
        for (let i = 0; i < art.width; i++) {
          const a = (j * art.width + i) * 4;
          if (art.data[a + 3] < 128)
            continue;
          opaque++;
          const x = x0 + sx + i;
          const y = y0 + sy + j;
          if (x < 0 || y < 0 || x >= out.width || y >= out.height)
            continue;
          const o = (y * out.width + x) * 4;
          if (out.data[o + 3] === 255 && Math.hypot(out.data[o] - art.data[a], out.data[o + 1] - art.data[a + 1], out.data[o + 2] - art.data[a + 2]) <= COLOUR_TOL)
            hit++;
        }
      }
      best = Math.max(best, opaque ? hit / opaque : 0);
    }
  }
  return best;
}

interface SheetRun { aligned: number; offset: number; width: number; height: number }

/**
 * Two sprites on one sheet, the second 0.45 / 0.4 cell off the first one's grid: side by side ('row', no shared
 * columns) or stacked ('column': they share columns, so only band-wise snapping can give each its own vertical lines).
 * Rectified on the first sprite's grid; returns both sprites' best recovery and the output size.
 */
function snapSheet(sprites: { name: string; img: RgbaImage }[], layout: 'row' | 'column', size: number, snap: boolean): SheetRun {
  const off: [number, number] = [2.1, 3.3];
  const a = synth('sheet a', sprites[0].img, size, off, [250, 4, 250], 0.2, 3, 21);
  const b = synth('sheet b', sprites[2].img, size, [off[0] + 0.45 * size, off[1] + 0.4 * size], [250, 4, 250], 0.2, 3, 22);
  const bx = layout === 'row' ? a.img.width : 0;
  const by = layout === 'row' ? 0 : a.img.height;
  const w = Math.max(a.img.width, bx + b.img.width);
  const h = Math.max(a.img.height, by + b.img.height);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++)
    data.set([250, 4, 250, 255], i * 4);
  const paste = (src: RgbaImage, x0: number, y0: number): void => {
    for (let y = 0; y < src.height; y++)
      data.set(src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4), ((y0 + y) * w + x0) * 4);
  };
  paste(a.img, 0, 0);
  paste(b.img, bx, by);
  const grid = normalizeGrid({ size, offsetX: off[0], offsetY: off[1] });
  const fx = gridCells(w, grid.size, grid.offsetX).first;
  const fy = gridCells(h, grid.size, grid.offsetY).first;
  const image = rectify({ width: w, height: h, data }, grid, { ...ON, snapToEdges: snap }).image;
  return {
    aligned: bestRecovery(image, a.art, a.cell0[0] - fx, a.cell0[1] - fy),
    offset: bestRecovery(image, b.art, Math.round((bx + b.grid.offsetX - grid.offsetX) / size) + b.cell0[0] - fx,
      Math.round((by + b.grid.offsetY - grid.offsetY) / size) + b.cell0[1] - fy),
    width: image.width,
    height: image.height
  };
}

/**
 * Snap to pixel edges on two-sprite sheets: the offset sprite must improve clearly and reach a floor (snapping that
 * did nothing, ignored the bands, skipped the vertical lines or the small-cell deconvolution would miss it), the
 * aligned one must not get worse, and the output size never changes.
 */
function testSnap(sprites: { name: string; img: RgbaImage }[]): void {
  const cases: [string, 'row' | 'column', number, number][] = [
    ['side by side', 'row', 8.4, SNAP_FLOOR_LARGE],
    ['stacked (shared columns)', 'column', 8.4, SNAP_FLOOR_LARGE],
    ['side by side, small cells', 'row', 5.4, SNAP_FLOOR_SMALL]
  ];
  for (const [name, layout, size, floor] of cases) {
    const off = snapSheet(sprites, layout, size, false);
    const on = snapSheet(sprites, layout, size, true);
    const pct = (v: number): string => `${(v * 100).toFixed(1)} %`;
    console.log(`  snap ${name} @ ${size}: offset sprite ${pct(off.offset)} -> ${pct(on.offset)}, aligned ${pct(off.aligned)} -> ${pct(on.aligned)}`);
    check(`snap ${name}: output size unchanged`, on.width === off.width && on.height === off.height);
    check(`snap ${name}: the offset sprite recovers`, on.offset >= off.offset + 0.05 && on.offset >= floor, `${pct(off.offset)} -> ${pct(on.offset)}`);
    check(`snap ${name}: the aligned sprite keeps`, on.aligned >= off.aligned - 0.01, `${pct(off.aligned)} -> ${pct(on.aligned)}`);
  }
  // On a single sprite with an exact grid snapping changes (almost) nothing
  const single = synth('snap single', sprites[1].img, 9.3, [2, 5], [250, 250, 248], 0.2, 5, 42);
  const r0 = recovery(single, ON).colour;
  const r1 = recovery(single, { ...ON, snapToEdges: true }).colour;
  check('snap does not hurt an aligned single sprite', r1 >= r0 - 0.01, `${(r0 * 100).toFixed(1)} % -> ${(r1 * 100).toFixed(1)} %`);
}

function testDegenerate(): void {
  const solid = (w: number, h: number, rgba: number[]): RgbaImage => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++)
      data.set(rgba, i * 4);
    return { width: w, height: h, data };
  };
  const r = rng(5);
  const noise = solid(64, 64, [0, 0, 0, 255]);
  for (let i = 0; i < noise.data.length; i++)
    noise.data[i] = i % 4 === 3 ? 255 : Math.floor(r.next() * 256);
  const inputs: [string, RgbaImage][] = [
    ['1x1', solid(1, 1, [10, 20, 30, 255])],
    ['8x8', solid(8, 8, [200, 0, 0, 255])],
    ['flat 64x64', solid(64, 64, [128, 128, 128, 255])],
    ['transparent 64x64', solid(64, 64, [0, 0, 0, 0])],
    ['noise 64x64', noise]
  ];
  for (const [name, img] of inputs) {
    let ok = true;
    let detail = '';
    try {
      const est = estimateGrid(img);
      ok = [est.size, est.offsetX, est.offsetY, est.confidence].every(Number.isFinite) && est.size >= 1;
      const grid = normalizeGrid(est);
      const out = rectify(img, grid, { removeBackground: true, makeSquare: true, mergeColors: true, snapToEdges: true, maxColors: 8 }).image;
      const dims = outputSize(img.width, img.height, grid, true);
      ok = ok && out.width === dims.width && out.height === dims.height && out.data.length === out.width * out.height * 4;
      detail = JSON.stringify(est);
    } catch (e) {
      ok = false;
      detail = String(e);
    }
    check(`degenerate ${name}: no throw, sane grid and output`, ok, detail);
  }
  // Hostile grids straight into rectify (the store always normalizes, other callers might not)
  const img = inputs[4][1];
  for (const grid of [{ size: 0, offsetX: 0, offsetY: 0 }, { size: NaN, offsetX: 1, offsetY: 1 }, { size: 1e-7, offsetX: 0, offsetY: 0 },
    { size: 4, offsetX: NaN, offsetY: Infinity }, { size: 4, offsetX: -1e9, offsetY: 1e9 }]) {
    const t0 = performance.now();
    const out = rectify(img, grid, ON).image;
    check(`rectify survives grid ${JSON.stringify(grid)}`, out.width >= 0 && out.width <= img.width && out.height <= img.height
      && out.data.length === out.width * out.height * 4 && performance.now() - t0 < 2000, `${out.width}x${out.height}`);
  }
  check('estimateGrid ignores non-finite options', Number.isFinite(estimateGrid(img, { minSize: NaN, maxSize: Infinity }).size));
}

/** Mean RGB distance between the opaque pixels of two same-size images. */
function meanRgbError(a: RgbaImage, b: RgbaImage): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i + 3] === 0)
      continue;
    sum += Math.hypot(a.data[i] - b.data[i], a.data[i + 1] - b.data[i + 1], a.data[i + 2] - b.data[i + 2]);
    n++;
  }
  return n ? sum / n : 0;
}

function testQuantize(): void {
  check('COLOR_LIMITS: none, 8 .. 64 by 8, then 128 and 256', COLOR_LIMITS.join() === '0,8,16,24,32,40,48,56,64,128,256');
  check('snapColorLimit snaps to the nearest setting', snapColorLimit(50) === 48 && snapColorLimit(1000) === 256 && snapColorLimit(-5) === 0
    && snapColorLimit(NaN) === 0 && snapColorLimit(128) === 128);
  const img = readImage(path.join(REAL, 'fakepixelart_fantasy_spritesheet.png'));
  const grid = normalizeGrid(estimateGrid(img));
  const removed = rectify(img, grid, ON);
  check('quantize: 0 is a no-op', quantizeColors(removed.image, 0) === removed.image);
  check('quantize: no more colours than the limit is a no-op', quantizeColors(removed.image, 100000) === removed.image);
  let lastErr = Infinity;
  let monotone = true;
  for (const n of COLOR_LIMITS.filter((v) => v > 0)) {
    const t0 = performance.now();
    const q = quantizeColors(removed.image, n);
    const ms = performance.now() - t0;
    const err = meanRgbError(removed.image, q);
    monotone = monotone && err <= lastErr + 0.5;
    lastErr = err;
    const alphaSame = q.data.every((v, i) => i % 4 !== 3 || v === removed.image.data[i]);
    const clearSame = q.data.every((v, i) => removed.image.data[i - (i % 4) + 3] !== 0 || v === removed.image.data[i]);
    check(`quantize ${n}: at most ${n} colours, transparency untouched, fast`, opaqueColours(q) <= n && alphaSame && clearSame && ms < 1500,
      `${opaqueColours(q)} colours, ${ms.toFixed(0)} ms, error ${err.toFixed(1)}`);
  }
  check('quantize: more colours, less error', monotone);
  const again = quantizeColors(removed.image, 16);
  check('quantize is deterministic', Buffer.from(again.data).equals(Buffer.from(quantizeColors(removed.image, 16).data)));
  const kept = rectify(img, grid, { ...ON, removeBackground: false });
  const bg = kept.background;
  const q8 = quantizeColors(kept.image, 8, bg);
  const hasBg = bg !== null && q8.data.some((v, i) => i % 4 === 0 && v === bg[0] && q8.data[i + 1] === bg[1] && q8.data[i + 2] === bg[2]);
  check('quantize keeps the kept background colour exact, within the limit', hasBg && opaqueColours(q8) <= 8, `${opaqueColours(q8)} colours`);
  const viaRectify = rectify(img, grid, { ...ON, maxColors: 16 });
  check('rectify applies maxColors', viaRectify.colorCount <= 16 && viaRectify.colorCount === opaqueColours(viaRectify.image));
  const keptVia = rectify(img, grid, { ...ON, removeBackground: false, maxColors: 8 });
  const kb = keptVia.background;
  const keepsBg = kb !== null && keptVia.image.data.some((v, i) => i % 4 === 0 && v === kb[0] && keptVia.image.data[i + 1] === kb[1]
    && keptVia.image.data[i + 2] === kb[2]);
  check('rectify keeps the kept background colour exact under maxColors', keepsBg && keptVia.colorCount <= 8, `${keptVia.colorCount} colours`);
  const one = quantizeColors(kept.image, 1, bg);
  check('quantize: a limit the kept colour fills maps everything onto it', opaqueColours(one) === 1);
  check('quantize: a fractional limit counts as its whole part', opaqueColours(quantizeColors(removed.image, 8.9)) <= 8);
}

function testReal(): void {
  const files = readdirSync(REAL).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  check('real samples present', Object.keys(REAL_SIZES).every((n) => files.includes(`${n}.png`)));
  for (const file of files) {
    const name = file.replace(/\.png$/i, '');
    const img = readImage(path.join(REAL, file));
    const t0 = performance.now();
    const est = estimateGrid(img);
    const tEst = performance.now() - t0;
    const res = rectify(img, normalizeGrid(est), { ...ON, snapToEdges: true });
    const tRect = performance.now() - t0 - tEst;
    const want = REAL_SIZES[name];
    if (want !== undefined)
      check(`real ${name}: size ${want}`, Math.abs(est.size / want - 1) < REAL_TOL, `got ${est.size.toFixed(3)}`);
    check(`real ${name}: output`, res.image.width > 0 && res.colorCount > 0);
    console.log(`  ${name}: ${est.size.toFixed(3)} px, ${res.image.width}x${res.image.height}, ${res.colorCount} colours, estimate ${tEst.toFixed(0)} ms, rectify ${tRect.toFixed(0)} ms`);
    if (name === 'fakepixelart_cyberpunk_spritesheet_test') {
      // Magenta-key fringe: opaque cells next to the removed background with a clear key tint (was 505 before keyFringe)
      const o = res.image;
      let fringe = 0;
      for (let y = 0; y < o.height; y++) {
        for (let x = 0; x < o.width; x++) {
          const i = (y * o.width + x) * 4;
          const nearClear = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
            const xx = x + dx;
            const yy = y + dy;
            return xx >= 0 && yy >= 0 && xx < o.width && yy < o.height && o.data[(yy * o.width + xx) * 4 + 3] === 0;
          });
          if (o.data[i + 3] === 255 && nearClear && Math.min(o.data[i], o.data[i + 2]) - o.data[i + 1] > 50)
            fringe++;
        }
      }
      check('real cyberpunk: magenta fringe cleaned', fringe < 80, `${fringe} tinted edge cells`);
    }
  }
}

function main(): void {
  const sprites = readdirSync(SPRITES).filter((f) => f.toLowerCase().endsWith('.png')).sort()
    .map((f) => ({ name: f.replace(/\.png$/i, ''), img: readImage(path.join(SPRITES, f)) }));
  console.log('grid model');
  testGridModel();
  console.log('synthetic pseudo pixel art');
  testSynthetic(sprites);
  console.log('options');
  testOptions(sprites);
  console.log('degenerate inputs');
  testDegenerate();
  console.log('colour quantizer');
  testQuantize();
  console.log('snap to pixel edges');
  testSnap(sprites);
  console.log('real samples');
  testReal();
  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0)
    process.exit(1);
}

main();
