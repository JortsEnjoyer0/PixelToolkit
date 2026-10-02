// PNG import and copies (PLAN §3 Images): validate, pad (never scale), write "<charRel>/<owner>.<uid>.png" atomically and
// record it in session-created.json. Electron-free: the IPC layer (ipc/images.ts) only adds the file dialog.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ImportedImage } from '../../shared/api';
import { animImageFileName, joinRel } from '../../shared/dataPaths';
import { nameProblem } from '../../shared/names';
import { ESTIMATE_CANVAS_SIZES, MAX_CANVAS_SIZE } from '../../shared/pixellab';
import { uid } from '../../shared/uid';
import { decodePng, encodePng, isPng, padToSquare, pngSize, type RgbaImage } from '../png';
import { atomicWrite, errCode, resolveChecked } from './dataFs';
import { noteCreatedImages } from './sessionCreated';

/** Larger files are not sprites; refuse before decoding. */
const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

export interface PreparedImage { png: Uint8Array; width: number; height: number; srcWidth: number; srcHeight: number; offset: [number, number] }

/** Decode, check the size limit and pad onto the next square canvas. Throws user-facing messages. */
export function prepareImport(bytes: Uint8Array, label: string): PreparedImage {
  if (!isPng(bytes))
    throw new Error(`"${label}" is not a PNG file`);
  const size = pngSize(bytes);
  if (size && (size.width > MAX_CANVAS_SIZE || size.height > MAX_CANVAS_SIZE))
    throw new Error(`"${label}" is ${size.width}×${size.height} px; images can be at most ${MAX_CANVAS_SIZE} px per side (they are padded, never scaled)`);
  let img: RgbaImage;
  try {
    img = decodePng(bytes);
  } catch (e) {
    throw new Error(`"${label}" could not be read as a PNG: ${(e as Error).message}`);
  }
  if (img.width > MAX_CANVAS_SIZE || img.height > MAX_CANVAS_SIZE)
    throw new Error(`"${label}" is ${img.width}×${img.height} px; images can be at most ${MAX_CANVAS_SIZE} px per side (they are padded, never scaled)`);
  const padded = padToSquare(img);
  return { png: encodePng(padded.img), width: padded.width, height: padded.height, srcWidth: img.width, srcHeight: img.height, offset: padded.offset };
}

/** Main-side guard for names that become file name prefixes (PLAN §3 Names; the rules live in shared/names.ts). */
export function checkEntityName(name: unknown, what: string): string {
  const problem = typeof name === 'string' ? nameProblem(name) : 'not a string';
  if (problem !== null)
    throw new Error(`Invalid ${what} name ${JSON.stringify(name)}: ${problem}`);
  return name as string;
}

/** The character dir must already exist (images are never written into a recreated folder). */
export async function assertCharacterDir(charRel: string): Promise<void> {
  const abs = await resolveChecked(charRel);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st?.isDirectory())
    throw new Error(`The character folder "${charRel}" does not exist`);
}

/** Write `png` as "<charRel>/<fileName(uid)>" with a fresh uid (never overwrites) and record it for the session sweep. */
export async function writeNewImage(charRel: string, fileName: (uid: string) => string, png: Uint8Array): Promise<{ uid: string; rel: string }> {
  await assertCharacterDir(charRel);
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = uid();
    const rel = joinRel(charRel, fileName(id));
    const abs = await resolveChecked(rel);
    const taken = await fsp.lstat(abs).then(() => true, (e) => errCode(e) !== 'ENOENT');
    if (taken)
      continue;
    await atomicWrite(abs, png);
    await noteCreatedImages([rel]);
    return { uid: id, rel };
  }
  throw new Error('Could not allocate a free image uid');
}

/** Import the PNG at the absolute path `srcAbs` (user-picked, outside the data root) into the character dir. */
export async function importImageFile(srcAbs: string, charRel: string, fileName: (uid: string) => string): Promise<ImportedImage> {
  const label = path.basename(srcAbs);
  const st = await fsp.stat(srcAbs);
  if (!st.isFile())
    throw new Error(`"${label}" is not a file`);
  if (st.size > MAX_IMPORT_BYTES)
    throw new Error(`"${label}" is too large for a sprite (${Math.round(st.size / 1024)} KB)`);
  const prepared = prepareImport(new Uint8Array(await fsp.readFile(srcAbs)), label);
  const { uid: id } = await writeNewImage(charRel, fileName, prepared.png);
  const { width, height, srcWidth, srcHeight, offset } = prepared;
  return { uid: id, width, height, srcWidth, srcHeight, offset, sourceName: label.replace(/\.png$/i, '') };
}

/** Byte copy of "<charRel>/<srcFile>" (e.g. "base.<uid>.png") to the animation-owned "<animName>.<newUid>.png". */
export async function copyToAnimation(charRel: string, srcFile: unknown, animName: unknown): Promise<{ uid: string }> {
  if (typeof srcFile !== 'string' || srcFile === '' || /[\\/]/.test(srcFile) || srcFile.startsWith('.') || !/\.png$/i.test(srcFile))
    throw new Error(`Invalid source image file name: ${JSON.stringify(srcFile)}`);
  const name = checkEntityName(animName, 'animation');
  const bytes = new Uint8Array(await fsp.readFile(await resolveChecked(joinRel(charRel, srcFile))));
  if (!isPng(bytes))
    throw new Error(`"${srcFile}" is not a PNG file`);
  const { uid: id } = await writeNewImage(charRel, (u) => animImageFileName(name, u), bytes);
  return { uid: id };
}

/** A PNG canvas to send to PixelLab (estimate input, first_frame): a square from ESTIMATE_CANVAS_SIZES. */
export async function readCanvasPng(rel: unknown): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const abs = await resolveChecked(rel);
  if (!/\.png$/i.test(abs))
    throw new Error(`Not a PNG file: ${String(rel)}`);
  const bytes = new Uint8Array(await fsp.readFile(abs));
  const size = pngSize(bytes);
  if (!size)
    throw new Error(`"${String(rel)}" is not a PNG file`);
  if (size.width !== size.height || !(ESTIMATE_CANVAS_SIZES as readonly number[]).includes(size.width))
    throw new Error(`"${String(rel)}" is ${size.width}×${size.height}; PixelLab needs a square ${ESTIMATE_CANVAS_SIZES.join('/')} px canvas`);
  return { bytes, ...size };
}
