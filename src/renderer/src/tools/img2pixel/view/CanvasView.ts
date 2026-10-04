// Pan / zoom viewer of one image on a plain 2D canvas (Img to PixelArt: the Rectify stage, the output preview; meant
// for later sub-tools too). Non-reactive and framework-free like editor/: a component owns one instance, feeds it and
// gets told about changes through the option callbacks.
// - The canvas fills its container and its backing store follows the container's size in DEVICE px (ResizeObserver
//   'device-pixel-content-box', re-observed when devicePixelRatio changes), so 1 canvas px = 1 screen px.
// - View transform in device px: screen = pan + image · zoom. Zoom policies: 'smooth' (continuous wheel zoom) and
//   'pow2' (1, 2, 4 … device px per image px, pans in whole device px: an image pixel is never cut).
// - MMB pans (pointer capture), the wheel zooms around the cursor (off the image: around its nearest point), a
//   left-button gesture goes to the `drag` hook and Escape cancels it. Pans keep part of the image on screen. Resizing
//   keeps the default view while it is shown, otherwise the view centre.
// - Drawing is on demand: invalidate() schedules one rAF, never a free-running loop. Order: background, checkerboard
//   under the image, the image (smoothed only below zoom 1), the `draw` hook (overlays, device px, identity transform).
import type { RgbaImage } from '@shared/image';
import { clamp } from '../../../core/util/math';

/** Viewport background (theme --bg-0). */
export const VIEW_BG = '#0a0c10';
/** Checkerboard under the image, so transparent pixels show (theme --checker-a/-b family). */
export const VIEW_CHECKER_A = '#1b1f27';
export const VIEW_CHECKER_B = '#262b35';
/** Checker cell, CSS px. */
const CHECKER_CSS_PX = 8;

/** Smooth policy: zoom factor per wheel notch, and the deltaY of one notch (px). */
const SMOOTH_STEP = 1.2;
const WHEEL_NOTCH = 100;
/** Pow2 policy: accumulated deltaY that makes one step (one mouse notch; touchpads need a short swipe). */
const POW2_WHEEL_THRESHOLD = 40;
const WHEEL_IDLE_MS = 250;
/** deltaMode LINE / PAGE in px. */
const WHEEL_LINE_PX = 33;
const WHEEL_PAGE_PX = 800;
/** Pans keep at least this much of the image on screen, CSS px. */
const KEEP_VISIBLE_CSS = 32;

const ZOOM_LIMITS: Record<ZoomPolicy, { min: number; max: number }> = {
  smooth: { min: 1 / 64, max: 64 },
  pow2: { min: 1, max: 64 }
};

export type ZoomPolicy = 'smooth' | 'pow2';

/** A point in image px (fractional), or in device px for toDevice(). */
export interface ViewPoint { x: number; y: number }

/** A left-button gesture (e.g. moving a grid). The view captures the pointer between start and end. */
export interface DragHandler {
  /** Pressed at image point `p`: true takes the gesture. */
  start(p: ViewPoint, e: PointerEvent): boolean;
  move(p: ViewPoint, e: PointerEvent): void;
  /** Released (cancelled: Escape, pointercancel, dispose). */
  end(cancelled: boolean): void;
}

export interface CanvasViewOptions {
  policy: ZoomPolicy;
  /** Default view (reset): fit the image ('fit', the 'smooth' default) or 1 image px = 1 device px ('actual'); centred. */
  home?: 'fit' | 'actual';
  /** Zoom limits in device px per image px (defaults per policy: smooth 1/64..64, pow2 1..64). */
  minZoom?: number;
  maxZoom?: number;
  /** Margin around a fitted image, CSS px. */
  fitMargin?: number;
  /** Overlays, drawn after the image in device px with the identity transform (use view.zoom / panX / panY). */
  draw?: (ctx: CanvasRenderingContext2D, view: CanvasView) => void;
  /** Zoom, pan, canvas size or content changed; called once per drawn frame (HUD text, reset button). */
  viewChange?: (view: CanvasView) => void;
  /** Image point under the pointer (also outside the image, and while a gesture captures it); null when it leaves. */
  pointer?: (p: ViewPoint | null) => void;
  /** CSS cursor while hovering image point `p` without a gesture ('' = default). */
  hoverCursor?: (p: ViewPoint) => string;
  drag?: DragHandler;
}

interface Gesture {
  kind: 'pan' | 'drag';
  pointerId: number;
  /** Pan: the image point held under the pointer. */
  grab: ViewPoint;
}

interface ViewState { zoom: number; panX: number; panY: number }

/** Live views, disposed when this module is hot-replaced in dev. */
const live = new Set<CanvasView>();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const v of [...live])
      v.dispose();
  });
}

/** A canvas holding `img` (straight RGBA), usable as CanvasView content. */
export function imageCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (ctx && img.width > 0 && img.height > 0)
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data.subarray(0, img.width * img.height * 4)), img.width, img.height), 0, 0);
  return c;
}

export class CanvasView {
  readonly policy: ZoomPolicy;
  private readonly opts: CanvasViewOptions;
  private readonly minZoom: number;
  private readonly maxZoom: number;
  private readonly homeKind: 'fit' | 'actual';

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private ro: ResizeObserver | null = null;
  private cleanups: (() => void)[] = [];
  private offDprWatch: (() => void) | null = null;

  private image: CanvasImageSource | null = null;
  /** Content size, image px. */
  private cw = 0;
  private ch = 0;
  /** Backing store size, device px, and device px per CSS px. */
  private pw = 0;
  private ph = 0;
  private dpr = 1;
  private z = 1;
  private px = 0;
  private py = 0;
  /** setContent() ran before the size was known: apply the default view on the first resize. */
  private pendingHome = true;

  private gesture: Gesture | null = null;
  /** Last pointer position over (or captured by) the canvas, device px. */
  private pointerAt: ViewPoint | null = null;
  private cursor = '';
  private wheelAcc = 0;
  private wheelAt = 0;

  private checker: CanvasPattern | null = null;
  private checkerCell = 0;
  private raf = 0;
  private viewDirty = true;
  private disposed = false;

  constructor(opts: CanvasViewOptions) {
    this.opts = opts;
    this.policy = opts.policy;
    this.homeKind = opts.home ?? (opts.policy === 'pow2' ? 'actual' : 'fit');
    const limits = ZOOM_LIMITS[opts.policy];
    this.minZoom = opts.minZoom ?? limits.min;
    this.maxZoom = Math.max(this.minZoom, opts.maxZoom ?? limits.max);
  }

  // ---------- lifecycle ----------

  /** Create the canvas inside `container` (call once). The container needs a size; the canvas fills it. */
  mount(container: HTMLElement): void {
    if (this.canvas || this.disposed)
      throw new Error('CanvasView.mount() may be called once');
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx)
      throw new Error('Could not create a 2D canvas');
    this.canvas = canvas;
    this.ctx = ctx;
    container.appendChild(canvas);

    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e as PointerEvent, false));
    this.listen(canvas, 'pointercancel', (e) => this.onPointerUp(e as PointerEvent, true));
    this.listen(canvas, 'lostpointercapture', () => this.endGesture(false));
    this.listen(canvas, 'pointerleave', () => this.onPointerLeave());
    this.listen(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    // MMB: no autoscroll, no middle-click paste / open
    const noMiddle = (e: Event): void => {
      if ((e as MouseEvent).button === 1)
        e.preventDefault();
    };
    this.listen(canvas, 'mousedown', noMiddle);
    this.listen(canvas, 'auxclick', noMiddle);

    this.ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry)
        this.onResize(entry);
    });
    this.observeSize();
    this.watchPixelRatio();
    live.add(this);
  }

  dispose(): void {
    if (this.disposed)
      return;
    this.endGesture(true);
    this.disposed = true;
    live.delete(this);
    if (this.raf)
      cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const off of this.cleanups.splice(0))
      off();
    this.offDprWatch?.();
    this.offDprWatch = null;
    this.ro?.disconnect();
    this.ro = null;
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.image = null;
    this.checker = null;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  private observeSize(): void {
    const c = this.canvas;
    if (!c || !this.ro)
      return;
    this.ro.unobserve(c);
    this.ro.observe(c, { box: 'device-pixel-content-box' });
  }

  /**
   * A devicePixelRatio change (other monitor, OS scaling) changes the device size: re-observe, which reports the
   * current size at once (the device-pixel box usually reports it by itself too).
   */
  private watchPixelRatio(): void {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = (): void => {
      this.offDprWatch?.();
      this.offDprWatch = null;
      if (this.disposed)
        return;
      this.observeSize();
      this.watchPixelRatio();
    };
    mq.addEventListener('change', onChange);
    this.offDprWatch = () => mq.removeEventListener('change', onChange);
  }

  private onResize(entry: ResizeObserverEntry): void {
    const c = this.canvas;
    const cssW = entry.contentRect.width;
    const cssH = entry.contentRect.height;
    if (!c || cssW < 1 || cssH < 1)
      return; // detached (kept-alive tool hidden) or collapsed: keep the last size
    const box = entry.devicePixelContentBoxSize?.[0];
    const ratio = window.devicePixelRatio || 1;
    const pw = box ? box.inlineSize : Math.round(cssW * ratio);
    const ph = box ? box.blockSize : Math.round(cssH * ratio);
    if (pw < 1 || ph < 1)
      return;
    const wasHome = this.pw > 0 && this.isHomeView();
    const dw = pw - this.pw;
    const dh = ph - this.ph;
    const first = this.pw === 0;
    this.dpr = pw / cssW;
    if (pw === c.width && ph === c.height && !first)
      return;
    this.pw = pw;
    this.ph = ph;
    c.width = pw;
    c.height = ph;
    if (first || wasHome || this.pendingHome)
      this.applyHome();
    else {
      this.px += this.snap(dw / 2);
      this.py += this.snap(dh / 2);
      this.clampPan();
    }
    this.viewDirty = true;
    this.drawNow(); // synchronously: resizing cleared the canvas
  }

  // ---------- content and view ----------

  /**
   * Show `image` (width × height image px; null = nothing). A new content gets the default view unless `keepView` and
   * the size is unchanged.
   */
  setContent(image: CanvasImageSource | null, width: number, height: number, keepView = false): void {
    const sameSize = width === this.cw && height === this.ch;
    this.image = image;
    this.cw = image ? Math.max(0, width) : 0;
    this.ch = image ? Math.max(0, height) : 0;
    if (!(keepView && sameSize)) {
      if (this.pw > 0)
        this.applyHome();
      else
        this.pendingHome = true;
    }
    this.viewChanged();
    this.refreshPointer();
  }

  get hasContent(): boolean {
    return this.image !== null && this.cw > 0 && this.ch > 0;
  }

  /** Device px per image px. */
  get zoom(): number {
    return this.z;
  }

  /** Screen position of the image's top-left corner, device px. */
  get panX(): number {
    return this.px;
  }

  get panY(): number {
    return this.py;
  }

  /** Canvas size, device px. */
  get width(): number {
    return this.pw;
  }

  get height(): number {
    return this.ph;
  }

  /** Device px per CSS px, as measured. */
  get pixelRatio(): number {
    return this.dpr;
  }

  get contentWidth(): number {
    return this.cw;
  }

  get contentHeight(): number {
    return this.ch;
  }

  /** A pan or drag gesture is running. */
  get interacting(): boolean {
    return this.gesture !== null;
  }

  /** Image px → device px. */
  toDevice(x: number, y: number): ViewPoint {
    return { x: this.px + x * this.z, y: this.py + y * this.z };
  }

  /** Device px → image px. */
  toImage(x: number, y: number): ViewPoint {
    return { x: (x - this.px) / this.z, y: (y - this.py) / this.z };
  }

  /** Back to the default view ('fit' or 'actual', centred). */
  resetView(): void {
    this.applyHome();
    this.viewChanged();
    this.refreshPointer();
  }

  /** Fit the image into the view (pow2: the largest fitting power of two), centred. */
  fitView(): void {
    if (!this.hasContent || this.pw === 0)
      return;
    const zoom = this.fitZoom();
    this.setView({ zoom, ...this.centredPan(zoom) });
    this.viewChanged();
    this.refreshPointer();
  }

  /** The view shows the default view (true without content or size). */
  isHomeView(): boolean {
    if (!this.hasContent || this.pw === 0)
      return true;
    const h = this.homeView();
    return Math.abs(this.z - h.zoom) < 1e-9 && Math.abs(this.px - h.panX) < 0.5 && Math.abs(this.py - h.panY) < 0.5;
  }

  /**
   * Zoom (clamped, snapped by the policy) keeping the image point at device point `anchor` (default: the canvas
   * centre; off the image, the nearest image point) in place.
   */
  setZoom(zoom: number, anchor?: ViewPoint): void {
    this.zoomAround(zoom, anchor?.x ?? this.pw / 2, anchor?.y ?? this.ph / 2);
  }

  /** Cancel a running gesture (a drag reports end(true)). */
  cancelGesture(): void {
    this.endGesture(true);
  }

  /** Report the pointer and update the cursor again (after the owner changed what the pointer is over). */
  refreshPointer(): void {
    const p = this.pointerAt;
    this.opts.pointer?.(p ? this.toImage(p.x, p.y) : null);
    this.updateCursor();
  }

  /** Schedule one redraw (no-op when one is pending). */
  invalidate(): void {
    if (this.raf || this.disposed || !this.canvas)
      return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.drawNow();
    });
  }

  private viewChanged(): void {
    this.viewDirty = true;
    this.invalidate();
  }

  private snap(v: number): number {
    return this.policy === 'pow2' ? Math.round(v) : v;
  }

  private clampZoom(z: number): number {
    const c = clamp(z, this.minZoom, this.maxZoom);
    return this.policy === 'pow2' ? 2 ** Math.round(Math.log2(c)) : c;
  }

  /** Largest zoom showing the whole image inside the margin; whole numbers from 1 up (smooth), a power of two (pow2). */
  private fitZoom(): number {
    const m = (this.opts.fitMargin ?? 0) * this.dpr;
    const aw = Math.max(1, this.pw - 2 * m > 0 ? this.pw - 2 * m : this.pw);
    const ah = Math.max(1, this.ph - 2 * m > 0 ? this.ph - 2 * m : this.ph);
    const z = Math.min(aw / this.cw, ah / this.ch);
    if (this.policy === 'pow2')
      return this.clampZoom(2 ** Math.floor(Math.log2(z)));
    return this.clampZoom(z >= 1 ? Math.floor(z) : z);
  }

  /** Pan that centres the image at `zoom`, on whole device px. */
  private centredPan(zoom: number): { panX: number; panY: number } {
    return { panX: Math.round((this.pw - this.cw * zoom) / 2), panY: Math.round((this.ph - this.ch * zoom) / 2) };
  }

  private homeView(): ViewState {
    const zoom = this.homeKind === 'fit' ? this.fitZoom() : this.clampZoom(1);
    return { zoom, ...this.centredPan(zoom) };
  }

  private applyHome(): void {
    this.pendingHome = false;
    if (!this.hasContent || this.pw === 0) {
      this.setView({ zoom: this.clampZoom(1), panX: 0, panY: 0 });
      return;
    }
    this.setView(this.homeView());
  }

  private setView(v: ViewState): void {
    this.z = v.zoom;
    this.px = this.snap(v.panX);
    this.py = this.snap(v.panY);
    this.clampPan();
  }

  /** Keep at least KEEP_VISIBLE_CSS of the image (all of a smaller one) on screen. */
  private clampPan(): void {
    if (!this.hasContent)
      return;
    const keep = Math.round(KEEP_VISIBLE_CSS * this.dpr);
    const w = this.cw * this.z;
    const h = this.ch * this.z;
    const kx = Math.min(keep, w);
    const ky = Math.min(keep, h);
    this.px = this.snap(clamp(this.px, kx - w, this.pw - kx));
    this.py = this.snap(clamp(this.py, ky - h, this.ph - ky));
  }

  private zoomAround(zoom: number, ax: number, ay: number): void {
    const nz = this.clampZoom(zoom);
    if (!this.hasContent || nz === this.z)
      return;
    // Off the image, hold its nearest point instead, so the image never flies away from the cursor
    const p = this.toImage(ax, ay);
    const gx = clamp(p.x, 0, this.cw);
    const gy = clamp(p.y, 0, this.ch);
    const anchor = this.toDevice(gx, gy);
    this.z = nz;
    this.px = this.snap(anchor.x - gx * nz);
    this.py = this.snap(anchor.y - gy * nz);
    this.clampPan();
    this.viewChanged();
    this.refreshPointer();
  }

  // ---------- input ----------

  /** Client px of a mouse event → canvas device px. */
  private devicePoint(e: MouseEvent): ViewPoint {
    const r = this.canvas!.getBoundingClientRect();
    const sx = r.width > 0 ? this.pw / r.width : this.dpr;
    const sy = r.height > 0 ? this.ph / r.height : this.dpr;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.gesture || !this.hasContent)
      return;
    const d = this.devicePoint(e);
    this.pointerAt = d;
    if (e.button === 1)
      this.beginGesture({ kind: 'pan', pointerId: e.pointerId, grab: this.toImage(d.x, d.y) });
    else if (e.button === 0 && this.opts.drag?.start(this.toImage(d.x, d.y), e))
      this.beginGesture({ kind: 'drag', pointerId: e.pointerId, grab: this.toImage(d.x, d.y) });
  }

  private beginGesture(g: Gesture): void {
    this.gesture = g;
    this.canvas!.setPointerCapture(g.pointerId);
    window.addEventListener('keydown', this.onGestureKey, true);
    this.updateCursor();
  }

  /** Escape cancels the gesture (capture phase: before an enclosing dialog closes on it). */
  private onGestureKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape')
      return;
    e.preventDefault();
    e.stopPropagation();
    this.endGesture(true);
  };

  private endGesture(cancelled: boolean): void {
    const g = this.gesture;
    if (!g)
      return;
    this.gesture = null; // first: releasing the capture fires lostpointercapture
    window.removeEventListener('keydown', this.onGestureKey, true);
    const c = this.canvas;
    if (c?.hasPointerCapture(g.pointerId))
      c.releasePointerCapture(g.pointerId);
    if (g.kind === 'drag')
      this.opts.drag?.end(cancelled);
    this.updateCursor();
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.devicePoint(e);
    this.pointerAt = d;
    const g = this.gesture;
    if (g && e.pointerId === g.pointerId) {
      if (g.kind === 'pan') {
        this.px = this.snap(d.x - g.grab.x * this.z);
        this.py = this.snap(d.y - g.grab.y * this.z);
        this.clampPan();
        this.viewChanged();
      } else
        this.opts.drag?.move(this.toImage(d.x, d.y), e);
    }
    this.refreshPointer();
  }

  private onPointerUp(e: PointerEvent, cancelled: boolean): void {
    if (this.gesture && e.pointerId === this.gesture.pointerId)
      this.endGesture(cancelled);
  }

  private onPointerLeave(): void {
    if (this.gesture)
      return;
    this.pointerAt = null;
    this.refreshPointer();
  }

  private updateCursor(): void {
    const c = this.canvas;
    if (!c)
      return;
    const p = this.pointerAt;
    let cursor = '';
    if (this.gesture)
      cursor = 'grabbing';
    else if (p && this.hasContent && this.opts.hoverCursor)
      cursor = this.opts.hoverCursor(this.toImage(p.x, p.y));
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      c.style.cursor = cursor;
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (!this.hasContent || this.pw === 0)
      return;
    const scale = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? WHEEL_PAGE_PX : 1;
    const dy = e.deltaY * scale;
    if (dy === 0)
      return;
    const d = this.devicePoint(e);
    if (this.policy === 'smooth') {
      this.zoomAround(this.z * SMOOTH_STEP ** -clamp(dy / WHEEL_NOTCH, -3, 3), d.x, d.y);
      return;
    }
    // pow2: one step per notch; small (touchpad) deltas accumulate
    const now = performance.now();
    if (now - this.wheelAt > WHEEL_IDLE_MS || Math.sign(dy) !== Math.sign(this.wheelAcc))
      this.wheelAcc = 0;
    this.wheelAt = now;
    this.wheelAcc += dy;
    if (Math.abs(this.wheelAcc) < POW2_WHEEL_THRESHOLD)
      return;
    const step = this.wheelAcc < 0 ? 1 : -1;
    this.wheelAcc = 0;
    this.zoomAround(this.z * 2 ** step, d.x, d.y);
  }

  // ---------- drawing ----------

  private drawNow(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed || this.pw === 0)
      return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = VIEW_BG;
    ctx.fillRect(0, 0, this.pw, this.ph);
    if (this.hasContent)
      this.drawContent(ctx);
    this.opts.draw?.(ctx, this);
    if (this.viewDirty) {
      this.viewDirty = false;
      this.opts.viewChange?.(this);
    }
  }

  /** Checkerboard under the visible part of the image, then that part of the image. */
  private drawContent(ctx: CanvasRenderingContext2D): void {
    const z = this.z;
    const x0 = this.px;
    const y0 = this.py;
    const left = Math.max(0, Math.round(x0));
    const top = Math.max(0, Math.round(y0));
    const right = Math.min(this.pw, Math.round(x0 + this.cw * z));
    const bottom = Math.min(this.ph, Math.round(y0 + this.ch * z));
    if (right <= left || bottom <= top)
      return;
    const pattern = this.checkerPattern(ctx);
    pattern?.setTransform(new DOMMatrix([1, 0, 0, 1, Math.round(x0), Math.round(y0)]));
    ctx.fillStyle = pattern ?? VIEW_CHECKER_A;
    ctx.fillRect(left, top, right - left, bottom - top);

    const img = this.image;
    if (!img || (img instanceof ImageBitmap && img.width === 0))
      return; // a closed bitmap (its source was replaced): the owner sets the new one next
    const sx0 = Math.max(0, Math.floor(-x0 / z));
    const sy0 = Math.max(0, Math.floor(-y0 / z));
    const sx1 = Math.min(this.cw, Math.ceil((this.pw - x0) / z));
    const sy1 = Math.min(this.ch, Math.ceil((this.ph - y0) / z));
    if (sx1 <= sx0 || sy1 <= sy0)
      return;
    ctx.imageSmoothingEnabled = z < 1;
    if (z < 1)
      ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, x0 + sx0 * z, y0 + sy0 * z, (sx1 - sx0) * z, (sy1 - sy0) * z);
  }

  private checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    const cell = Math.max(1, Math.round(CHECKER_CSS_PX * this.dpr));
    if (this.checker && this.checkerCell === cell)
      return this.checker;
    const tile = document.createElement('canvas');
    tile.width = cell * 2;
    tile.height = cell * 2;
    const t = tile.getContext('2d');
    if (!t)
      return null;
    t.fillStyle = VIEW_CHECKER_A;
    t.fillRect(0, 0, cell * 2, cell * 2);
    t.fillStyle = VIEW_CHECKER_B;
    t.fillRect(cell, 0, cell, cell);
    t.fillRect(0, cell, cell, cell);
    this.checker = ctx.createPattern(tile, 'repeat');
    this.checkerCell = cell;
    return this.checker;
  }
}
