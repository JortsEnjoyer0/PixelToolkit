// Editor textures: pixel-exact image textures (per-doc cache, preloaded) and small generated glyph textures.
import * as THREE from 'three';

/**
 * Image URL → texture for pixel art: NearestFilter, no mipmaps, sRGB, straight alpha (createImageBitmap from the fetched
 * blob with premultiplyAlpha 'none'). ImageBitmaps ignore UNPACK_FLIP_Y, so the bitmap is flipped while decoding instead.
 */
export async function loadPixelTexture(url: string): Promise<THREE.Texture> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Image request failed (${res.status}): ${url}`);
  const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'flipY' });
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false;
  tex.premultiplyAlpha = false;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function disposePixelTexture(tex: THREE.Texture): void {
  const img = tex.image as ImageBitmap | null;
  tex.dispose();
  if (img && typeof img.close === 'function')
    img.close();
}

interface CacheEntry { tex: THREE.Texture | null; failed: boolean }

/** retain(): unreferenced textures kept per referenced image, most recently referenced first (undo / redo of a Generate). */
const SPARE_PER_REFERENCED = 2;

/**
 * One doc's image textures keyed by image uid (images are immutable, so a uid's texture never goes stale). Map order
 * is last referenced (oldest first): retain() trims the images the doc no longer uses, evicted uids reload on demand.
 */
export class DocTextureCache {
  private entries = new Map<string, CacheEntry>();
  private disposed = false;

  /** `onLoad(uid)` fires when a texture finished loading (the viewport re-assigns the plane map and re-renders). */
  constructor(private resolveUrl: (uid: string) => string, private onLoad: (uid: string) => void) {}

  /** The loaded texture, or null while loading / failed (starts the load on first request). */
  get(uid: string): THREE.Texture | null {
    const e = this.entries.get(uid);
    if (e)
      return e.tex;
    this.load(uid);
    return null;
  }

  /** Start loading every uid not cached yet (all frame images of the active doc, so playback swaps maps without flicker). */
  preload(uids: Iterable<string>): void {
    for (const uid of uids) {
      if (!this.entries.has(uid))
        this.load(uid);
    }
  }

  /**
   * Keep the textures of `uids` (every image the doc's state references) and up to twice as many of the most recently
   * referenced others; dispose the rest (bitmap and GPU copy). Call before re-assigning the plane map.
   */
  retain(uids: readonly string[]): void {
    const keep = new Set(uids);
    for (const uid of keep) {
      const e = this.entries.get(uid);
      if (e) {
        this.entries.delete(uid);
        this.entries.set(uid, e);
      }
    }
    const spare = [...this.entries.keys()].filter((uid) => !keep.has(uid));
    for (const uid of spare.slice(0, Math.max(0, spare.length - SPARE_PER_REFERENCED * keep.size)))
      this.evict(uid);
  }

  /** The doc is no longer shown: free the GPU copies only; three re-uploads a texture from its ImageBitmap on next use. */
  releaseGpu(): void {
    for (const e of this.entries.values()) {
      if (e.tex)
        e.tex.dispose();
    }
  }

  /** Re-upload everything after a WebGL context restore (the ImageBitmaps are still in memory). */
  markAllDirty(): void {
    for (const e of this.entries.values()) {
      if (e.tex)
        e.tex.needsUpdate = true;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.entries.values()) {
      if (e.tex)
        disposePixelTexture(e.tex);
    }
    this.entries.clear();
  }

  /** Drop one entry; a load still in flight disposes its texture when it lands (the entry is no longer current). */
  private evict(uid: string): void {
    const e = this.entries.get(uid);
    this.entries.delete(uid);
    if (e?.tex)
      disposePixelTexture(e.tex);
  }

  private load(uid: string): void {
    const entry: CacheEntry = { tex: null, failed: false };
    this.entries.set(uid, entry);
    loadPixelTexture(this.resolveUrl(uid)).then((tex) => {
      if (this.disposed || this.entries.get(uid) !== entry) {
        disposePixelTexture(tex);
        return;
      }
      entry.tex = tex;
      this.onLoad(uid);
    }, (err: unknown) => {
      entry.failed = true;
      console.warn(`[editor] could not load image ${uid}:`, err);
    });
  }
}

/** lucide 'anchor' (24×24 viewBox, ISC licence): stroke paths plus the ring at the top. */
const ANCHOR_PATHS = ['M12 6v16', 'm19 13 2-1a9 9 0 0 1-18 0l2 1', 'M9 11h6'];

/** White anchor glyph with a dark halo, for the Hips sprite (tint it with SpriteMaterial.color). */
export function createAnchorTexture(size = 64): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const s = size / 24;
  ctx.setTransform(s * 0.84, 0, 0, s * 0.84, size * 0.08, size * 0.08);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const draw = (width: number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const d of ANCHOR_PATHS)
      ctx.stroke(new Path2D(d));
    ctx.beginPath();
    ctx.arc(12, 4, 2, 0, Math.PI * 2);
    ctx.stroke();
  };
  draw(5, 'rgba(6, 8, 12, 0.85)');
  draw(2.2, '#ffffff');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft-edged white disc with a thin dark rim, for screen-space point sprites (COCO joints). */
export function createDiscTexture(size = 64): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  ctx.beginPath();
  ctx.arc(r, r, r - 1, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(8, 10, 14, 0.9)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(r, r, r * 0.78, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** White ring (hover / active handle marker). */
export function createRingTexture(size = 64): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const r = size / 2;
  ctx.lineWidth = size * 0.1;
  ctx.strokeStyle = 'rgba(8, 10, 14, 0.9)';
  ctx.beginPath();
  ctx.arc(r, r, r - ctx.lineWidth, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = size * 0.06;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
