// Tool registry: one entry per top-level tool, shown in the NavBar and kept alive in App.vue's tool space.
import { markRaw, type Component } from 'vue';
import { Bone, Grid3x3 } from '@lucide/vue';
import Img2PixelTool from './img2pixel/Img2PixelTool.vue';
import SkelAnimTool from './skelanim/SkelAnimTool.vue';

export interface ToolDef {
  id: string;
  label: string;
  /** Lucide icon component. */
  icon: Component;
  /** Root component of the tool (kept alive while another tool is shown). */
  component: Component;
}

/** Skel Anim's id: the document shortcuts (Ctrl+S / Z / Y) act only while it is the active tool (App.vue). */
export const SKELANIM_TOOL_ID = 'skelanim';

export const TOOLS: readonly ToolDef[] = [
  { id: SKELANIM_TOOL_ID, label: 'Skel Anim', icon: markRaw(Bone), component: markRaw(SkelAnimTool) },
  { id: 'img2pixel', label: 'Img to PixelArt', icon: markRaw(Grid3x3), component: markRaw(Img2PixelTool) }
];

export const DEFAULT_TOOL_ID = TOOLS[0].id;

/** The tool with `id` (falls back to the first tool). */
export const findTool = (id: string): ToolDef => TOOLS.find((t) => t.id === id) ?? TOOLS[0];
