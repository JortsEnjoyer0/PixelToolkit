// ptk-asset://data/<rel> URL parsing for the asset protocol (electron-free, tested by scripts/test-main-fs.ts).
import { parseImageFileName } from '../../shared/dataPaths';

const ASSET_HOST = 'data';

/**
 * The data-root-relative path of an asset URL, decoded per segment; null when the host is not "data" or a segment is
 * empty, "." / "..", not valid percent-encoding, or decodes to something containing a path separator or NUL.
 */
export function assetRelFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host.toLowerCase() !== ASSET_HOST)
    return null;
  const raw = parsed.pathname.replace(/^\//, '').split('/');
  const segs: string[] = [];
  for (const seg of raw) {
    let s: string;
    try {
      s = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (s === '' || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0'))
      return null;
    segs.push(s);
  }
  return segs.length > 0 ? segs.join('/') : null;
}

/** Image files are immutable (new pixels get a new uid), so their URLs may be cached forever. */
export const isImmutableAsset = (rel: string): boolean => parseImageFileName(rel.slice(rel.lastIndexOf('/') + 1)) !== null;
