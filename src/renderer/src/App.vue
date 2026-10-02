<script setup lang="ts">
// App shell: NavBar + the active tool (kept alive), the global hosts (context menu, dialogs, toasts, mouse notes;
// the tooltip element is created by v-tooltip on first use), keyboard / focus-zone services, settings loading and
// the close handshake (services/lifecycle.ts). Tools mount once settings and the workspace are read, so their stores
// see real values; then the saved tabs reopen and the jobs store starts (startup()).
import { computed, onBeforeUnmount, ref } from 'vue';
import ContextMenuHost from './components/common/ContextMenuHost.vue';
import DialogHost from './components/common/DialogHost.vue';
import MouseNotifyHost from './components/common/MouseNotifyHost.vue';
import ToastHost from './components/common/ToastHost.vue';
import NavBar from './components/shell/NavBar.vue';
import { openSettings } from './components/shell/openSettings';
import { reportError } from './services/errors';
import { installFocusZone } from './services/focusZone';
import { installCloseHandshake } from './services/lifecycle';
import { installPointerTracking } from './services/mouseNotify';
import { installShortcuts, shortcuts } from './services/shortcuts';
import { initJobs } from './stores/jobs';
import { useSettingsStore } from './stores/settings';
import { installDocumentShortcuts, restoreWorkspace } from './stores/tabs';
import { useWorkspaceStore } from './stores/workspace';
import { DEFAULT_TOOL_ID, findTool } from './tools/registry';

installFocusZone();
installShortcuts();
installPointerTracking();

const settings = useSettingsStore();
const ready = ref(false);
const activeToolId = ref(DEFAULT_TOOL_ID);
const activeTool = computed(() => findTool(activeToolId.value));

/**
 * Startup order: settings → document stores (shortcuts, autosave, close handler) → workspace.json → mount the tool
 * (the explorer adopts the saved expansion) → reopen the saved tabs → jobs (results for reopened docs apply to their
 * tabs instead of headless).
 */
let stopDocKeys: (() => void) | null = null;

async function startup(): Promise<void> {
  try {
    await settings.load();
  } catch (e) {
    reportError(e, 'Could not read settings');
  }
  try {
    stopDocKeys = installDocumentShortcuts();
    await useWorkspaceStore().whenLoaded();
  } finally {
    ready.value = true;
  }
  await restoreWorkspace().catch((e: unknown) => reportError(e, 'Could not reopen the open tabs of the last session'));
  await initJobs().catch((e: unknown) => reportError(e, 'Could not load generation jobs'));
}

void startup();

const offClose = installCloseHandshake();
const offSettingsKey = shortcuts.register('global', 'ctrl+,', () => {
  void openSettings();
});

onBeforeUnmount(() => {
  offClose();
  offSettingsKey();
  stopDocKeys?.();
});
</script>

<template>
  <div class="app-shell">
    <NavBar v-model="activeToolId" />
    <main class="tool-space">
      <KeepAlive v-if="ready">
        <component
          :is="activeTool.component"
          :key="activeTool.id"
        />
      </KeepAlive>
    </main>
    <ContextMenuHost />
    <DialogHost />
    <ToastHost />
    <MouseNotifyHost />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-1);
}

.tool-space {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
</style>
