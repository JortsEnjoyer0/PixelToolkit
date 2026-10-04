// Image files outside the data root (files.*, Img to PixelArt): read a picked image, validate the RGBA image the renderer
// sends, sanitise the save dialog's default file name and write the PNG atomically. Electron-free: ipc/files.ts only
// adds the native dialogs, the only source of the absolute paths used here (docs/architecture.md "Process model and IPC").
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { OpenedImageFile } from '../../shared/api';
import { MAX_IMAGE_SIDE, MAX_OPEN_IMAGE_BYTES, OPEN_IMAGE_EXTENSIONS, type RgbaImage } from '../../shared/image';
import { encodePng } from '../png';
import { atomicWrite, errCode } from './dataFs';

/** Default save name when the suggestion leaves nothing usable. */
const FALLBACK_STEM = 'pixelart';
/** Longest default save name before ".png", in code points (Windows allows 255 per path component). */
const MAX_STEM_LENGTH = 120;
/** Untrusted suggestions are cut to this many UTF-16 units before any pattern runs on them. */
const MAX_SUGGESTED_LENGTH = 1024;

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
/** Windows device names, reserved with any extension ("nul.png"). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const IMAGE_EXT = new RegExp(`\\.(${OPEN_IMAGE_EXTENSIONS.join('|')})$`, 'i');
/** Windows drops trailing dots and spaces from a file name. */
const TRAILING_DOTS = /[\s.]+$/;

const sizeMb = (bytes: number): string => `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;

/**
 * The image file at `absPath` (picked in the open dialog): its name and bytes, undecoded (the renderer decodes it).
 * Checks the extension (OPEN_IMAGE_EXTENSIONS, any case) and the size (MAX_OPEN_IMAGE_BYTES, by stat) before reading.
 * Throws user-facing messages naming the file.
 */
export async function readImageFile(absPath: string): Promise<OpenedImageFile> {
  const name = path.basename(absPath);
  const fail = (reason: string): Error => new Error(`Could not open "${name}": ${reason}`);
  const ioFail = (e: unknown): never => {
    throw fail(errCode(e) === 'ENOENT' ? 'the file no longer exists' : (e as Error).message);
  };
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!(OPEN_IMAGE_EXTENSIONS as readonly string[]).includes(ext))
    throw fail(`${ext ? `.${ext} files are` : 'files without an extension are'} not supported (use ${OPEN_IMAGE_EXTENSIONS.join(', ')})`);
  const st = await fsp.stat(absPath).catch(ioFail);
  if (!st.isFile())
    throw fail('not a file');
  if (st.size === 0)
    throw fail('the file is empty');
  if (st.size > MAX_OPEN_IMAGE_BYTES)
    throw fail(`the file is too large (${sizeMb(st.size)}; the limit is ${sizeMb(MAX_OPEN_IMAGE_BYTES)})`);
  return { name, bytes: new Uint8Array(await fsp.readFile(absPath).catch(ioFail)) };
}

/**
 * Validates an RGBA image from the renderer (untrusted IPC input): a plain object with integer width and height in
 * 1..MAX_IMAGE_SIDE and `data` a Uint8Array of exactly width·height·4 bytes. Returns { width, height, data } only.
 */
export function checkRgbaImage(v: unknown): RgbaImage {
  const proto = typeof v === 'object' && v !== null ? Object.getPrototypeOf(v) : undefined;
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError('Invalid image: expected { width, height, data }');
  const { width, height, data } = v as Record<string, unknown>;
  const isSide = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_IMAGE_SIDE;
  if (!isSide(width) || !isSide(height))
    throw new RangeError(`Invalid image: width and height must be whole numbers from 1 to ${MAX_IMAGE_SIDE} (got ${String(width)}×${String(height)})`);
  if (!(data instanceof Uint8Array))
    throw new TypeError('Invalid image: data must be a Uint8Array');
  if (data.length !== width * height * 4)
    throw new RangeError(`Invalid image: ${data.length} bytes of data for ${width}×${height} RGBA (expected ${width * height * 4})`);
  return { width, height, data };
}

/**
 * Safe default file name for the save dialog: drops the characters Windows forbids and control characters, edge spaces
 * and dots and a trailing image extension (OPEN_IMAGE_EXTENSIONS), caps the length (MAX_STEM_LENGTH), prefixes a Windows
 * device name with "_" and appends ".png". Falls back to "pixelart.png".
 */
export function pngFileName(suggested: string): string {
  // Bounded first: the input is untrusted and the trailing-dots pattern backtracks on long runs of spaces or dots
  let stem = suggested.slice(0, MAX_SUGGESTED_LENGTH).replace(UNSAFE_CHARS, '').trimStart().replace(TRAILING_DOTS, '');
  stem = stem.replace(IMAGE_EXT, '').replace(/^[\s.]+/, '').replace(TRAILING_DOTS, '');
  stem = Array.from(stem).slice(0, MAX_STEM_LENGTH).join('').replace(TRAILING_DOTS, '');
  if (DEVICE_NAME.test(stem.split('.')[0].trimEnd()))
    stem = `_${stem}`;
  return `${stem || FALLBACK_STEM}.png`;
}

/**
 * Encodes `img` as 8-bit RGBA PNG and writes it atomically to `absPath` (picked in the save dialog), with ".png" appended
 * when the name has no extension. Never creates folders. Resolves the path written.
 */
export async function writePngFile(absPath: string, img: RgbaImage): Promise<string> {
  if (!path.isAbsolute(absPath))
    throw new Error(`Not an absolute path: ${absPath}`);
  const trimmed = absPath.replace(TRAILING_DOTS, '');
  const target = path.extname(trimmed) === '' ? `${trimmed}.png` : trimmed;
  try {
    await atomicWrite(target, encodePng(img));
  } catch (e) {
    throw new Error(`Could not save "${path.basename(target)}": ${saveErrorReason(e)}`);
  }
  return target;
}

/** User-facing reason for a failed save (never the temp file name of the atomic write). */
function saveErrorReason(e: unknown): string {
  const code = errCode(e);
  if (code === 'EPERM' || code === 'EACCES')
    return 'the file is read-only or you do not have permission to write there';
  if (code === 'EBUSY')
    return 'the file is in use by another program';
  if (code === 'ENOENT')
    return 'its folder no longer exists';
  if (code === 'ENOSPC')
    return 'the disk is full';
  return (e as Error)?.message ?? String(e);
}
