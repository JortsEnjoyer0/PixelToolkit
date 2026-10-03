// Pure helpers for applying a completed generation job (docs/skelanim/skelanim.md "Estimate and generation flow"): the
// "Generate" producer that replaces the track with the submitted poses plus the result images, and the checks around
// it. Framework-free.
import type { SubmittedSnapshot } from '@shared/jobs';
import { uid } from '@shared/uid';
import { parsePose, type FrameData, type Pose, type UndoableState } from '../../core/model';
import { withFrames } from '../../core/docState';

/** Pose equality tolerance: snapshots pass through IPC and the journal, saved docs are rounded to 6 decimals. */
const POSE_EPS = 1e-5;

/**
 * "Generate" producer: the track becomes one frame per submitted snapshot frame, in order, with the snapshot pose, the
 * result image `imageUids[i]`, a fresh frame uid and imageStale false. Everything else in the state is kept.
 * Throws when the lengths differ (a malformed record must never produce a partial track).
 */
export function withJobResult(state: UndoableState, snapshot: SubmittedSnapshot, imageUids: readonly string[]): UndoableState {
  if (snapshot.frames.length !== imageUids.length)
    throw new Error(`The job has ${imageUids.length} images for ${snapshot.frames.length} submitted frames`);
  const used = new Set<string>();
  const frames: FrameData[] = snapshot.frames.map((f, i) => {
    let id = uid();
    while (used.has(id))
      id = uid();
    used.add(id);
    // parsePose: the snapshot comes back from the journal (untrusted json); missing bones read as identity
    return { uid: id, pose: parsePose(f.pose), image: imageUids[i], imageStale: false };
  });
  return withFrames(state, frames);
}

/** The track already holds exactly these result images in order (a re-run after a crash between apply and ack). */
export const hasJobResult = (state: UndoableState, imageUids: readonly string[]): boolean =>
  state.frames.length === imageUids.length && state.frames.every((f, i) => f.image === imageUids[i]);

function samePose(a: Readonly<Pose>, b: Readonly<Pose>): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.root[i] - b.root[i]) > POSE_EPS)
      return false;
  }
  for (const bone of Object.keys(a.rot) as (keyof Pose['rot'])[]) {
    const qa = a.rot[bone];
    const qb = b.rot[bone];
    if (!qb)
      return false;
    for (let i = 0; i < 4; i++) {
      if (Math.abs(qa[i] - qb[i]) > POSE_EPS)
        return false;
    }
  }
  return true;
}

/** What changed in the doc since the job was submitted (the result toast mentions it). */
export interface SnapshotChanges {
  /** Frames were added, removed, reordered or re-posed. */
  track: boolean;
  /** Direction, view or pitch differ: the images were drawn for the submitted camera. */
  camera: boolean;
}

export function snapshotChanges(state: UndoableState, snapshot: SubmittedSnapshot): SnapshotChanges {
  const sf = snapshot.frames;
  const track = state.frames.length !== sf.length
    || state.frames.some((f, i) => f.uid !== sf[i].uid || !samePose(f.pose, sf[i].pose));
  const camera = state.direction !== snapshot.direction || state.view !== snapshot.view
    || Math.abs(state.pitchDeg - snapshot.pitchDeg) > 1e-6;
  return { track, camera };
}

/** The result toast's message ('' when nothing changed). `undoable`: the doc stays open, so Undo restores the old track. */
export function changesMessage(changes: SnapshotChanges, undoable: boolean): string {
  const parts: string[] = [];
  if (changes.track)
    parts.push(undoable
      ? 'The track was edited after submitting; it was replaced by the generated frames (Undo restores it).'
      : 'The track was edited after submitting; it was replaced by the generated frames.');
  if (changes.camera)
    parts.push('The direction or view changed after submitting; the images match the submitted camera.');
  return parts.join(' ');
}
