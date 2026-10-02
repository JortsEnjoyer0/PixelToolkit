// Pure copy-on-write helpers on UndoableState (used by the documents store, mockDoc, the testbed and producers).
// Every with*() returns a new state (or the same object when nothing changed) and never mutates its input.
import type { CameraView, Direction, KeypointOut } from '@shared/pixellab';
import type { FaceLabel, Pose } from '@shared/pose';
import { uid } from '@shared/uid';
import { UNDOABLE_KEYS, parseKeypointsOut, type AnimationMeta, type FrameData, type FrameTarget, type UndoableState, type Vec3 } from './model';
import { calibrate, forceNeck } from './rig/calibrate';
import { cocoFromPose } from './rig/fk';
import { faceWeightsFromEstimate, lift, type LiftReport } from './rig/lift';
import { clonePose } from './rig/poses';
import { cameraBasis, toCanvas } from './rig/projection';

/** The undoable part of a meta (shares references; freeze it before use as document state). */
export function stateFromMeta(meta: AnimationMeta): UndoableState {
  return Object.fromEntries(UNDOABLE_KEYS.map((k) => [k, meta[k]])) as unknown as UndoableState;
}

/** Full meta from document state plus the non-undoable fields (feed to serializeAnimation). Keys in file order. */
export function metaFromState(state: UndoableState, extra: { id: string; fps: number }): AnimationMeta {
  const s = state;
  return {
    version: 1, id: extra.id, source: 'manual',
    action: s.action, description: s.description, direction: s.direction, view: s.view, pitchDeg: s.pitchDeg,
    templateId: s.templateId, seed: s.seed, noBackground: s.noBackground, sendDepth: s.sendDepth, fps: extra.fps,
    reference: s.reference, rig: s.rig, projection: s.projection, frames: [...s.frames]
  };
}

export const sameTarget = (a: FrameTarget, b: FrameTarget): boolean =>
  a.kind === b.kind && (a.kind === 'ref' || a.uid === (b as { uid: string }).uid);

export const frameIndex = (state: UndoableState, uid: string): number => state.frames.findIndex((f) => f.uid === uid);

/** The pose shown for a target: reference.pose for REF, the frame pose otherwise; null if absent. */
export function targetPose(state: UndoableState, target: FrameTarget): Readonly<Pose> | null {
  if (target.kind === 'ref')
    return state.reference.pose;
  return state.frames.find((f) => f.uid === target.uid)?.pose ?? null;
}

/** Animation-owned image uids a state references (reference image + frame images), deduplicated. For GC live sets, renames, duplicates. */
export function referencedImages(state: UndoableState): string[] {
  const out = new Set<string>();
  if (state.reference.image)
    out.add(state.reference.image);
  for (const f of state.frames) {
    if (f.image)
      out.add(f.image);
  }
  return [...out];
}

/** A new track frame (fresh frame uid, no image) holding a copy of `pose`. */
export const newFrame = (pose: Readonly<Pose>): FrameData => ({ uid: uid(), pose: clonePose(pose), image: null, imageStale: false });

/**
 * New state with the target's pose replaced. A frame that has an image becomes imageStale. For REF, coco is
 * re-derived from the pose (FK) so reference.coco and reference.pose stay consistent. Unknown targets → unchanged.
 */
export function withTargetPose(state: UndoableState, target: FrameTarget, pose: Pose): UndoableState {
  if (target.kind === 'ref')
    return { ...state, reference: { ...state.reference, pose, coco: cocoFromPose(pose, state.rig) } };
  const i = frameIndex(state, target.uid);
  if (i < 0)
    return state;
  const frames = state.frames.slice();
  const f = frames[i];
  frames[i] = { ...f, pose, imageStale: f.image !== null };
  return { ...state, frames };
}

/** Hidden-face Kabsch weights from the stored 2D estimate (undefined without one → calibrate's default 1). */
function storedFaceWeights(state: UndoableState): Record<FaceLabel, number> | undefined {
  const { estimate, width, height } = state.reference;
  return estimate ? faceWeightsFromEstimate(estimate, { width, height }) : undefined;
}

/** The stored 2D estimate with each joint's x / y moved to where `pts` project with the current camera (z_index kept). */
function correctedEstimate(state: UndoableState, pts: readonly Vec3[]): KeypointOut[] | null {
  const { estimate, width, height } = state.reference;
  if (!estimate)
    return null;
  const basis = cameraBasis(state.direction, state.pitchDeg);
  return estimate.map((k, i) => {
    const [px, py] = toCanvas(pts[i], basis, state.projection);
    return { label: k.label, x: px / width, y: py / height, z_index: k.z_index };
  });
}

/**
 * COCO edit commit: NECK forced, recalibrated (replaces reference.pose and rig; frames keep their rotations). The
 * estimate follows the corrected 2D positions, so a later direction / view / pitch change re-lifts the corrected
 * alignment instead of restoring the original estimate (depth comes from the estimate's z_index layers again).
 */
export function withReferenceCoco(state: UndoableState, coco: readonly Vec3[]): UndoableState {
  const pts = forceNeck(coco);
  const prev = state.reference.pose ?? undefined;
  const { calib, pose } = calibrate(pts, { prevPose: prev, weights: storedFaceWeights(state) });
  return { ...state, rig: calib, reference: { ...state.reference, coco: pts, pose, estimate: correctedEstimate(state, pts) } };
}

/** New state with frames replaced (e.g. delete / clone / reorder producers build the array). */
export const withFrames = (state: UndoableState, frames: FrameData[]): UndoableState => ({ ...state, frames });

/** Diagnostics from a lift + calibrate run (log them; show warnings to the user). */
export interface EstimateReport { lift: LiftReport; calibrationResidual: number; warnings: string[] }

/** Lift `estimate` with the state's camera and canvas, calibrate, and install reference, rig and projection. */
function relift(state: UndoableState, estimate: readonly KeypointOut[]): { state: UndoableState; pose: Pose; report: EstimateReport } {
  const kps = parseKeypointsOut(estimate); // canonical order, plain {label, x, y, z_index} (drops unknown API keys)
  if (!kps)
    throw new Error('The estimate must contain each of the 18 labels exactly once');
  const { width, height } = state.reference;
  const lifted = lift({ estimate: kps, canvas: { width, height }, direction: state.direction, pitchDeg: state.pitchDeg });
  const cal = calibrate(lifted.coco, { weights: lifted.faceWeights, prevPose: state.reference.pose ?? undefined });
  const reference = { ...state.reference, estimate: kps, coco: forceNeck(lifted.coco), pose: cal.pose, needsEstimate: false };
  return {
    state: { ...state, reference, rig: cal.calib, projection: lifted.projection },
    pose: cal.pose,
    report: { lift: lifted.report, calibrationResidual: cal.residual, warnings: [...lifted.report.warnings, ...cal.warnings] }
  };
}

/**
 * "Estimate Skeleton" (PLAN §6): lift + calibrate the 2D estimate of the reference image and set reference, rig and
 * projection. When the track is empty or `resetFrames` (the confirm checkbox), frames = [a copy of the reference pose].
 * Throws unless the estimate has all 18 labels once.
 */
export function withEstimate(state: UndoableState, estimate: readonly KeypointOut[], opts: { resetFrames?: boolean } = {}): { state: UndoableState; report: EstimateReport } {
  const r = relift(state, estimate);
  const frames = opts.resetFrames || state.frames.length === 0 ? [newFrame(r.pose)] : state.frames;
  return { state: { ...r.state, frames }, report: r.report };
}

/**
 * Direction / view / pitch change (PLAN §4.5): one undo entry that re-lifts the reference from reference.estimate and
 * recalibrates; track frames keep their local rotations. Without an estimate only the camera fields change. The caller
 * picks the pitch (the panel resets it to VIEW_PITCH[view] when the view changes). Unchanged camera → same object.
 */
export function withCamera(state: UndoableState, cam: { direction?: Direction; view?: CameraView; pitchDeg?: number }): { state: UndoableState; report: EstimateReport | null } {
  const next = { ...state, direction: cam.direction ?? state.direction, view: cam.view ?? state.view, pitchDeg: cam.pitchDeg ?? state.pitchDeg };
  if (next.direction === state.direction && next.view === state.view && next.pitchDeg === state.pitchDeg)
    return { state, report: null };
  if (!state.reference.estimate)
    return { state: next, report: null };
  const r = relift(next, state.reference.estimate);
  return { state: r.state, report: r.report };
}

/**
 * A new reference image (picked base image copy or imported PNG). The old 2D estimate belongs to the old pixels, so it
 * is dropped and needsEstimate is set; the calibrated skeleton (coco, pose, rig, projection) stays until re-estimated.
 */
export function withReferenceImage(state: UndoableState, img: { image: string | null; sourceBaseUid: string | null; width: number; height: number }): UndoableState {
  const { image, sourceBaseUid, width, height } = img; // explicit: never leak extra keys (e.g. an ImportedImage) into the file
  return { ...state, reference: { ...state.reference, image, sourceBaseUid, width, height, estimate: null, needsEstimate: image !== null } };
}
