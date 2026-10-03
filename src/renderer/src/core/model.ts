// Persisted model (docs/skelanim/skelanim.md "Data model"): character and animation json types, factories, serialize /
// parse (with migrations). Field names are frozen. Framework-free: no Vue or three imports.
import {
  CAMERA_VIEWS, DIRECTIONS, SKELETON_LABELS, TEMPLATE_IDS, VIEW_PITCH,
  canonicalKeypoints, type CameraView, type Direction, type KeypointOut, type SkeletonLabel, type TemplateId
} from '@shared/pixellab';
import { BONE_NAMES, END_SITE_NAMES, FACE_LABELS, type BoneName, type EndSiteName, type FaceLabel, type Pose, type Quat, type Vec3 } from '@shared/pose';
import { formatJson, isObj, type Obj } from '@shared/json';
import { DEFAULT_FPS } from '@shared/settings';
import { isUid, uid } from '@shared/uid';
import { calibrationHeight, restPose, templateCalibration } from './rig/poses';
import { defaultProjection } from './rig/projection';

export { BONE_NAMES, DEFAULT_FPS, END_SITE_NAMES, FACE_LABELS, formatJson };
export type { BoneName, EndSiteName, FaceLabel, Pose, Quat, Vec3 };

export const CHARACTER_VERSION = 1;
export const ANIMATION_VERSION = 1;
/** Canvas assumed for projection framing until a reference image is picked. */
export const DEFAULT_CANVAS = 64;

export interface CharacterMeta {
  version: 1;
  id: string;
  /** Appearance phrase; default for every animation's description. */
  description: string;
  baseImages: BaseImage[];
  defaults: { direction: Direction; view: CameraView; templateId: TemplateId };
}

export interface BaseImage {
  /** File: "<charRel>/base.<uid>.png". */
  uid: string;
  label: string;
  direction: Direction | null;
  /** Padded canvas size. */
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  /** Where the source sprite sits in the canvas, px. */
  offset: [number, number];
  /** Cached estimate-skeleton result (canonical order); `at` = ISO time. */
  estimate: { keypoints: KeypointOut[]; at: string } | null;
}

export interface AnimationMeta {
  version: 1;
  id: string;
  source: 'manual';
  action: string;
  /** '' → the character's description is sent. */
  description: string;
  direction: Direction;
  view: CameraView;
  pitchDeg: number;
  templateId: TemplateId;
  /** 0 = random. */
  seed: number;
  noBackground: boolean;
  sendDepth: boolean;
  fps: number;
  reference: ReferenceData;
  /** Template calibration until estimated. */
  rig: RigCalibration;
  /** Default framing until estimated. */
  projection: Projection;
  /** Track frames 1..N (the reference is separate). */
  frames: FrameData[];
}

export interface ReferenceData {
  /** Animation-owned image uid ("<anim>.<uid>.png"), or null. */
  image: string | null;
  /** Base image it was copied from (estimate cache key). */
  sourceBaseUid: string | null;
  /** Reference canvas size (DEFAULT_CANVAS when there is no image). */
  width: number;
  height: number;
  /**
   * 2D estimate, canonical order: the API result, with x / y following COCO edit corrections. Re-lifted when direction,
   * view or pitch changes.
   */
  estimate: KeypointOut[] | null;
  /** 18 canonical 3D points (COCO edit mode edits these); NECK = shoulder midpoint. */
  coco: Vec3[] | null;
  /** Calibrated rig pose: cocoFromFk(fk(pose, rig)) == coco. */
  pose: Pose | null;
  /** The reference image changed since the last estimate. */
  needsEstimate: boolean;
}

/** World → canvas: px = anchorPx.x + ppu·(P·r), py = anchorPx.y − ppu·(P·u) (docs/skelanim/rig.md "Projection"). */
export interface Projection {
  /** Canvas px per world unit. */
  ppu: number;
  /** Canvas px of the world origin. */
  anchorPx: [number, number];
}

export interface FrameData {
  /** Frame identity (playback target, selection); not an image uid. */
  uid: string;
  pose: Pose;
  /** Animation-owned image uid, or null. */
  image: string | null;
  /** The pose was edited after the image was generated. */
  imageStale: boolean;
}

export interface RigCalibration {
  /** Head offset from the parent head, in the parent's rest frame. Hips' entry is unused (root = Pose.root). */
  offsets: Record<BoneName | EndSiteName, Vec3>;
  /** Head-local face offsets, template-aligned frame (docs/skelanim/rig.md "Calibration" step 5). */
  face: Record<FaceLabel, Vec3>;
  /** H_char: rest HeadTop.y minus the lowest foot/toe y. */
  height: number;
}

/**
 * Document fields that are undoable: everything PixelLab-bound, so not the name or fps
 * (docs/skelanim/skelanim.md "Documents").
 */
export const UNDOABLE_KEYS = [
  'reference', 'rig', 'projection', 'frames', 'direction', 'view', 'pitchDeg',
  'action', 'description', 'templateId', 'seed', 'noBackground', 'sendDepth'
] as const;
export type UndoableKey = typeof UNDOABLE_KEYS[number];

/** Immutable, copy-on-write document content (frozen in dev). Treat every nested object as read-only. */
export type UndoableState = Readonly<Pick<AnimationMeta, UndoableKey>>;

/** What the editor and the frame track act on: the pinned REF slot or a track frame. */
export type FrameTarget = { kind: 'ref' } | { kind: 'frame'; uid: string };

// ---------- factories ----------

export function createCharacterMeta(): CharacterMeta {
  return {
    version: CHARACTER_VERSION,
    id: uid(),
    description: '',
    baseImages: [],
    defaults: { direction: 'south', view: 'low top-down', templateId: 'mannequin' }
  };
}

export interface CreateAnimationOptions {
  direction?: Direction;
  view?: CameraView;
  templateId?: TemplateId;
  fps?: number;
  action?: string;
  description?: string;
  /** Canvas to frame the default projection for (the picked base image's canvas). */
  canvas?: { width: number; height: number };
}

/** New animation: template calibration, default projection for the canvas, no reference, no frames. */
export function createAnimationMeta(opts: CreateAnimationOptions = {}): AnimationMeta {
  const view = opts.view ?? 'low top-down';
  const canvas = opts.canvas ?? { width: DEFAULT_CANVAS, height: DEFAULT_CANVAS };
  const rig = templateCalibration();
  return {
    version: ANIMATION_VERSION,
    id: uid(),
    source: 'manual',
    action: opts.action ?? '',
    description: opts.description ?? '',
    direction: opts.direction ?? 'south',
    view,
    pitchDeg: VIEW_PITCH[view],
    templateId: opts.templateId ?? 'mannequin',
    seed: 0,
    noBackground: true,
    sendDepth: false,
    fps: opts.fps ?? DEFAULT_FPS,
    reference: emptyReference(canvas.width, canvas.height),
    rig,
    projection: defaultProjection(canvas, rig.height),
    frames: []
  };
}

export const emptyReference = (width = DEFAULT_CANVAS, height = DEFAULT_CANVAS): ReferenceData => ({
  image: null, sourceBaseUid: null, width, height, estimate: null, coco: null, pose: null, needsEstimate: false
});

// ---------- serialize ----------

const round6 = (n: number): number => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

/** Plain deep copy (works on frozen state and Vue proxies' raw values) with numbers rounded to 6 decimals. */
function toPlain(value: unknown, path: string): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`Cannot serialize non-finite number at ${path}`);
    return round6(value);
  }
  if (value === null || typeof value !== 'object')
    return value;
  if (Array.isArray(value))
    return value.map((v, i) => toPlain(v, `${path}[${i}]`));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined)
      out[k] = toPlain(v, `${path}.${k}`);
  }
  return out;
}

/** Plain object ready for api.fs.writeJson (never pass store state or proxies over IPC). Throws on NaN / Infinity. */
export const serializeAnimation = (meta: AnimationMeta): AnimationMeta => toPlain(meta, 'animation') as AnimationMeta;

export const serializeCharacter = (meta: CharacterMeta): CharacterMeta => toPlain(meta, 'character') as CharacterMeta;

// ---------- parse ----------

const asObj = (v: unknown): Obj => isObj(v) ? v : {};
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, d: number): number => fin(v) ? v : d;
const posNum = (v: unknown, d: number): number => fin(v) && v > 0 ? v : d;
const str = (v: unknown, d: string): string => typeof v === 'string' ? v : d;
const bool = (v: unknown, d: boolean): boolean => typeof v === 'boolean' ? v : d;
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list as readonly unknown[]).includes(v) ? v as T : d;
/** Image references become file names ("<anim>.<uid>.png"), so anything but a valid uid reads as null. */
const uidOrNull = (v: unknown): string | null => isUid(v) ? v : null;

function vec3(v: unknown, d: Readonly<Vec3>): Vec3 {
  if (Array.isArray(v) && v.length === 3 && v.every(fin))
    return [v[0], v[1], v[2]];
  return [d[0], d[1], d[2]];
}

function quat(v: unknown): Quat {
  if (Array.isArray(v) && v.length === 4 && v.every(fin)) {
    const l = Math.hypot(v[0], v[1], v[2], v[3]);
    if (l > 1e-9)
      return [v[0] / l, v[1] / l, v[2] / l, v[3] / l];
  }
  return [0, 0, 0, 1];
}

function pair(v: unknown, d: [number, number]): [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every(fin) ? [v[0], v[1]] : [d[0], d[1]];
}

/** Missing bones → identity, missing root → rest root. */
export function parsePose(v: unknown): Pose {
  const raw = asObj(v);
  const rot = asObj(raw.rot);
  return {
    root: vec3(raw.root, restPose().root),
    rot: Object.fromEntries(BONE_NAMES.map((b) => [b, quat(rot[b])])) as Record<BoneName, Quat>
  };
}

/** Missing offsets / face points → template values; height recomputed when missing. */
export function parseCalibration(v: unknown): RigCalibration {
  const raw = asObj(v);
  const t = templateCalibration();
  const offsets = asObj(raw.offsets);
  const face = asObj(raw.face);
  const calib: RigCalibration = {
    offsets: Object.fromEntries([...BONE_NAMES, ...END_SITE_NAMES].map((k) => [k, vec3(offsets[k], t.offsets[k])])) as RigCalibration['offsets'],
    face: Object.fromEntries(FACE_LABELS.map((k) => [k, vec3(face[k], t.face[k])])) as RigCalibration['face'],
    height: 0
  };
  calib.height = posNum(raw.height, calibrationHeight(calib));
  return calib;
}

/** 18 valid keypoints (any order) → canonical order; otherwise null. */
export function parseKeypointsOut(v: unknown): KeypointOut[] | null {
  if (!Array.isArray(v))
    return null;
  const kps = v.filter((k): k is Obj => isObj(k) && (SKELETON_LABELS as readonly unknown[]).includes(k.label) && fin(k.x) && fin(k.y))
    .map((k) => ({ label: k.label as SkeletonLabel, x: k.x as number, y: k.y as number, z_index: num(k.z_index, 0) }));
  return canonicalKeypoints(kps);
}

function parseCoco(v: unknown): Vec3[] | null {
  if (!Array.isArray(v) || v.length !== SKELETON_LABELS.length)
    return null;
  const pts = v.map((p) => Array.isArray(p) && p.length === 3 && p.every(fin) ? [p[0], p[1], p[2]] as Vec3 : null);
  return pts.every((p) => p !== null) ? pts as Vec3[] : null;
}

function parseReference(v: unknown): ReferenceData {
  const raw = asObj(v);
  const coco = parseCoco(raw.coco);
  return {
    image: uidOrNull(raw.image),
    sourceBaseUid: uidOrNull(raw.sourceBaseUid),
    width: posNum(raw.width, DEFAULT_CANVAS),
    height: posNum(raw.height, DEFAULT_CANVAS),
    estimate: parseKeypointsOut(raw.estimate),
    coco,
    pose: coco && isObj(raw.pose) ? parsePose(raw.pose) : null,
    needsEstimate: bool(raw.needsEstimate, false)
  };
}

function parseFrames(v: unknown): FrameData[] {
  const seen = new Set<string>();
  const frames: FrameData[] = [];
  for (const f of Array.isArray(v) ? v : []) {
    if (!isObj(f) || !isObj(f.pose))
      continue;
    let id = isUid(f.uid) && !seen.has(f.uid) ? f.uid : uid();
    while (seen.has(id))
      id = uid();
    seen.add(id);
    const image = uidOrNull(f.image);
    frames.push({ uid: id, pose: parsePose(f.pose), image, imageStale: image !== null && bool(f.imageStale, false) });
  }
  return frames;
}

/** Upgrades raw json from version N to N + 1; keyed by N. Add an entry whenever ANIMATION_VERSION is bumped. */
const ANIMATION_MIGRATIONS: Record<number, (raw: Obj) => Obj> = {};
const CHARACTER_MIGRATIONS: Record<number, (raw: Obj) => Obj> = {};

function migrate(raw: Obj, current: number, migrations: Record<number, (raw: Obj) => Obj>, what: string): Obj {
  let version = fin(raw.version) ? raw.version : current; // pre-versioned files are treated as current
  if (version > current)
    throw new Error(`${what} version ${version} is newer than this app supports (${current})`);
  let out = raw;
  while (version < current) {
    const step = migrations[version];
    if (!step)
      throw new Error(`No migration for ${what} version ${version}`);
    out = step(out);
    version++;
  }
  return out;
}

/** Validates, migrates and fills defaults. Throws only for non-objects or unsupported versions. */
export function parseAnimation(json: unknown): AnimationMeta {
  if (!isObj(json))
    throw new Error('Animation file must contain a JSON object');
  const raw = migrate(json, ANIMATION_VERSION, ANIMATION_MIGRATIONS, 'Animation');
  const view = oneOf(raw.view, CAMERA_VIEWS, 'low top-down');
  const reference = parseReference(raw.reference);
  const rig = parseCalibration(raw.rig);
  const proj = asObj(raw.projection);
  const fallback = defaultProjection({ width: reference.width, height: reference.height }, rig.height);
  return {
    version: ANIMATION_VERSION,
    id: isUid(raw.id) ? raw.id : uid(),
    source: 'manual',
    action: str(raw.action, ''),
    description: str(raw.description, ''),
    direction: oneOf(raw.direction, DIRECTIONS, 'south'),
    view,
    pitchDeg: num(raw.pitchDeg, VIEW_PITCH[view]),
    templateId: oneOf(raw.templateId, TEMPLATE_IDS, 'mannequin'),
    seed: fin(raw.seed) && raw.seed >= 0 ? Math.floor(raw.seed) : 0,
    noBackground: bool(raw.noBackground, true),
    sendDepth: bool(raw.sendDepth, false),
    fps: posNum(raw.fps, DEFAULT_FPS),
    reference,
    rig,
    projection: { ppu: posNum(proj.ppu, fallback.ppu), anchorPx: pair(proj.anchorPx, fallback.anchorPx) },
    frames: parseFrames(raw.frames)
  };
}

function parseBaseImage(v: unknown): BaseImage | null {
  const raw = asObj(v);
  if (!isUid(raw.uid))
    return null;
  const est = asObj(raw.estimate);
  const keypoints = parseKeypointsOut(est.keypoints);
  return {
    uid: raw.uid,
    label: str(raw.label, ''),
    direction: (DIRECTIONS as readonly unknown[]).includes(raw.direction) ? raw.direction as Direction : null,
    width: posNum(raw.width, DEFAULT_CANVAS),
    height: posNum(raw.height, DEFAULT_CANVAS),
    srcWidth: posNum(raw.srcWidth, posNum(raw.width, DEFAULT_CANVAS)),
    srcHeight: posNum(raw.srcHeight, posNum(raw.height, DEFAULT_CANVAS)),
    offset: pair(raw.offset, [0, 0]),
    estimate: keypoints ? { keypoints, at: str(est.at, '') } : null
  };
}

/** Validates, migrates and fills defaults. Throws only for non-objects or unsupported versions. */
export function parseCharacter(json: unknown): CharacterMeta {
  if (!isObj(json))
    throw new Error('Character file must contain a JSON object');
  const raw = migrate(json, CHARACTER_VERSION, CHARACTER_MIGRATIONS, 'Character');
  const defaults = asObj(raw.defaults);
  return {
    version: CHARACTER_VERSION,
    id: isUid(raw.id) ? raw.id : uid(),
    description: str(raw.description, ''),
    baseImages: (Array.isArray(raw.baseImages) ? raw.baseImages : []).map(parseBaseImage).filter((b): b is BaseImage => b !== null),
    defaults: {
      direction: oneOf(defaults.direction, DIRECTIONS, 'south'),
      view: oneOf(defaults.view, CAMERA_VIEWS, 'low top-down'),
      templateId: oneOf(defaults.templateId, TEMPLATE_IDS, 'mannequin')
    }
  };
}
