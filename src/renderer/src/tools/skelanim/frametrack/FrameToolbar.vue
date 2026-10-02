<script setup lang="ts">
// Frame-track toolbar: transport (seek / step / play-pause on the active doc via the playback store), fps (not
// undoable: doc.setFps), Clone / Delete of the active target, and the position readout.
import { computed } from 'vue';
import { Copy, Pause, Play, SkipBack, SkipForward, StepBack, StepForward, Trash2 } from '@lucide/vue';
import IconButton from '../../../components/common/IconButton.vue';
import NumberSlider from '../../../components/common/NumberSlider.vue';
import Toolbar from '../../../components/common/Toolbar.vue';
import ToolbarSeparator from '../../../components/common/ToolbarSeparator.vue';
import ToolbarSpacer from '../../../components/common/ToolbarSpacer.vue';
import { frameIndex } from '../../../core/docState';
import type { FrameTarget } from '../../../core/model';
import { usePlaybackStore } from '../../../stores/playback';
import type { DocHandle } from '../../../stores/types';
import { canClone, cloneTarget, deleteFrame } from './frameOps';

const props = defineProps<{ doc: DocHandle }>();

const playback = usePlaybackStore();

const frameCount = computed(() => props.doc.state.value.frames.length);
const target = computed(() => playback.target(props.doc.id));
const isRef = computed(() => target.value.kind === 'ref');
const cloneable = computed(() => canClone(props.doc.state.value, target.value));
const position = computed(() => {
  const t = target.value;
  const at = t.kind === 'ref' ? 'REF' : String(frameIndex(props.doc.state.value, t.uid) + 1);
  return `${at} / ${frameCount.value}`;
});

function select(t: FrameTarget | null): void {
  if (t)
    playback.setTarget(props.doc.id, t);
}

function clone(): void {
  select(cloneTarget(props.doc, target.value));
}

function remove(): void {
  const t = target.value;
  if (t.kind === 'frame')
    select(deleteFrame(props.doc, t.uid));
}

function setFps(v: number): void {
  props.doc.setFps(v);
}
</script>

<template>
  <Toolbar
    label="Frame track"
    class="frame-toolbar"
  >
    <IconButton
      :icon="SkipBack"
      tooltip="Seek start"
      @click="playback.seekStart()"
    />
    <IconButton
      :icon="StepBack"
      tooltip="Step back"
      shortcut="←"
      @click="playback.step(-1)"
    />
    <IconButton
      :icon="playback.playing ? Pause : Play"
      :tooltip="playback.playing ? 'Pause' : 'Play'"
      :active="playback.playing"
      :disabled="frameCount === 0"
      @click="playback.toggle()"
    />
    <IconButton
      :icon="StepForward"
      tooltip="Step forward"
      shortcut="→"
      @click="playback.step(1)"
    />
    <IconButton
      :icon="SkipForward"
      tooltip="Seek end"
      @click="playback.seekEnd()"
    />
    <ToolbarSeparator />
    <span class="toolbar-label">fps</span>
    <NumberSlider
      class="frame-toolbar-fps"
      :model-value="doc.fps.value"
      :min="1"
      :max="60"
      size="sm"
      label="Frames per second"
      @update:model-value="setFps"
    />
    <ToolbarSeparator />
    <IconButton
      :icon="Copy"
      :tooltip="isRef ? 'Clone the reference pose as frame 1' : 'Clone frame'"
      :disabled="!cloneable"
      @click="clone"
    />
    <IconButton
      :icon="Trash2"
      tooltip="Delete frame"
      shortcut="Del"
      danger-hover
      :disabled="isRef"
      @click="remove"
    />
    <ToolbarSpacer />
    <span class="toolbar-label tabular">{{ position }}</span>
  </Toolbar>
</template>

<style scoped>
/* The range gives way first when the toolbar is narrow (number field 64 px + gap + range minimum) */
.frame-toolbar-fps {
  flex: 0 1 150px;
  min-width: 120px;
}
</style>
