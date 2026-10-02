// 2D frame preview, drawn the way a frame-track thumbnail would be: grey checker, the pixelated sprite, the COCO-18
// keypoints PixelLab receives in the pinned OpenPose palette, and the frame number in an outlined font.
import type { Keypoint } from '@shared/pixellab';
import { COCO_LIMBS, jointColor, limbColor, rgbCss } from '../core/rig/coco';

export interface PreviewOptions {
  /** CSS px of the square preview. */
  size: number;
  image: CanvasImageSource | null;
  /** 0..1 (a frame without its own image shows the reference ghosted). */
  imageAlpha: number;
  keypoints: readonly Keypoint[] | null;
  /** The PixelLab canvas (keypoint x / y are fractions of it); fitted into the square, centred. */
  canvasSize: { width: number; height: number };
  /** "REF" or the frame number. */
  label: string;
  stale: boolean;
}

const CHECKER_A = '#1b1f27';
const CHECKER_B = '#242a34';
const CHECKER_PX = 8;

export function drawFramePreview(canvas: HTMLCanvasElement, o: PreviewOptions): void {
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(o.size * dpr);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(0, 0, o.size, o.size);
  ctx.fillStyle = CHECKER_B;
  for (let y = 0; y < o.size; y += CHECKER_PX) {
    for (let x = (y / CHECKER_PX) % 2 === 0 ? CHECKER_PX : 0; x < o.size; x += CHECKER_PX * 2)
      ctx.fillRect(x, y, CHECKER_PX, CHECKER_PX);
  }
  const k = o.size / Math.max(o.canvasSize.width, o.canvasSize.height);
  const w = o.canvasSize.width * k;
  const h = o.canvasSize.height * k;
  const ox = (o.size - w) / 2;
  const oy = (o.size - h) / 2;
  if (o.image) {
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = o.imageAlpha;
    ctx.drawImage(o.image, ox, oy, w, h);
    ctx.globalAlpha = 1;
  }
  const kps = o.keypoints;
  if (kps) {
    const X = (i: number): number => ox + kps[i].x * w;
    const Y = (i: number): number => oy + kps[i].y * h;
    const stick = Math.max(1.5, o.size / 110);
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.85;
    COCO_LIMBS.forEach(([a, b], j) => {
      ctx.strokeStyle = rgbCss(limbColor(j));
      ctx.lineWidth = stick;
      ctx.beginPath();
      ctx.moveTo(X(a), Y(a));
      ctx.lineTo(X(b), Y(b));
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
    kps.forEach((_, i) => {
      ctx.fillStyle = rgbCss(jointColor(i));
      ctx.beginPath();
      ctx.arc(X(i), Y(i), stick * 1.4, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.font = '600 14px system-ui, "Segoe UI", sans-serif';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.strokeText(o.label, 6, 5);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(o.label, 6, 5);
  if (o.stale) {
    ctx.fillStyle = '#d9a03f';
    ctx.beginPath();
    ctx.arc(o.size - 9, 9, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
