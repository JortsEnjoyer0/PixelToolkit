// Img to PixelArt sub-tool registry (docs/img2pixel/img2pixel.md): each sub-tool has a panel, shown in the control
// panel under the "Tool" select, and a stage that fills the display area. Img2PixelTool shows the one saved in the
// workspace (img2pixel.subtool). Sub-tools keep their state in stores, so switching unmounts them freely.
import { markRaw, type Component } from 'vue';
import RectifyPanel from './rectify/RectifyPanel.vue';
import RectifyStage from './rectify/RectifyStage.vue';

export interface SubtoolDef {
  id: string;
  label: string;
  /** Control-panel content below the sub-tool select: a flex column filling the rest of the panel. */
  panel: Component;
  /** The display area right of the panel; it fills Img2PixelTool's flex column tagged data-zone="img2pixel-stage". */
  stage: Component;
}

export const SUBTOOLS: readonly SubtoolDef[] = [
  { id: 'rectify', label: 'Rectify To Grid', panel: markRaw(RectifyPanel), stage: markRaw(RectifyStage) }
];

export const DEFAULT_SUBTOOL_ID = SUBTOOLS[0].id;

/** The sub-tool with `id` (falls back to the first one). */
export const findSubtool = (id: string): SubtoolDef => SUBTOOLS.find((s) => s.id === id) ?? SUBTOOLS[0];
