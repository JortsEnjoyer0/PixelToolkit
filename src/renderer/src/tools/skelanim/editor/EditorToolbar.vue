<script setup lang="ts">
// Editor toolbar (PLAN §6 Editor): display toggles (floor, frame image, OpenPose overlay, rig skeleton, ghost frames with
// their count and colour), OpenPose (COCO) point edit (REF only), gizmo mode (Move only applies to Hips) and space, ortho /
// perspective, and Reset pose to the reference (undoable). Pure view: EditorPane owns the viewport and applies the
// emitted changes.
import { computed } from 'vue';
import { Bone, Box, Ghost, Globe, Grid3x3, Image, Move3d, Orbit, PenLine, Rotate3d, RotateCcw, Spline, Square } from '@lucide/vue';
import IconButton from '../../../components/common/IconButton.vue';
import NumberSlider from '../../../components/common/NumberSlider.vue';
import Toolbar from '../../../components/common/Toolbar.vue';
import ToolbarSeparator from '../../../components/common/ToolbarSeparator.vue';
import ToolbarSpacer from '../../../components/common/ToolbarSpacer.vue';
import type { BoneName } from '../../../core/model';
import { HUMAN_NAMES } from '../../../core/rig/rigDef';
import { GHOST_COUNT_MAX, type DisplayOptions } from '../../../editor/types';

const props = defineProps<{
  display: DisplayOptions;
  selectedBone: BoneName | null;
  /** The REF slot is shown (COCO edit applies to it; Reset pose does not). */
  isRef: boolean;
  /** The reference has a calibrated skeleton (COCO points to edit, a pose to reset to). */
  hasReference: boolean;
}>();

const emit = defineEmits<{ set: [patch: Partial<DisplayOptions>]; resetPose: [] }>();

const hipsSelected = computed(() => props.selectedBone === 'Hips');
const moving = computed(() => hipsSelected.value && props.display.gizmoMode === 'translate');
const world = computed(() => props.display.gizmoSpace === 'world');

const cocoEditTip = computed(() => {
  if (!props.hasReference)
    return 'Edit OpenPose points (estimate the reference skeleton first)';
  return props.display.cocoEdit ? 'Stop editing OpenPose points' : 'Edit the reference OpenPose points (switches to REF; Alt-drag moves in depth)';
});
const moveTip = computed(() => hipsSelected.value ? 'Move (Hips)' : 'Move (select the Hips anchor first)');
const resetTip = computed(() => {
  if (!props.hasReference)
    return 'Reset pose to the reference (estimate the reference skeleton first)';
  return props.isRef ? 'Reset pose to the reference (select a track frame)' : 'Reset this frame\'s pose to the reference pose';
});
const selectionText = computed(() => {
  if (props.display.cocoEdit)
    return 'OpenPose edit: drag a point';
  const b = props.selectedBone;
  if (!b)
    return '';
  return `${HUMAN_NAMES[b]}${b === 'Hips' ? ` · ${moving.value ? 'move' : 'rotate'}` : ''}`;
});

const setGhostColor = (e: Event): void => {
  emit('set', { ghostColor: (e.target as HTMLInputElement).value });
};

const toggle = (key: 'showFloor' | 'showFrameImage' | 'showCoco' | 'showSkeleton' | 'showGhosts' | 'cocoEdit' | 'ortho'): void => {
  emit('set', { [key]: !props.display[key] });
};
</script>

<template>
  <Toolbar
    label="Editor"
    class="editor-toolbar"
  >
    <IconButton
      :icon="Grid3x3"
      tooltip="Floor"
      :active="display.showFloor"
      @click="toggle('showFloor')"
    />
    <IconButton
      :icon="Image"
      tooltip="Frame image on the projection plane"
      :active="display.showFrameImage"
      @click="toggle('showFrameImage')"
    />
    <IconButton
      :icon="Spline"
      tooltip="OpenPose overlay"
      :active="display.showCoco"
      @click="toggle('showCoco')"
    />
    <IconButton
      :icon="Bone"
      :tooltip="'Skeleton visibility'"
      :active="display.showSkeleton"
      @click="toggle('showSkeleton')"
    />
    <IconButton
      :icon="Ghost"
      tooltip="Ghost frames: show the previous N frames (onion skin)"
      :active="display.showGhosts"
      @click="toggle('showGhosts')"
    />
    <NumberSlider
      v-tooltip="'Number of ghost frames'"
      class="editor-ghost-count shrink-0"
      :model-value="display.ghostCount"
      :min="0"
      :max="GHOST_COUNT_MAX"
      :slider="false"
      :input-width="44"
      wheel
      size="sm"
      label="Number of ghost frames"
      @update:model-value="emit('set', { ghostCount: $event })"
    />
    <input
      v-tooltip="`Ghost color (${display.ghostColor})`"
      type="color"
      class="input-color editor-ghost-color"
      :value="display.ghostColor"
      aria-label="Ghost color"
      @input="setGhostColor"
    >
    <IconButton
      :icon="PenLine"
      :tooltip="cocoEditTip"
      :active="display.cocoEdit"
      :disabled="!hasReference && !display.cocoEdit"
      @click="toggle('cocoEdit')"
    />
    <ToolbarSeparator />
    <IconButton
      :icon="Rotate3d"
      tooltip="Rotate"
      :active="!moving && !display.cocoEdit"
      :disabled="display.cocoEdit"
      @click="emit('set', { gizmoMode: 'rotate' })"
    />
    <IconButton
      :icon="Move3d"
      :tooltip="moveTip"
      :active="moving && !display.cocoEdit"
      :disabled="!hipsSelected || display.cocoEdit"
      @click="emit('set', { gizmoMode: 'translate' })"
    />
    <IconButton
      :icon="world ? Globe : Box"
      :tooltip="world ? 'Gizmo space: world (click for local)' : 'Gizmo space: local (click for world)'"
      :active="world"
      :disabled="display.cocoEdit"
      @click="emit('set', { gizmoSpace: world ? 'local' : 'world' })"
    />
    <ToolbarSeparator />
    <IconButton
      :icon="display.ortho ? Square : Orbit"
      :tooltip="display.ortho ? 'Orthographic camera (click for perspective)' : 'Perspective camera (click for orthographic)'"
      :active="!display.ortho"
      @click="toggle('ortho')"
    />
    <ToolbarSeparator />
    <IconButton
      :icon="RotateCcw"
      :tooltip="resetTip"
      :disabled="isRef || !hasReference"
      @click="emit('resetPose')"
    />
    <ToolbarSpacer />
    <span
      v-if="selectionText"
      class="toolbar-label truncate"
    >{{ selectionText }}</span>
  </Toolbar>
</template>

<style scoped>
.editor-ghost-color {
  margin-right: var(--space-1);
}
</style>
