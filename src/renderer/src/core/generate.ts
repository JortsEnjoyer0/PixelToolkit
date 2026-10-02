// Generate (PLAN §6 / §7): preflight checks and the animate-with-skeleton-v3 request built from document state.
// Pure: the panel uses generationProblems() for its status line and generationWarnings() in its confirm dialog, the
// jobs store uses buildGeneration() and adds refImageRel + frameUids for api.jobs.submitAnimate().
import { MAX_ACTION_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_FRAMES, MIN_FRAMES, type AnimateV3Request } from '@shared/pixellab';
import type { SubmittedSnapshot } from '@shared/jobs';
import type { BaseImage, UndoableState } from './model';
import { clonePose } from './rig/poses';
import { cameraBasis, projectPoseSequence } from './rig/projection';

/** The animation's description, or the character's when the animation leaves it empty (trimmed). */
export const effectiveDescription = (state: UndoableState, characterDescription: string): string =>
  (state.description.trim() !== '' ? state.description : characterDescription).trim();

/** User-facing reasons Generate cannot run yet (PLAN §6 preflight); empty when ready. */
export function generationProblems(state: UndoableState, characterDescription: string, opts: { hasApiKey: boolean }): string[] {
  const problems: string[] = [];
  const n = state.frames.length;
  if (n < MIN_FRAMES || n > MAX_FRAMES)
    problems.push(`The track needs ${MIN_FRAMES} to ${MAX_FRAMES} frames (it has ${n})`);
  if (!state.reference.image)
    problems.push('Pick a reference image');
  else if (!state.reference.pose)
    problems.push('Estimate the reference skeleton');
  const action = state.action.trim();
  if (action === '')
    problems.push('Enter an action');
  else if (action.length > MAX_ACTION_LENGTH)
    problems.push(`The action is longer than ${MAX_ACTION_LENGTH} characters`);
  const description = effectiveDescription(state, characterDescription);
  if (description === '')
    problems.push('Enter a description (or set the character\'s description)');
  else if (description.length > MAX_DESCRIPTION_LENGTH)
    problems.push(`The description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  if (!opts.hasApiKey)
    problems.push('Set the PixelLab API key in Settings');
  return problems;
}

/**
 * Soft warnings for the cost confirm (Generate still runs, PLAN §6 keeps the skeleton on a new image): the skeleton was
 * estimated for another reference image, or the reference's base image faces another direction than the animation.
 */
export function generationWarnings(state: UndoableState, baseImages: readonly Pick<BaseImage, 'uid' | 'direction'>[]): string[] {
  const out: string[] = [];
  const ref = state.reference;
  if (ref.needsEstimate)
    out.push('The reference image changed since the last estimate, so the first-frame keypoints still come from the previous skeleton. Estimate the skeleton again for a closer match.');
  const base = ref.sourceBaseUid === null ? undefined : baseImages.find((b) => b.uid === ref.sourceBaseUid);
  if (base?.direction && base.direction !== state.direction)
    out.push(`The reference base image faces ${base.direction}, but the animation direction is ${state.direction}.`);
  return out;
}

export interface GenerationPlan {
  /** Wire body minus first_frame (main adds it from the reference PNG). */
  request: AnimateV3Request;
  /** What was submitted (plain data); the result rebuilds the track from it. */
  snapshot: SubmittedSnapshot;
  /** Some joint fell outside the canvas and was clamped (warn before spending). */
  clamped: boolean;
}

/**
 * first_frame_keypoints = project(reference pose), keypoints = project(frames 1..N) in one hysteresis pass.
 * Throws when the reference has no pose; run generationProblems() first.
 */
export function buildGeneration(state: UndoableState, characterDescription: string): GenerationPlan {
  const ref = state.reference;
  if (!ref.pose)
    throw new Error('buildGeneration: the reference has no pose');
  const results = projectPoseSequence([ref.pose, ...state.frames.map((f) => f.pose)], state.rig, {
    basis: cameraBasis(state.direction, state.pitchDeg),
    projection: state.projection,
    canvas: { width: ref.width, height: ref.height },
    sendDepth: state.sendDepth
  });
  const request: AnimateV3Request = {
    description: effectiveDescription(state, characterDescription),
    action: state.action.trim(),
    direction: state.direction,
    view: state.view,
    first_frame_keypoints: results[0].keypoints,
    keypoints: results.slice(1).map((r) => r.keypoints),
    template_id: state.templateId,
    seed: Math.max(0, Math.floor(state.seed)),
    no_background: state.noBackground
  };
  const snapshot: SubmittedSnapshot = {
    frames: state.frames.map((f) => ({ uid: f.uid, pose: clonePose(f.pose) })), // plain copies: safe to send over IPC
    direction: state.direction,
    view: state.view,
    pitchDeg: state.pitchDeg
  };
  return { request, snapshot, clamped: results.some((r) => r.clamped) };
}
