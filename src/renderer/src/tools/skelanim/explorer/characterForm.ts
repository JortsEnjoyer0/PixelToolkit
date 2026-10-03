// Character dialog helpers: select options and labels, the direction guess for imported sprites, and the "which
// animations reference this base image" check behind Remove (docs/skelanim/skelanim.md "UI").
import { joinRel } from '@shared/dataPaths';
import { CAMERA_VIEWS, DIRECTIONS, TEMPLATE_IDS, type CameraView, type Direction, type TemplateId } from '@shared/pixellab';
import type { SelectOption } from '../../../components/common/types';
import { relKey } from '../../../stores/explorer';
import type { DocHandle } from '../../../stores/types';

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "south-east" → "South-East", "low top-down" → "Low top-down". */
export const directionLabel = (d: Direction): string => d.split('-').map(capitalize).join('-');
export const viewLabel = (v: CameraView): string => capitalize(v);
export const templateLabel = (t: TemplateId): string => capitalize(t);

export const DIRECTION_OPTIONS: SelectOption<Direction>[] = DIRECTIONS.map((d) => ({ value: d, label: directionLabel(d) }));
/** Base image direction: '' = not set (null in the meta). */
export const BASE_DIRECTION_OPTIONS: SelectOption<Direction | ''>[] = [{ value: '', label: 'No direction' }, ...DIRECTION_OPTIONS];
export const VIEW_OPTIONS: SelectOption<CameraView>[] = CAMERA_VIEWS.map((v) => ({ value: v, label: viewLabel(v) }));
export const TEMPLATE_OPTIONS: SelectOption<TemplateId>[] = TEMPLATE_IDS.map((t) => ({ value: t, label: templateLabel(t) }));

const SOUTH = new Set(['south', 'down', 'front', 'camera', 'forward']);
const NORTH = new Set(['north', 'up', 'back', 'away']);
const EAST = new Set(['east', 'right']);
const WEST = new Set(['west', 'left']);
const COMPOUND: Record<string, Direction> = {
  southeast: 'south-east', southwest: 'south-west', northeast: 'north-east', northwest: 'north-west',
  se: 'south-east', sw: 'south-west', ne: 'north-east', nw: 'north-west'
};

/**
 * Facing direction suggested by a sprite file name ("merchant_rightfacing_128" → east, "boy_facingcamera" → south),
 * or null when the name says nothing. Only whole words count (after splitting off "facing" and digits).
 */
export function guessDirection(fileName: string): Direction | null {
  const words = fileName.toLowerCase().replace(/facing/g, ' ').split(/[^a-z]+/).filter(Boolean);
  for (const w of words) {
    if (COMPOUND[w])
      return COMPOUND[w];
  }
  const has = (set: Set<string>): boolean => words.some((w) => set.has(w));
  const vertical = has(SOUTH) ? 'south' : has(NORTH) ? 'north' : null;
  const horizontal = has(EAST) ? 'east' : has(WEST) ? 'west' : null;
  if (vertical && horizontal)
    return `${vertical}-${horizontal}` as Direction;
  return vertical ?? horizontal;
}

/**
 * Names of the animations whose reference was copied from base image `baseUid`: every animation json in the character
 * dir (read from disk now) plus open docs (unsaved state). Advisory only: animations own their copy of the image.
 */
export async function animationsUsingBase(charRel: string, baseUid: string, openDocs: Iterable<DocHandle>): Promise<string[]> {
  const names = new Set<string>();
  const jsons = (await window.api.fs.listDir(charRel)).filter((e) => e.kind === 'file' && /\.json$/i.test(e.name));
  const raws = await Promise.all(jsons.map((e) => window.api.fs.readJson<{ reference?: { sourceBaseUid?: unknown } }>(joinRel(charRel, e.name)).catch(() => null)));
  jsons.forEach((e, i) => {
    if (raws[i]?.reference?.sourceBaseUid === baseUid)
      names.add(e.name.slice(0, -5));
  });
  for (const d of openDocs) {
    if (relKey(d.charRel.value) === relKey(charRel) && d.state.value.reference.sourceBaseUid === baseUid)
      names.add(d.name.value);
  }
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
