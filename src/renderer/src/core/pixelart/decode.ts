// Image decoding for Img to PixelArt: a file or clipboard Blob → straight 8-bit RGBA pixels (RgbaImage) plus an
// ImageBitmap for drawing. Browser-only (createImageBitmap, OffscreenCanvas): the node tests never import it; the rest of
// core/pixelart works on RgbaImage alone. No colour-space conversion and no premultiplication, so the pixels are the
// file's own values (a 2D canvas still stores premultiplied alpha: semi-transparent pixels may round by one step).
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, type RgbaImage } from '@shared/image';

export interface DecodedImage { image: RgbaImage; bitmap: ImageBitmap }

const megapixels = (px: number): string => (px / 1e6).toFixed(1);

/**
 * Decode `blob` (any format Chromium decodes). Rejects with a user-facing message naming `name` when it is not an
 * image or exceeds MAX_IMAGE_SIDE / MAX_IMAGE_PIXELS. The caller owns the bitmap (close it when done).
 */
export async function decodeImageBlob(blob: Blob, name: string): Promise<DecodedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error(`"${name}" is not an image, or its format cannot be decoded.`);
  }
  try {
    const { width, height } = bitmap;
    if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE)
      throw new Error(`"${name}" is ${width} × ${height} px; images may be at most ${MAX_IMAGE_SIDE} px on a side.`);
    if (width * height > MAX_IMAGE_PIXELS)
      throw new Error(`"${name}" is ${width} × ${height} px (${megapixels(width * height)} megapixels); images may have at most ${megapixels(MAX_IMAGE_PIXELS)} megapixels.`);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!ctx)
      throw new Error(`Could not decode "${name}": no 2D canvas available.`);
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data;
    // A view, not a copy: nothing else holds the ImageData
    const data = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    return { image: { width, height, data }, bitmap };
  } catch (e) {
    bitmap.close();
    throw e;
  }
}
