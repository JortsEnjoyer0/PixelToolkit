// Rectify To Grid's stage view (docs/img2pixel/img2pixel.md "UI"): the source image in a 'smooth' CanvasView with the
// pixel grid drawn over it, and a left-button drag that moves the grid. Non-reactive; RectifyStage.vue feeds it the
// store's source and grid and turns its callbacks into store calls and HUD text.
// - Grid lines sit at offset + k·size (image px), over the image only. Each is a dark and a light 1-device-px line side
//   by side, so it reads on any colour; lines fade out as their on-screen spacing shrinks and hide below
//   GRID_HIDE_SPACING.
// - A drag moves the offsets by whole image px from where it started (a fractional part from the estimate is kept);
//   Escape restores the start offsets. The store wraps them into [0, size).
import { clamp } from '../../../core/util/math';
import { gridCells, type GridSpec } from '../../../core/pixelart/grid';
import { CanvasView, type ViewPoint } from '../view/CanvasView';

/** Two-tone grid lines (dark left / top, light right / bottom of each line position). */
export const GRID_DARK = 'rgba(4, 6, 10, 0.6)';
export const GRID_LIGHT = 'rgba(214, 226, 255, 0.6)';
/** On-screen line spacing, device px: hidden below the first, fully opaque from the second. */
const GRID_HIDE_SPACING = 3;
const GRID_SOLID_SPACING = 12;
/** Margin around the fitted image, CSS px. */
const FIT_MARGIN = 24;

/** The pointer over the image: image px and grid cell (index in the output before squaring; null on a dropped edge cell). */
export interface GridCursor { x: number; y: number; col: number | null; row: number | null }

export interface GridStageOptions {
  /** A drag moved the grid: the new offsets (start offsets + whole image px, not wrapped). */
  gridDrag: (offsetX: number, offsetY: number) => void;
  /** Image px and cell under the pointer; null when it is off the image. */
  cursor?: (c: GridCursor | null) => void;
  viewChange?: (view: CanvasView) => void;
}

interface GridDrag { ox: number; oy: number; x0: number; y0: number; dx: number; dy: number }

export class GridStageView {
  readonly view: CanvasView;
  private readonly opts: GridStageOptions;
  private bitmap: ImageBitmap | null = null;
  private grid: GridSpec = { size: 8, offsetX: 0, offsetY: 0 };
  private drag: GridDrag | null = null;
  private pointer: ViewPoint | null = null;

  constructor(opts: GridStageOptions) {
    this.opts = opts;
    this.view = new CanvasView({
      policy: 'smooth',
      home: 'fit',
      fitMargin: FIT_MARGIN,
      draw: (ctx) => this.drawGrid(ctx),
      viewChange: opts.viewChange,
      pointer: (p) => this.onPointer(p),
      hoverCursor: (p) => this.onImage(p) ? 'grab' : '',
      drag: {
        start: (p) => this.dragStart(p),
        move: (p) => this.dragMove(p),
        end: (cancelled) => this.dragEnd(cancelled)
      }
    });
  }

  mount(container: HTMLElement): void {
    this.view.mount(container);
  }

  dispose(): void {
    this.view.dispose();
    this.bitmap = null;
  }

  /** A new source image gets the fitted view; the same one is ignored. */
  setSource(bitmap: ImageBitmap | null): void {
    if (bitmap === this.bitmap)
      return;
    this.bitmap = bitmap;
    this.view.cancelGesture();
    this.view.setContent(bitmap, bitmap?.width ?? 0, bitmap?.height ?? 0);
  }

  setGrid(grid: Readonly<GridSpec>): void {
    const g = this.grid;
    if (g.size === grid.size && g.offsetX === grid.offsetX && g.offsetY === grid.offsetY)
      return;
    this.grid = { size: grid.size, offsetX: grid.offsetX, offsetY: grid.offsetY };
    this.view.invalidate();
    this.onPointer(this.pointer);
  }

  private onImage(p: ViewPoint): boolean {
    const v = this.view;
    return v.hasContent && p.x >= 0 && p.y >= 0 && p.x < v.contentWidth && p.y < v.contentHeight;
  }

  // ---------- cursor read-out ----------

  private onPointer(p: ViewPoint | null): void {
    this.pointer = p;
    const report = this.opts.cursor;
    if (!report)
      return;
    if (!p || !this.onImage(p)) {
      report(null);
      return;
    }
    const { size, offsetX, offsetY } = this.grid;
    const cell = (v: number, length: number, offset: number): number | null => {
      const cells = gridCells(length, size, offset);
      const i = Math.floor((v - offset) / size) - cells.first;
      return i >= 0 && i < cells.count ? i : null;
    };
    report({
      x: Math.floor(p.x),
      y: Math.floor(p.y),
      col: cell(p.x, this.view.contentWidth, offsetX),
      row: cell(p.y, this.view.contentHeight, offsetY)
    });
  }

  // ---------- grid drag ----------

  private dragStart(p: ViewPoint): boolean {
    if (!this.onImage(p))
      return false;
    this.drag = { ox: this.grid.offsetX, oy: this.grid.offsetY, x0: p.x, y0: p.y, dx: 0, dy: 0 };
    return true;
  }

  private dragMove(p: ViewPoint): void {
    const d = this.drag;
    if (!d)
      return;
    const dx = Math.round(p.x - d.x0);
    const dy = Math.round(p.y - d.y0);
    if (dx === d.dx && dy === d.dy)
      return;
    d.dx = dx;
    d.dy = dy;
    this.opts.gridDrag(d.ox + dx, d.oy + dy);
  }

  private dragEnd(cancelled: boolean): void {
    const d = this.drag;
    this.drag = null;
    if (cancelled && d && (d.dx !== 0 || d.dy !== 0))
      this.opts.gridDrag(d.ox, d.oy);
  }

  // ---------- drawing ----------

  /** Grid lines over the visible part of the image, device px. */
  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const v = this.view;
    if (!v.hasContent)
      return;
    const { size, offsetX, offsetY } = this.grid;
    const z = v.zoom;
    const alpha = clamp((size * z - GRID_HIDE_SPACING) / (GRID_SOLID_SPACING - GRID_HIDE_SPACING), 0, 1);
    if (alpha <= 0)
      return;
    const left = Math.max(0, Math.round(v.panX));
    const top = Math.max(0, Math.round(v.panY));
    const right = Math.min(v.width, Math.round(v.panX + v.contentWidth * z));
    const bottom = Math.min(v.height, Math.round(v.panY + v.contentHeight * z));
    if (right <= left || bottom <= top)
      return;
    const dark = new Path2D();
    const light = new Path2D();
    // Visible image range per axis → the lines inside it
    const lines = (offset: number, from: number, to: number, pan: number, add: (s: number) => void): void => {
      const i0 = (from - pan) / z;
      const i1 = (to - pan) / z;
      for (let k = Math.ceil((i0 - offset) / size); offset + k * size <= i1; k++)
        add(Math.round(pan + (offset + k * size) * z));
    };
    lines(offsetX, left, right, v.panX, (sx) => {
      dark.rect(sx - 1, top, 1, bottom - top);
      light.rect(sx, top, 1, bottom - top);
    });
    lines(offsetY, top, bottom, v.panY, (sy) => {
      dark.rect(left, sy - 1, right - left, 1);
      light.rect(left, sy, right - left, 1);
    });
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = GRID_DARK;
    ctx.fill(dark);
    ctx.fillStyle = GRID_LIGHT;
    ctx.fill(light);
    ctx.restore();
  }
}
