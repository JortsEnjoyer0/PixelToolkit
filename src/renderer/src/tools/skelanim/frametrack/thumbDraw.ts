// Frame-track thumbnail drawing (canvas 2D): the pixelated frame image, the COCO-18 keypoints PixelLab receives (pinned
// OpenPose palette, limbs ×0.6) and the frame label in an outlined font, on a transparent canvas (the grey checker is
// the element's CSS background, so redraws skip it). Framework-free.
import type { Keypoint } from '@shared/pixellab';
import type { Pose, Vec3 } from '@shared/pose';
import type { UndoableState } from '../../../core/model';
import { COCO_LIMBS, OPENPOSE_COLORS, jointColor, limbColor, rgbCss } from '../../../core/rig/coco';
import { clamp } from '../../../core/util/math';
import { cameraBasis, createProjectScratch, projectCocoForDisplay, projectPose, type CameraBasis } from '../../../core/rig/projection';

const LABEL_FONT = '600 11px system-ui, "Segoe UI", sans-serif';
const LIMB_CSS = COCO_LIMBS.map((_, j) => rgbCss(limbColor(j)));
const JOINT_CSS = OPENPOSE_COLORS.map((_, i) => rgbCss(jointColor(i)));

// One scratch for every thumbnail: projection runs synchronously, so sharing is safe and allocation-free.
const scratch = createProjectScratch();
let basisKey = '';
let basis: CameraBasis | null = null;

function basisFor(s: UndoableState): CameraBasis {
  const key = `${s.direction}|${s.pitchDeg}`;
  if (!basis || key !== basisKey) {
    basis = cameraBasis(s.direction, s.pitchDeg);
    basisKey = key;
  }
  return basis;
}

/** The 18 keypoints PixelLab would receive for `pose` with the doc's camera, projection, rig and canvas (no hysteresis). */
export function thumbKeypoints(pose: Readonly<Pose>, s: UndoableState): Keypoint[] {
  const ctx = { basis: basisFor(s), projection: s.projection, canvas: { width: s.reference.width, height: s.reference.height }, sendDepth: false };
  return projectPose(pose, s.rig, ctx, undefined, scratch).keypoints;
}

/** Like thumbKeypoints, for the raw points of a COCO edit drag (before the doc recalibrates). */
export const thumbCocoKeypoints = (coco: readonly Vec3[], s: UndoableState): Keypoint[] => projectCocoForDisplay(s, coco).keypoints;

export interface ThumbInput {
  /** Thumbnail size in CSS px (the canvas aspect). */
  width: number;
  height: number;
  /** The frame (or reference) image; drawn over the whole canvas without smoothing. */
  image: CanvasImageSource | null;
  /** 1 for the frame's own image, lower for a reference ghost. */
  imageAlpha: number;
  keypoints: readonly Keypoint[] | null;
  /** "REF" or the frame number, top-left. */
  label: string;
}

/** Draw a thumbnail at devicePixelRatio (the backing store is resized when needed). */
export function drawThumb(canvas: HTMLCanvasElement, o: ThumbInput, dpr = window.devicePixelRatio || 1): void {
  const pw = Math.max(1, Math.round(o.width * dpr));
  const ph = Math.max(1, Math.round(o.height * dpr));
  if (canvas.width !== pw)
    canvas.width = pw;
  if (canvas.height !== ph)
    canvas.height = ph;
  const ctx = canvas.getContext('2d');
  if (!ctx)
    return;
  const w = o.width;
  const h = o.height;
  ctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);
  if (o.image) {
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = o.imageAlpha;
    ctx.drawImage(o.image, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  if (o.keypoints)
    drawKeypoints(ctx, o.keypoints, w, h);
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.strokeText(o.label, 4, 3);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(o.label, 4, 3);
}

/** Thin, slightly translucent limbs and small joints: the sprite under them must stay readable. */
function drawKeypoints(ctx: CanvasRenderingContext2D, kps: readonly Keypoint[], w: number, h: number): void {
  const stick = clamp(h / 80, 1, 2.25);
  ctx.lineCap = 'round';
  ctx.lineWidth = stick;
  ctx.globalAlpha = 0.7;
  for (let j = 0; j < COCO_LIMBS.length; j++) {
    const [a, b] = COCO_LIMBS[j];
    ctx.strokeStyle = LIMB_CSS[j];
    ctx.beginPath();
    ctx.moveTo(kps[a].x * w, kps[a].y * h);
    ctx.lineTo(kps[b].x * w, kps[b].y * h);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.95;
  const r = Math.max(1.25, stick * 1.1);
  for (let i = 0; i < kps.length; i++) {
    ctx.fillStyle = JOINT_CSS[i];
    ctx.beginPath();
    ctx.arc(kps[i].x * w, kps[i].y * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
