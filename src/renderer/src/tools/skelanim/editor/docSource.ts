// DocHandle → the editor's DocSource, shared by EditorPane and the testbed. Every getter reads the handle's current
// refs; commits become doc.apply() undo entries. `imageUrl` maps an image uid to a URL (the app resolves ptk-asset URLs
// per request, so renames that move the files are followed; the testbed passes fixture URLs).
import { withReferenceCoco, withTargetPose } from '../../../core/docState';
import type { FrameTarget, Pose } from '../../../core/model';
import type { DocSource } from '../../../editor/types';
import type { DocHandle } from '../../../stores/types';

export function docSourceFromHandle(doc: DocHandle, imageUrl: (uid: string) => string, onLivePose?: (target: FrameTarget, pose: Pose) => void): DocSource {
  return {
    id: doc.id,
    getState: () => doc.state.value,
    getVersion: () => doc.version.value,
    imageUrl,
    commitPose: (target, pose, label) => doc.apply(label, (s) => withTargetPose(s, target, pose)),
    commitCoco: (coco, label) => doc.apply(label, (s) => withReferenceCoco(s, coco)),
    onLivePose
  };
}
