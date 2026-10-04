// Raw RGBA image type and the limits for images opened from outside the data root (Img to PixelArt). Types and
// constants only; shared by main, preload and renderer.

/** Straight (non-premultiplied) 8-bit RGBA, row-major, width·height·4 bytes. */
export interface RgbaImage { width: number; height: number; data: Uint8Array }

/** Extensions the open dialog offers. The renderer decodes them, so any format Chromium decodes works. */
export const OPEN_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const;

/** Largest file files.openImage reads, bytes. */
export const MAX_OPEN_IMAGE_BYTES = 64 * 1024 * 1024;

/** Largest side of a decoded or saved image, px. */
export const MAX_IMAGE_SIDE = 8192;

/** Largest decoded image area, px (64 MB of RGBA). */
export const MAX_IMAGE_PIXELS = 4096 * 4096;
