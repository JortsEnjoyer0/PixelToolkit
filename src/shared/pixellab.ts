// PixelLab v2 wire types and pure helpers. API facts and rules: docs/pixellab.md.
// Shared by main, preload and renderer: no runtime dependencies outside src/shared.
import { isObj } from './json';

/** The 18 joint labels in canonical order (spec enum = OpenPose COCO-18 index). `*ARM` = wrist, `*LEG` = ankle. */
export const SKELETON_LABELS = [
  'NOSE', 'NECK',
  'RIGHT SHOULDER', 'RIGHT ELBOW', 'RIGHT ARM',
  'LEFT SHOULDER', 'LEFT ELBOW', 'LEFT ARM',
  'RIGHT HIP', 'RIGHT KNEE', 'RIGHT LEG',
  'LEFT HIP', 'LEFT KNEE', 'LEFT LEG',
  'RIGHT EYE', 'LEFT EYE', 'RIGHT EAR', 'LEFT EAR'
] as const;
export type SkeletonLabel = typeof SKELETON_LABELS[number];

/** Facing directions in yaw order: θ = index · 45° (south 0°, east 90°, north 180°, west 270°). */
export const DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'] as const;
export type Direction = typeof DIRECTIONS[number];

/** REST v2 spelling (spaces, never hyphens). */
export const CAMERA_VIEWS = ['side', 'low top-down', 'high top-down'] as const;
export type CameraView = typeof CAMERA_VIEWS[number];

/** Default camera pitch φ in degrees per view (PixelLab documents ~20° and ~35°); the user can override it. */
export const VIEW_PITCH: Readonly<Record<CameraView, number>> = { side: 0, 'low top-down': 20, 'high top-down': 35 };

export const TEMPLATE_IDS = ['mannequin', 'bear', 'cat', 'dog', 'horse', 'lion'] as const;
export type TemplateId = typeof TEMPLATE_IDS[number];

/** Square canvas sizes accepted by estimate-skeleton; sprites are padded (never scaled) to the next one. */
export const ESTIMATE_CANVAS_SIZES = [16, 32, 64, 128, 256] as const;
export const MAX_CANVAS_SIZE = 256;

export const MIN_FRAMES = 3;
export const MAX_FRAMES = 15;
export const MAX_ACTION_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;
/** Approximate cost of one estimate-skeleton call, in generations. */
export const ESTIMATE_COST = 0.1;

/** animate-with-skeleton-v3 input joint. x, y are canvas fractions (y down); z_index must be an integer. */
export interface Keypoint {
  label: SkeletonLabel; x: number; y: number;
  /** Draw order, higher draws on top. Integer (fractions are rejected). */
  z_index: number;
  /** 0..255, higher = nearer, ~128 at the body centre. Omit to use the template's depth. */
  depth?: number;
}

/**
 * estimate-skeleton output joint. z_index is a FLOAT (coarse layers, nearest = 0, e.g. -4..0 with half steps):
 * round before reuse. The response is NOT in canonical order (NECK comes last): use canonicalKeypoints().
 */
export interface KeypointOut { label: SkeletonLabel; x: number; y: number; z_index: number }

/** Reorders to SKELETON_LABELS order; null unless every label occurs exactly once. */
export function canonicalKeypoints<T extends { label: string }>(kps: readonly T[]): T[] | null {
  if (kps.length !== SKELETON_LABELS.length)
    return null;
  const byLabel = new Map(kps.map((k) => [k.label, k]));
  const out = SKELETON_LABELS.map((l) => byLabel.get(l));
  return out.every((k) => k !== undefined) ? out as T[] : null;
}

/** Raw base64 (no `data:` prefix). additionalProperties: false, so never add width/height. */
export interface Base64Image { type: 'base64'; base64: string; format: 'png' }

/** Billing (spec `Usage`): only `type` is reliably present; live estimate responses omit `usd` entirely. */
export interface Usage { type: 'usd' | 'generations'; usd?: number | null; generations?: number | null }

export interface EstimateSkeletonResponse { keypoints: KeypointOut[]; usage?: Usage | null }

/** testbed/fixtures/<name>.estimate.json (scripts/fetch-fixtures.ts): the raw response (keypoints NOT in canonical order) plus placement. */
export interface EstimateFixtureFile extends EstimateSkeletonResponse {
  source: { file: string; width: number; height: number };
  canvas: { width: number; height: number };
  /** Top-left of the source sprite in the padded canvas, px. */
  offset: [number, number];
}

/**
 * The API base to use for `baseUrl` (no trailing slash), or null unless it is https on pixellab.ai or a subdomain
 * without credentials, query or #fragment, so the key can never be sent elsewhere. Main refuses other URLs; the
 * Settings dialog applies the same rule before saving.
 */
export function checkedBase(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const hostOk = url.hostname === 'pixellab.ai' || url.hostname.endsWith('.pixellab.ai');
  if (url.protocol !== 'https:' || !hostOk || url.username || url.password || url.search || url.hash)
    return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * POST /v2/animate-with-skeleton-v3 body WITHOUT `first_frame` (main fills it from the reference PNG).
 * Exact wire field names; the server rejects any extra key with a 422.
 */
export interface AnimateV3Request {
  /** Appearance noun phrase, 1..1000 chars. */
  description: string;
  /** Short motion label (walk, run, attack), 1..100 chars. */
  action: string;
  direction: Direction;
  view: CameraView;
  /** The pose the reference sprite is already in (18 joints). */
  first_frame_keypoints: Keypoint[];
  /** 3..15 frames of 18 joints; the result has exactly one image per frame, in order. */
  keypoints: Keypoint[][];
  template_id: TemplateId;
  /** Integer ≥ 0; 0 = random. Never null. */
  seed: number;
  no_background: boolean;
}

/** The full wire body main sends. */
export type AnimateV3Body = AnimateV3Request & { first_frame: Base64Image };

/** Estimated generation cost by frame count (3→2, 4..8→3, 9..15→4); null outside 3..15. Bill from `usage` instead. */
export function generationCost(frameCount: number): number | null {
  if (!Number.isInteger(frameCount) || frameCount < MIN_FRAMES || frameCount > MAX_FRAMES)
    return null;
  if (frameCount === 3)
    return 2;
  return frameCount <= 8 ? 3 : 4;
}

const REQUEST_KEYS = new Set(['description', 'action', 'direction', 'view', 'first_frame_keypoints', 'keypoints', 'template_id', 'seed', 'no_background']);
const KEYPOINT_KEYS = new Set(['label', 'x', 'y', 'z_index', 'depth']);

const inUnit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

function validateFrame(frame: unknown, where: string, errors: string[]): void {
  if (!Array.isArray(frame) || frame.length !== SKELETON_LABELS.length) {
    errors.push(`${where}: expected ${SKELETON_LABELS.length} keypoints`);
    return;
  }
  frame.forEach((kp: unknown, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(kp)) {
      errors.push(`${at}: not an object`);
      return;
    }
    for (const key of Object.keys(kp)) {
      if (!KEYPOINT_KEYS.has(key))
        errors.push(`${at}: unexpected key "${key}"`);
    }
    if (kp.label !== SKELETON_LABELS[i])
      errors.push(`${at}: label must be "${SKELETON_LABELS[i]}" (canonical order), got "${String(kp.label)}"`);
    if (!inUnit(kp.x) || !inUnit(kp.y))
      errors.push(`${at}: x and y must be numbers in [0, 1]`);
    if (!Number.isInteger(kp.z_index))
      errors.push(`${at}: z_index must be an integer`);
    if (kp.depth !== undefined && !(typeof kp.depth === 'number' && Number.isFinite(kp.depth) && kp.depth >= 0 && kp.depth <= 255))
      errors.push(`${at}: depth must be a number in [0, 255] or omitted`);
  });
}

function checkText(value: unknown, name: string, max: number, errors: string[]): void {
  if (typeof value !== 'string' || value.trim().length === 0)
    errors.push(`${name} must be a non-empty string`);
  else if (value.length > max)
    errors.push(`${name} must be at most ${max} characters`);
}

/**
 * Pre-submit validation (docs/pixellab.md "animate-with-skeleton-v3" and "Keypoints"). Returns human-readable errors;
 * empty when the request is valid.
 * Defensive: safe to run on untrusted IPC input in main.
 */
export function validateAnimateRequest(req: AnimateV3Request): string[] {
  const errors: string[] = [];
  const r: unknown = req;
  if (!isObj(r))
    return ['request must be an object'];
  for (const key of Object.keys(r)) {
    if (!REQUEST_KEYS.has(key))
      errors.push(`unexpected key "${key}"`);
  }
  checkText(r.description, 'description', MAX_DESCRIPTION_LENGTH, errors);
  checkText(r.action, 'action', MAX_ACTION_LENGTH, errors);
  if (!(DIRECTIONS as readonly unknown[]).includes(r.direction))
    errors.push(`direction must be one of: ${DIRECTIONS.join(', ')}`);
  if (!(CAMERA_VIEWS as readonly unknown[]).includes(r.view))
    errors.push(`view must be one of: ${CAMERA_VIEWS.join(', ')}`);
  if (!(TEMPLATE_IDS as readonly unknown[]).includes(r.template_id))
    errors.push(`template_id must be one of: ${TEMPLATE_IDS.join(', ')}`);
  if (!Number.isInteger(r.seed) || (r.seed as number) < 0)
    errors.push('seed must be an integer ≥ 0 (0 = random)');
  if (typeof r.no_background !== 'boolean')
    errors.push('no_background must be a boolean');
  validateFrame(r.first_frame_keypoints, 'first_frame_keypoints', errors);
  if (!Array.isArray(r.keypoints))
    errors.push('keypoints must be an array of frames');
  else {
    if (r.keypoints.length < MIN_FRAMES || r.keypoints.length > MAX_FRAMES)
      errors.push(`keypoints must have ${MIN_FRAMES}..${MAX_FRAMES} frames, got ${r.keypoints.length}`);
    r.keypoints.forEach((frame: unknown, i) => validateFrame(frame, `keypoints[${i}]`, errors));
  }
  return errors;
}
