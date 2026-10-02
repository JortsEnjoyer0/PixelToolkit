// Tool registry: one entry per top-level tool, shown in the NavBar and kept alive in App.vue's tool space.
import { markRaw, type Component } from 'vue';
import { Bone } from '@lucide/vue';
import SkelAnimTool from './skelanim/SkelAnimTool.vue';

export interface ToolDef {
  id: string;
  label: string;
  /** Lucide icon component. */
  icon: Component;
  /** Root component of the tool (kept alive while another tool is shown). */
  component: Component;
}

export const TOOLS: readonly ToolDef[] = [
  { id: 'skelanim', label: 'Skel Anim', icon: markRaw(Bone), component: markRaw(SkelAnimTool) }
];

export const DEFAULT_TOOL_ID = TOOLS[0].id;

/** The tool with `id` (falls back to the first tool). */
export const findTool = (id: string): ToolDef => TOOLS.find((t) => t.id === id) ?? TOOLS[0];
