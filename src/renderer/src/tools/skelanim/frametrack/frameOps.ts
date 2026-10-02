// Frame-track edits as undo entries ('Add Frame', 'Clone Frame', 'Delete Frame'), built from the docState producers.
// Each returns the target to select afterwards (null when nothing changed). Shared by the strip, its toolbar and keys.
import { frameIndex, newFrame, withFrames } from '../../../core/docState';
import type { FrameTarget, Pose, UndoableState } from '../../../core/model';
import { idlePose } from '../../../core/rig/poses';
import type { DocHandle } from '../../../stores/types';

export const REF_TARGET: FrameTarget = Object.freeze({ kind: 'ref' }) as FrameTarget;

export const frameTarget = (uid: string): FrameTarget => ({ kind: 'frame', uid });

/** What '+' appends: the last frame's pose, else the reference pose, else the idle pose for the doc's rig. */
export function appendPose(s: UndoableState): Readonly<Pose> {
  const last = s.frames[s.frames.length - 1];
  return last?.pose ?? s.reference.pose ?? idlePose(s.rig);
}

/** Clone needs a source: an existing frame, or a reference that has a pose. */
export function canClone(s: UndoableState, target: FrameTarget): boolean {
  return target.kind === 'ref' ? s.reference.pose !== null : frameIndex(s, target.uid) >= 0;
}

/** Runs `label` as one undo entry; the producer reports the target to select through `out`. */
function edit(doc: DocHandle, label: string, producer: (s: UndoableState, out: { target: FrameTarget | null }) => UndoableState): FrameTarget | null {
  const out: { target: FrameTarget | null } = { target: null };
  doc.apply(label, (s) => producer(s, out));
  return out.target;
}

export function addFrame(doc: DocHandle): FrameTarget | null {
  return edit(doc, 'Add Frame', (s, out) => {
    const frame = newFrame(appendPose(s));
    out.target = frameTarget(frame.uid);
    return withFrames(s, [...s.frames, frame]);
  });
}

/** Frame: a copy inserted right after it. REF: a copy of the reference pose inserted as frame 1. */
export function cloneTarget(doc: DocHandle, target: FrameTarget): FrameTarget | null {
  return edit(doc, 'Clone Frame', (s, out) => {
    const at = target.kind === 'ref' ? 0 : frameIndex(s, target.uid) + 1;
    const pose = target.kind === 'ref' ? s.reference.pose : s.frames[at - 1]?.pose;
    if (!pose)
      return s;
    const frame = newFrame(pose);
    const frames = s.frames.slice();
    frames.splice(at, 0, frame);
    out.target = frameTarget(frame.uid);
    return withFrames(s, frames);
  });
}

/** Removes the frame; returns its successor (or predecessor, or REF) to select. */
export function deleteFrame(doc: DocHandle, uid: string): FrameTarget | null {
  return edit(doc, 'Delete Frame', (s, out) => {
    const i = frameIndex(s, uid);
    if (i < 0)
      return s;
    const frames = s.frames.filter((f) => f.uid !== uid);
    const neighbour = frames[Math.min(i, frames.length - 1)];
    out.target = neighbour ? frameTarget(neighbour.uid) : REF_TARGET;
    return withFrames(s, frames);
  });
}
