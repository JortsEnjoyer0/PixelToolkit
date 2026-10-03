// Defensive decoder for animate-with-skeleton-v3 results (docs/pixellab.md "Background jobs", U2):
// last_response.images may hold bare base64 strings or objects ({type: 'base64' | 'rgba_bytes', base64, width?,
// height?}), with or without a data: prefix, carrying PNG bytes or raw RGBA. Every frame comes out as PNG bytes.
import { isObj, posInt } from '../../shared/json';
import { decodePng, encodePng, isPng } from '../png';

/** Fewer images than expected (or none yet): the top-level status can briefly lead the result, so re-poll. */
export class IncompleteResultError extends Error {}

const DATA_URI_PREFIX = /^data:[^,]*;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;

function decodeOne(im: unknown, i: number, size: { width: number; height: number }): Uint8Array {
  const obj = isObj(im) ? im : null;
  if (obj && typeof obj.base64 !== 'string' && isObj(obj.image)) // nested { image: { base64 } }
    return decodeOne(obj.image, i, { width: posInt(obj.width) ?? size.width, height: posInt(obj.height) ?? size.height });
  const raw = typeof im === 'string' ? im : [obj?.base64, obj?.data, obj?.image].find((s) => typeof s === 'string');
  if (typeof raw !== 'string' || raw === '')
    throw new Error(`image ${i + 1}: no base64 data`);
  const b64 = raw.trim().replace(DATA_URI_PREFIX, '').replace(/\s+/g, '');
  if (!BASE64_RE.test(b64))
    throw new Error(`image ${i + 1}: not valid base64`);
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (isPng(bytes)) {
    decodePng(bytes); // throws on a corrupt PNG
    return bytes;
  }
  const width = posInt(obj?.width) ?? size.width;
  const height = posInt(obj?.height) ?? size.height;
  const rgbaLength = width * height * 4;
  if (obj?.type === 'rgba_bytes' || (rgbaLength > 0 && bytes.length === rgbaLength)) {
    if (rgbaLength === 0 || bytes.length !== rgbaLength)
      throw new Error(`image ${i + 1}: ${bytes.length} raw bytes do not match ${width}×${height} RGBA`);
    return encodePng({ width, height, data: bytes });
  }
  throw new Error(`image ${i + 1}: unrecognised image data (${bytes.length} bytes, neither PNG nor ${width}×${height} RGBA)`);
}

/**
 * One PNG per submitted frame, in order. `size` (the first_frame canvas) is the fallback for raw RGBA without
 * width/height. Throws IncompleteResultError for missing / too few images, Error for anything undecodable.
 */
export function decodeResultImages(images: unknown, expected: number, size: { width: number; height: number }): Uint8Array[] {
  if (!Array.isArray(images))
    throw new IncompleteResultError('the result has no images yet');
  if (images.length < expected)
    throw new IncompleteResultError(`the result has ${images.length} of ${expected} images`);
  if (images.length > expected)
    throw new Error(`expected ${expected} images, got ${images.length}`);
  return images.map((im, i) => decodeOne(im, i, size));
}
