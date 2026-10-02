// The editor's scratch pose during a drag (rAF-throttled). EditorPane writes it from the viewport 'livePose' event
// (gizmo drags) or 'liveCoco' event (COCO edit drags on REF, before the doc recalibrates) and clears it on interaction
// end; FrameThumb of the matching doc + target draws it instead of the committed pose.
import { shallowRef } from 'vue';
import { sameTarget } from '../../core/docState';
import type { FrameTarget, Pose, Vec3 } from '../../core/model';

/** `pose` during a gizmo drag; `coco` (the 18 dragged points, pose null) during a COCO edit drag. */
export interface LivePose { docId: string; target: FrameTarget; pose: Pose | null; coco?: Vec3[] }

export const livePose = shallowRef<LivePose | null>(null);

/** Publish the scratch pose (a new wrapper each call, so watchers fire even when `pose` is the same mutated object). */
export function setLivePose(docId: string, target: FrameTarget, pose: Pose): void {
  livePose.value = { docId, target, pose };
}

/** Publish the COCO edit drag points (REF only; `coco` is the viewport's copy). */
export function setLiveCoco(docId: string, coco: Vec3[]): void {
  livePose.value = { docId, target: { kind: 'ref' }, pose: null, coco };
}

/** Drop the live pose (interaction ended or was cancelled); with `docId`, only when it belongs to that doc. */
export function clearLivePose(docId?: string): void {
  if (livePose.value && (docId === undefined || livePose.value.docId === docId))
    livePose.value = null;
}

/** `lp` is the live pose of this doc + target. */
export const isLiveFor = (lp: LivePose | null, docId: string, target: FrameTarget): lp is LivePose =>
  !!lp && lp.docId === docId && sameTarget(lp.target, target);
