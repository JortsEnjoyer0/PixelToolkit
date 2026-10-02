<script setup lang="ts">
// The editor area (data-zone="editor"): EditorToolbar over the ONE EditorViewport of the app, which is mounted once and
// re-pointed at the active doc (setDocument) instead of being recreated per tab. The viewport and everything three.js
// stays out of Vue's reactivity (plain lets / Maps in setup); only small UI mirrors (display, selection, aligned)
// are refs. Wiring (PLAN §5 / §6):
// - DocSource over the active DocHandle: commits become doc.apply() undo entries, images load from ptk-asset URLs that
//   are resolved when requested (renames move the files);
// - per-doc camera memory in a non-reactive Map<docId, ViewState>; the viewport forgets a doc when it unloads;
// - playback.target(docId) drives setTarget; doc.version drives refresh();
// - 'interaction' → services/editorState (undo / autosave / job results respect drags) and the shortcut blocker;
//   'livePose' / 'liveCoco' → tools/skelanim/livePose.ts (the active thumbnail); 'displayChange' → toolbar + workspace
//   display; Settings > Editor defaults apply to the display when they change there;
// - a "stale image" badge while the shown frame's image predates its pose edits.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Focus, Undo2 } from '@lucide/vue';
import { assetUrl } from '@shared/api';
import { animImageRel } from '@shared/dataPaths';
import type { AppSettings } from '@shared/settings';
import IconButton from '../../../components/common/IconButton.vue';
import { withTargetPose } from '../../../core/docState';
import type { BoneName, FrameTarget, UndoableState } from '../../../core/model';
import { clonePose } from '../../../core/rig/poses';
import { EditorViewport } from '../../../editor/EditorViewport';
import type { DisplayOptions, DocSource, ViewState } from '../../../editor/types';
import { editorInteracting, registerEditorCancel } from '../../../services/editorState';
import { shortcuts } from '../../../services/shortcuts';
import { useDocumentsStore } from '../../../stores/documents';
import { usePlaybackStore } from '../../../stores/playback';
import { useSettingsStore } from '../../../stores/settings';
import { useWorkspaceStore } from '../../../stores/workspace';
import type { DocHandle } from '../../../stores/types';
import { clearLivePose, setLiveCoco, setLivePose } from '../livePose';
import { docSourceFromHandle } from './docSource';
import EditorToolbar from './EditorToolbar.vue';

const props = defineProps<{ doc: DocHandle | null }>();

const REF: FrameTarget = { kind: 'ref' };

const documents = useDocumentsStore();
const playback = usePlaybackStore();
const settings = useSettingsStore();
const workspace = useWorkspaceStore();

const viewportEl = ref<HTMLElement | null>(null);

// Non-reactive: the viewport (three.js), the per-doc DocSources and camera memory
let viewport: EditorViewport | null = null;
let shownDocId: string | null = null;
const sources = new Map<string, DocSource>();
const views = new Map<string, ViewState>();
const offs: (() => void)[] = [];

// Small reactive mirrors for the toolbar and the align button
const display = ref<DisplayOptions>({ ...workspace.state.display, cocoEdit: false });
const selectedBone = ref<BoneName | null>(null);
const aligned = ref(true);
const hasPrev = ref(false);

const target = computed<FrameTarget | null>(() => props.doc ? playback.target(props.doc.id) : null);
const isRef = computed(() => target.value?.kind !== 'frame');
const hasReference = computed(() => !!props.doc?.state.value.reference.pose && !!props.doc.state.value.reference.coco);
/** The shown track frame displays an image generated before its pose was edited. */
const imageStale = computed(() => {
  const t = target.value;
  if (!props.doc || t?.kind !== 'frame' || !display.value.showFrameImage)
    return false;
  const frame = props.doc.state.value.frames.find((f) => f.uid === t.uid);
  return !!frame?.image && frame.imageStale;
});

/** Aligned with a previous custom view: the button returns to it; aligned without one: nothing to do. */
const canReturn = computed(() => aligned.value && hasPrev.value);
const alignTip = computed(() => canReturn.value ? 'Return to previous view' : 'Align to projection plane');
const alignLabel = computed(() => {
  if (canReturn.value)
    return 'Previous view';
  return aligned.value ? 'Aligned' : 'Align';
});
const alignDisabled = computed(() => !props.doc || (aligned.value && !hasPrev.value));

/** The DocSource of a doc (one per doc; every getter reads the handle's current refs). */
function sourceFor(doc: DocHandle): DocSource {
  let src = sources.get(doc.id);
  if (!src) {
    src = docSourceFromHandle(doc, (uid) => assetUrl(animImageRel(doc.charRel.value, doc.name.value, uid)));
    sources.set(doc.id, src);
  }
  return src;
}

function syncCamera(): void {
  aligned.value = viewport?.isAligned() ?? true;
  hasPrev.value = viewport?.hasPreviousView() ?? false;
}

/** Mirror the viewport's display options and persist the toggles (COCO edit and Hips' move mode are transient). */
function syncDisplay(d: DisplayOptions): void {
  display.value = d;
  workspace.update({ display: { ...d, cocoEdit: false, gizmoMode: 'rotate' } });
}

/** Point the viewport at `doc` (null: nothing shown), keeping the outgoing doc's camera. */
function showDoc(doc: DocHandle | null): void {
  const vp = viewport;
  if (!vp)
    return;
  const prevId = shownDocId;
  const outgoing = vp.setDocument(doc ? sourceFor(doc) : null, doc ? views.get(doc.id) ?? null : null);
  if (prevId !== null && outgoing && documents.docs.has(prevId))
    views.set(prevId, outgoing);
  shownDocId = doc?.id ?? null;
  selectedBone.value = null;
  if (doc)
    vp.setTarget(playback.target(doc.id));
  syncCamera();
}

function setDisplay(patch: Partial<DisplayOptions>): void {
  const vp = viewport;
  if (!vp)
    return;
  const doc = props.doc;
  // COCO edit is REF only: entering it while a frame is shown jumps to REF first
  if (patch.cocoEdit && doc && target.value?.kind === 'frame') {
    playback.setTarget(doc.id, REF);
    vp.setTarget(REF);
  }
  vp.setDisplay(patch);
  syncDisplay(vp.getDisplay());
}

function toggleAlign(): void {
  viewport?.toggleAlign();
  syncCamera();
}

/** Reset the shown track frame to a copy of the reference pose (one undo entry; no-op when already equal). */
function resetPose(): void {
  const doc = props.doc;
  const t = target.value;
  if (!doc || !t || t.kind !== 'frame')
    return;
  viewport?.cancelInteraction();
  doc.apply('Reset Pose', (s: UndoableState) => {
    const refPose = s.reference.pose;
    const frame = s.frames.find((f) => f.uid === t.uid);
    if (!refPose || !frame || JSON.stringify(frame.pose) === JSON.stringify(refPose))
      return s;
    return withTargetPose(s, t, clonePose(refPose));
  });
}

function onInteraction(active: boolean): void {
  editorInteracting.value = active;
  shortcuts.setInteracting(active);
  if (active) {
    if (playback.playing)
      playback.pause();
  } else if (shownDocId !== null)
    clearLivePose(shownDocId);
}

/** Drop the camera memory and texture cache of docs that left the documents store (tab closed, deleted). */
function forgetGone(): void {
  for (const id of new Set([...sources.keys(), ...views.keys()])) {
    if (documents.docs.has(id))
      continue;
    viewport?.forgetDocument(id);
    if (shownDocId === id)
      shownDocId = null;
    sources.delete(id);
    views.delete(id);
    clearLivePose(id);
  }
}

watch(() => props.doc, (doc) => showDoc(doc));
watch(() => props.doc?.version.value, () => viewport?.refresh());
watch(target, (t) => {
  if (t && viewport)
    viewport.setTarget(t);
});
watch(() => settings.settings.editor.flySpeed, (v) => viewport?.setFlySpeed(v));
watch(() => [...documents.docs.keys()], forgetGone);

// The workspace file may finish loading after mount: adopt its toggles unless the user changed them meanwhile
let displayTouched = false;
void workspace.whenLoaded().then(() => {
  if (!displayTouched && viewport)
    setDisplay({ ...workspace.state.display, cocoEdit: false });
});

// Settings > Editor defaults changed there (the tool mounts after settings load): apply the changed ones now; the
// other toggles keep their toolbar state
const editorDefaults = (): Readonly<AppSettings['editor']> => settings.settings.editor; // a new snapshot per save
const defaultToggles = [() => editorDefaults().showFloor, () => editorDefaults().showFrameImage, () => editorDefaults().showCoco] as const;
watch(defaultToggles, ([floor, image, coco], [oldFloor, oldImage, oldCoco]) => {
  const patch: Partial<DisplayOptions> = {};
  if (floor !== oldFloor)
    patch.showFloor = floor;
  if (image !== oldImage)
    patch.showFrameImage = image;
  if (coco !== oldCoco)
    patch.showCoco = coco;
  displayTouched = true;
  setDisplay(patch);
});

onMounted(() => {
  const vp = new EditorViewport();
  vp.mount(viewportEl.value!);
  viewport = vp;
  registerEditorCancel(() => vp.cancelInteraction());
  vp.setFlySpeed(settings.settings.editor.flySpeed);
  vp.setDisplay(display.value);
  offs.push(
    vp.on('select', (bone) => {
      selectedBone.value = bone;
    }),
    vp.on('alignedChange', syncCamera),
    vp.on('interaction', onInteraction),
    vp.on('displayChange', syncDisplay),
    vp.on('livePose', (t, pose) => {
      if (shownDocId !== null)
        setLivePose(shownDocId, t, pose);
    }),
    vp.on('liveCoco', (coco) => {
      if (shownDocId !== null)
        setLiveCoco(shownDocId, coco);
    })
  );
  showDoc(props.doc);
  if (import.meta.env.DEV)
    Object.assign(window, { __editorViewport: vp }); // automation hook (dev only)
});

function teardown(): void {
  for (const off of offs.splice(0))
    off();
  registerEditorCancel(null);
  if (editorInteracting.value) {
    editorInteracting.value = false;
    shortcuts.setInteracting(false);
  }
  clearLivePose();
  if (import.meta.env.DEV)
    Object.assign(window, { __editorViewport: null });
  viewport?.dispose();
  viewport = null;
  shownDocId = null;
}

onBeforeUnmount(teardown);

// SFC reloads unmount the component (teardown above) and editor/ module edits dispose their viewports themselves;
// this only catches an update that detached the container while the component stayed mounted
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    setTimeout(() => {
      if (viewport && !viewportEl.value?.isConnected)
        teardown();
    });
  });
}

function onToolbarSet(patch: Partial<DisplayOptions>): void {
  displayTouched = true;
  setDisplay(patch);
}
</script>

<template>
  <div
    class="editor-pane"
    data-zone="editor"
  >
    <EditorToolbar
      :display="display"
      :selected-bone="selectedBone"
      :is-ref="isRef"
      :has-reference="hasReference"
      @set="onToolbarSet"
      @reset-pose="resetPose"
    />
    <div class="editor-stage">
      <div
        ref="viewportEl"
        class="editor-viewport"
        aria-label="3D pose editor"
      />
      <div class="editor-overlay editor-overlay-tr">
        <span
          v-if="imageStale"
          v-tooltip="'The pose was edited after this image was generated; Generate again to update it'"
          class="badge badge-warning editor-stale"
        >Stale image</span>
        <IconButton
          class="editor-align"
          :icon="canReturn ? Undo2 : Focus"
          :tooltip="alignTip"
          :label="alignLabel"
          tooltip-placement="bottom"
          variant="default"
          size="sm"
          :disabled="alignDisabled"
          @click="toggleAlign"
        />
      </div>
      <div class="editor-overlay editor-overlay-bl">
        LMB orbit · MMB pan · Wheel zoom · W/S A/D Space/C fly (Shift faster) · Click a joint to rotate · Click Hips again to move · Esc cancels a drag
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}

.editor-stage {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}

.editor-viewport {
  position: absolute;
  inset: 0;
  background: var(--bg-0);
  outline: none;
}

.editor-viewport:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent-dim);
}

.editor-overlay {
  position: absolute;
  pointer-events: none;
}

.editor-overlay > * {
  pointer-events: auto;
}

.editor-overlay-tr {
  top: var(--space-2);
  right: var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.editor-overlay-bl {
  left: var(--space-2);
  right: var(--space-2);
  bottom: var(--space-1);
  overflow: hidden;
  color: var(--text-faint);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.editor-align {
  background: color-mix(in srgb, var(--bg-2) 85%, transparent);
  backdrop-filter: blur(4px);
}

.editor-stale {
  background: var(--warning-bg);
}
</style>
