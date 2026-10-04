// Opens the Rectify To Grid output preview (RectifyPreviewDialog.vue) as a custom modal; RectifyPanel's "Rectify Image".
import { markRaw } from 'vue';
import type { RectifyResult } from '../../../core/pixelart/rectify';
import { dialogs } from '../../../services/dialogs';
import RectifyPreviewDialog from './RectifyPreviewDialog.vue';

/** Resolves when the dialog closes (saving happens inside it; it stays open after a save). */
export async function openRectifyPreview(result: RectifyResult, sourceName: string): Promise<void> {
  await dialogs.open(RectifyPreviewDialog, { result: markRaw(result), sourceName });
}
