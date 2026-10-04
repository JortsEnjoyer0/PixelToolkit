<script setup lang="ts">
// Img to PixelArt tool (docs/img2pixel/img2pixel.md "UI"): the control panel (fixed width, data-zone="img2pixel-panel")
// opens with the sub-tool select ("Tool"), followed by the active sub-tool's panel; the sub-tool's stage fills the rest
// (data-zone="img2pixel-stage"). The active sub-tool is persisted in the workspace (img2pixel.subtool). Sub-tools are
// registered in subtools.ts and keep their state in stores.
import { computed } from 'vue';
import Select from '../../components/common/Select.vue';
import { useWorkspaceStore } from '../../stores/workspace';
import { SUBTOOLS, findSubtool } from './subtools';

const workspace = useWorkspaceStore();

const SUBTOOL_OPTIONS = SUBTOOLS.map((s) => ({ value: s.id, label: s.label }));

const sub = computed(() => findSubtool(workspace.state.img2pixel.subtool));

function setSubtool(subtool: string): void {
  workspace.update({ img2pixel: { ...workspace.state.img2pixel, subtool } });
}
</script>

<template>
  <div class="img2pixel">
    <aside
      class="panel control-panel"
      data-zone="img2pixel-panel"
      aria-label="Img to PixelArt settings"
    >
      <div class="img2pixel-subtool field">
        <span class="field-label">Tool</span>
        <Select
          :model-value="sub.id"
          :options="SUBTOOL_OPTIONS"
          label="Tool"
          @update:model-value="setSubtool"
        />
      </div>
      <component
        :is="sub.panel"
        :key="sub.id"
      />
    </aside>
    <div
      class="img2pixel-stage"
      data-zone="img2pixel-stage"
    >
      <component
        :is="sub.stage"
        :key="sub.id"
      />
    </div>
  </div>
</template>

<style scoped>
.img2pixel {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.img2pixel-subtool {
  flex: 0 0 auto;
  padding: var(--space-3);
  border-bottom: 1px solid var(--border);
}

/* A flex column: the stage component fills it (flex: 1 or 100% height) */
.img2pixel-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
</style>
