// Shared HTMLImageElement cache for 2D drawing (frame thumbnails), keyed by image uid. Image files are immutable
// (new pixels get a new uid), so a decoded image stays valid even after its animation is renamed and its URL changes.
// LRU-bounded; entries still loading are never evicted. A failed load is remembered for a few seconds (so a redraw
// loop does not hammer a missing file), then the next request retries.

export type ImageListener = () => void;

interface Entry {
  img: HTMLImageElement;
  state: 'loading' | 'loaded' | 'failed';
  /** performance.now() of the failure. */
  failedAt: number;
  /** Waiting callers; null once settled. */
  listeners: Set<ImageListener> | null;
}

const MAX_ENTRIES = 600;
const RETRY_MS = 5000;
const cache = new Map<string, Entry>();

function evict(): void {
  for (const [key, e] of cache) {
    if (cache.size <= MAX_ENTRIES)
      return;
    if (e.state !== 'loading')
      cache.delete(key);
  }
}

function load(uid: string, url: string, onLoad?: ImageListener): void {
  const img = new Image();
  img.decoding = 'async';
  img.crossOrigin = 'anonymous'; // ptk-asset sends CORS headers: canvases drawn with it stay readable (toDataURL, export)
  const entry: Entry = { img, state: 'loading', failedAt: 0, listeners: new Set(onLoad ? [onLoad] : []) };
  cache.set(uid, entry);
  img.onload = () => {
    entry.state = 'loaded';
    const waiting = entry.listeners;
    entry.listeners = null;
    waiting?.forEach((fn) => fn());
  };
  img.onerror = () => {
    entry.state = 'failed';
    entry.failedAt = performance.now();
    entry.listeners = null;
  };
  img.src = url;
  evict();
}

/**
 * The decoded image for `uid`, or null while it loads (or after it failed). `onLoad` runs once when a pending load
 * succeeds; remove it with offImage() when the caller goes away first. `url` is only used to start a load.
 */
export function getImage(uid: string, url: string, onLoad?: ImageListener): HTMLImageElement | null {
  const hit = cache.get(uid);
  if (!hit || (hit.state === 'failed' && performance.now() - hit.failedAt > RETRY_MS)) {
    load(uid, url, onLoad);
    return null;
  }
  cache.delete(uid);
  cache.set(uid, hit);
  if (hit.state === 'loaded')
    return hit.img;
  if (onLoad)
    hit.listeners?.add(onLoad);
  return null;
}

/** Stop waiting for `uid` (component unmounted before the image arrived). */
export function offImage(uid: string, onLoad: ImageListener): void {
  cache.get(uid)?.listeners?.delete(onLoad);
}
