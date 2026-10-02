// Bridge between the single EditorViewport (EditorPane registers itself here) and the stores that must respect an
// in-progress drag: undo/redo and job results cancel it first, autosave waits for it to end.
import { ref, watch } from 'vue';

/** True while a gizmo or COCO drag is running in the editor. Set by EditorPane from the viewport 'interaction' event. */
export const editorInteracting = ref(false);

/** Resolves once no editor drag is running (immediately when idle). Autosave waits on it. */
export function whenEditorIdle(): Promise<void> {
  if (!editorInteracting.value)
    return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(editorInteracting, (active) => {
      if (active)
        return;
      stop();
      resolve();
    });
  });
}

let cancelFn: (() => void) | null = null;

/** EditorPane registers viewport.cancelInteraction (null on unmount). */
export function registerEditorCancel(fn: (() => void) | null): void {
  cancelFn = fn;
}

/** Abort any editor drag (call before undo, redo, applying a job result, or swapping docs). */
export function cancelEditorInteraction(): void {
  if (cancelFn)
    cancelFn();
}
