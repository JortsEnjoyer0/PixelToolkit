<script setup lang="ts">
// Skel Anim tool (docs/skelanim/skelanim.md "UI"): Explorer (resizable, width persisted in the workspace) | right
// column: TabBar on top, below it the ControlPanel (fixed width) | EditorPane (toolbar + viewport) over the FrameTrack,
// with a horizontal splitter sizing the track's thumbnails. The editor area stays mounted while no tab is open
// (v-show), so the WebGL context is created once; a placeholder with hints covers it then.
import { computed, ref, watch } from 'vue';
import { Clapperboard } from '@lucide/vue';
import Splitter from '../../components/common/Splitter.vue';
import { useTabsStore } from '../../stores/tabs';
import { DEFAULT_EXPLORER_WIDTH, THUMB_HEIGHT, THUMB_HEIGHT_MAX, THUMB_HEIGHT_MIN, useWorkspaceStore } from '../../stores/workspace';
import EditorPane from './editor/EditorPane.vue';
import ExplorerPanel from './explorer/ExplorerPanel.vue';
import FrameTrack from './frametrack/FrameTrack.vue';
import ControlPanel from './panel/ControlPanel.vue';
import TabBar from './tabs/TabBar.vue';

const EXPLORER_MIN = 180;
const EXPLORER_MAX = 560;

const tabs = useTabsStore();
const workspace = useWorkspaceStore();

const doc = computed(() => tabs.activeDoc);

// ---------- explorer width ----------

const explorerWidth = ref(workspace.state.explorerWidth);
watch(() => workspace.state.explorerWidth, (w) => {
  explorerWidth.value = w;
});

function commitExplorerWidth(w: number): void {
  workspace.update({ explorerWidth: w });
}

// ---------- frame track height (thumbnail size, persisted in the workspace) ----------

const thumbHeight = ref(workspace.state.thumbHeight);
watch(() => workspace.state.thumbHeight, (h) => {
  thumbHeight.value = h;
});

function commitThumbHeight(h: number): void {
  workspace.update({ thumbHeight: h });
}
</script>

<template>
  <div class="skelanim">
    <div
      class="skelanim-explorer"
      :style="{ width: `${explorerWidth}px` }"
    >
      <ExplorerPanel />
    </div>
    <Splitter
      v-model:width="explorerWidth"
      :min="EXPLORER_MIN"
      :max="EXPLORER_MAX"
      :default-width="DEFAULT_EXPLORER_WIDTH"
      side="left"
      @commit="commitExplorerWidth"
    />
    <div class="skelanim-main">
      <TabBar />
      <div class="skelanim-body">
        <!-- Keyed by doc: a field still focused across a tab switch belongs to the old instance (its draft can never
             commit to the newly active doc) -->
        <ControlPanel
          v-if="doc"
          :key="doc.id"
          :doc="doc"
        />
        <div
          v-show="doc"
          class="skelanim-stage"
        >
          <EditorPane :doc="doc" />
          <template v-if="doc">
            <Splitter
              v-model:width="thumbHeight"
              :min="THUMB_HEIGHT_MIN"
              :max="THUMB_HEIGHT_MAX"
              :default-width="THUMB_HEIGHT"
              side="bottom"
              @commit="commitThumbHeight"
            />
            <FrameTrack
              :doc="doc"
              :thumb-height="thumbHeight"
            />
          </template>
        </div>
        <div
          v-if="!doc"
          class="empty-state skelanim-empty"
        >
          <Clapperboard
            class="skelanim-empty-icon"
            :size="48"
            :stroke-width="1.25"
          />
          <div class="empty-state-title">
            No animation open
          </div>
          <p class="skelanim-empty-text">
            Create a character in the explorer, import its base images, then create an animation.
            Click an animation to open it in a tab.
          </p>
          <ul class="skelanim-hints">
            <li><span class="kbd">Ctrl+S</span> Save</li>
            <li><span class="kbd">Ctrl+Z</span> <span class="kbd">Ctrl+Y</span> Undo / redo</li>
            <li><span class="kbd">←</span> <span class="kbd">→</span> Step frames</li>
            <li><span class="kbd">Del</span> Delete the selected item or frame</li>
            <li><span class="kbd">F2</span> Rename in the explorer</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skelanim {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

/* The splitters draw the dividing lines (no borders of their own, or the lines double up) */
.skelanim-explorer {
  display: flex;
  flex: 0 0 auto;
  min-width: 0;
  min-height: 0;
}

.skelanim-stage > .frame-track {
  border-top: 0;
}

.skelanim-main {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}

.skelanim-body {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}

.skelanim-stage {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}

.skelanim-empty {
  flex: 1 1 0;
  height: auto;
  background: radial-gradient(circle at 50% 40%, var(--bg-2) 0%, var(--bg-1) 65%);
}

.skelanim-empty-icon {
  color: var(--accent);
  opacity: 0.8;
}

.skelanim-empty-text {
  max-width: 380px;
}

.skelanim-hints {
  display: grid;
  gap: var(--space-1);
  margin-top: var(--space-3);
  list-style: none;
  text-align: left;
}

.skelanim-hints .kbd {
  margin-right: 2px;
}
</style>
