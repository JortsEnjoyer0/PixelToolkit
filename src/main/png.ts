// PNG decode/encode and square padding (pngjs, pure JS). Used by main (images, jobs) and the tsx scripts,
// so it imports nothing from electron and only relative paths.
import { PNG } from 'pngjs';
import type { RgbaImage } from '../shared/image';
import { ESTIMATE_CANVAS_SIZES, MAX_CANVAS_SIZE } from '../shared/pixellab';

export type { RgbaImage };

export interface PaddedImage {
  img: RgbaImage;
  width: number;
  height: number;
  /** Top-left of the source inside the padded canvas, px. */
  offset: [number, number];
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= SIGNATURE.length && SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Width and height from the IHDR chunk (no decode); null unless the bytes start like a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isPng(bytes) || bytes.length < 24)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdr = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  return ihdr === 'IHDR' ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
}

/** Any PNG colour type / bit depth → 8-bit RGBA. Throws on invalid data. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes))
    throw new Error('Not a PNG file');
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

/** RGBA → PNG (colour type 6, 8-bit). Deterministic for the same input. */
export function encodePng(img: RgbaImage): Uint8Array {
  if (img.data.length !== img.width * img.height * 4)
    throw new Error(`RGBA data length ${img.data.length} does not match ${img.width}x${img.height}`);
  const png = new PNG({ width: img.width, height: img.height, colorType: 6, inputColorType: 6, bitDepth: 8, inputHasAlpha: true });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  const out = PNG.sync.write(png, { colorType: 6, inputColorType: 6, bitDepth: 8, inputHasAlpha: true });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Pad (never scale) onto the smallest square canvas from `sizes` that fits, centred (floor) on both axes,
 * with transparent padding. Throws when either side exceeds the largest size (256).
 */
export function padToSquare(img: RgbaImage, sizes: readonly number[] = ESTIMATE_CANVAS_SIZES): PaddedImage {
  const side = Math.max(img.width, img.height);
  const size = [...sizes].sort((a, b) => a - b).find((s) => s >= side);
  if (size === undefined)
    throw new Error(`Image is ${img.width}x${img.height}; the maximum is ${Math.max(...sizes, 0) || MAX_CANVAS_SIZE} px per side`);
  const ox = Math.floor((size - img.width) / 2);
  const oy = Math.floor((size - img.height) / 2);
  const data = new Uint8Array(size * size * 4);
  const rowBytes = img.width * 4;
  for (let y = 0; y < img.height; y++)
    data.set(img.data.subarray(y * rowBytes, (y + 1) * rowBytes), ((y + oy) * size + ox) * 4);
  return { img: { width: size, height: size, data }, width: size, height: size, offset: [ox, oy] };
}
