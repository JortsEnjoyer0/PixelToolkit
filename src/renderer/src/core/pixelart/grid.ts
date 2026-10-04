// Pixel grid model for Img to PixelArt's Rectify To Grid (docs/img2pixel/img2pixel.md): a uniform square grid over the
// source image, with a fractional cell size and offsets. Framework-free; tested by scripts/test-pixelart.ts.

/** Lines at x = offsetX + k·size and y = offsetY + k·size, in source image px (fractional values allowed). */
export interface GridSpec { size: number; offsetX: number; offsetY: number }

/** estimateGrid() result: offsets wrapped into [0, size), not rounded (see normalizeGrid), and a confidence (0..1). */
export interface GridEstimate extends GridSpec { confidence: number }

export const MIN_GRID_SIZE = 2;
export const MAX_GRID_SIZE = 256;
/**
 * Decimals kept (and shown by the panel's fields). The size needs more: its error accumulates over every cell, e.g.
 * 0.0005 px over 230 cells of 5.36 px is 0.1 px at the far edge, while 0.005 px would be a fifth of a cell.
 */
export const SIZE_DECIMALS = 3;
export const OFFSET_DECIMALS = 2;

const roundTo = (v: number, decimals: number): number => Math.round(v * 10 ** decimals) / 10 ** decimals;

/** `offset` wrapped into [0, size) and rounded to OFFSET_DECIMALS. */
export function wrapOffset(offset: number, size: number): number {
  const o = roundTo(offset - Math.floor(offset / size) * size, OFFSET_DECIMALS);
  return o >= size ? 0 : o;
}

/** Size clamped to [MIN_GRID_SIZE, MAX_GRID_SIZE], everything rounded, offsets wrapped into [0, size). */
export function normalizeGrid(g: GridSpec): GridSpec {
  const raw = Number.isFinite(g.size) ? g.size : MIN_GRID_SIZE;
  const size = roundTo(Math.min(MAX_GRID_SIZE, Math.max(MIN_GRID_SIZE, raw)), SIZE_DECIMALS);
  const ox = Number.isFinite(g.offsetX) ? g.offsetX : 0;
  const oy = Number.isFinite(g.offsetY) ? g.offsetY : 0;
  return { size, offsetX: wrapOffset(ox, size), offsetY: wrapOffset(oy, size) };
}

/**
 * The cells along one axis of `length` px: every cell whose centre lies inside [0, length), so a partial edge cell
 * counts when at least half of it is inside. Cell k spans [offset + k·size, offset + (k + 1)·size); `first` is -1 when
 * the partial cell before the first line counts.
 */
export function gridCells(length: number, size: number, offset: number): { first: number; count: number } {
  const first = Math.ceil(-offset / size - 0.5);
  const last = Math.ceil((length - offset) / size - 0.5) - 1;
  return { first, count: Math.max(0, last - first + 1) };
}

/**
 * Output image size for a source of width × height px (one px per cell); squared to the larger side when asked, unless
 * an axis has no cell (nothing to rectify).
 */
export function outputSize(width: number, height: number, grid: GridSpec, makeSquare: boolean): { width: number; height: number } {
  const w = gridCells(width, grid.size, grid.offsetX).count;
  const h = gridCells(height, grid.size, grid.offsetY).count;
  if (!makeSquare || w === 0 || h === 0)
    return { width: w, height: h };
  const side = Math.max(w, h);
  return { width: side, height: side };
}
