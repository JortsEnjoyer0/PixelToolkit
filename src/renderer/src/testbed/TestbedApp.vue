<script setup lang="ts">
// Testbed: drives the real EditorViewport and core/rig with the committed fixtures (no IPC, no PixelLab calls).
// Left: controls and readouts; right: the viewport with its align button overlay.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { CAMERA_VIEWS, VIEW_PITCH, type CameraView, type Direction } from '@shared/pixellab';
import type { BoneName, FrameTarget, Pose, UndoableState, Vec3 } from '../core/model';
import { frameIndex, newFrame, sameTarget, targetPose, withCamera, withEstimate, withFrames, withTargetPose, type EstimateReport } from '../core/docState';
import { SKELETON_LABELS } from '../core/rig/coco';
import { DEG, qFromAxisAngle, qMul } from '../core/rig/math';
import { clonePose } from '../core/rig/poses';
import { createProjectScratch, projectCocoForDisplay, projectPoseForDisplay, type DisplayProjection } from '../core/rig/projection';
import { EditorViewport } from '../editor/EditorViewport';
import { DEFAULT_DISPLAY, type DisplayOptions } from '../editor/types';
import { FIXTURES } from './fixtures';
import { drawFramePreview } from './preview2d';
import { buildFixtureDoc, type TestbedDoc } from './testbedDoc';

const PREVIEW_SIZE = 256;
const COMPASS: readonly (Direction | null)[] = ['north-west', 'north', 'north-east', 'west', null, 'east', 'south-west', 'south', 'south-east'];
const COMPASS_LABEL: Readonly<Record<Direction, string>> = {
  'north-west': 'NW', north: 'N', 'north-east': 'NE', west: 'W', east: 'E', 'south-west': 'SW', south: 'S', 'south-east': 'SE'
};
const TOGGLES: readonly { key: 'showFloor' | 'showFrameImage' | 'showCoco' | 'cocoEdit' | 'ortho'; label: string }[] = [
  { key: 'showFloor', label: 'Floor' },
  { key: 'showFrameImage', label: 'Frame image' },
  { key: 'showCoco', label: 'COCO-18 overlay' },
  { key: 'cocoEdit', label: 'COCO edit (REF only)' },
  { key: 'ortho', label: 'Orthographic' }
];

const viewportEl = ref<HTMLElement | null>(null);
const previewEl = ref<HTMLCanvasElement | null>(null);
/** Never reactive (three.js objects must stay out of Vue's proxies). */
let viewport: EditorViewport | null = null;
const offs: (() => void)[] = [];

const fixtureIndex = ref(0);
const tb = shallowRef<TestbedDoc | null>(null);
const target = ref<FrameTarget>({ kind: 'ref' });
const display = ref<DisplayOptions>({ ...DEFAULT_DISPLAY });
const selected = ref<BoneName | null>(null);
const aligned = ref(false);
const hasPrev = ref(false);
const interacting = ref(false);
const focused = ref(false);
const renderCount = ref(0);
const gizmoMode = ref<string>('none');
const status = ref('');
const report = shallowRef<EstimateReport | null>(null);
const livePose = shallowRef<Pose | null>(null);
/** COCO edit drag points (REF only) until the release recalibrates. */
const liveCoco = shallowRef<Vec3[] | null>(null);

const doc = computed(() => tb.value?.doc ?? null);
const state = computed<UndoableState | null>(() => doc.value?.state.value ?? null);
const version = computed(() => doc.value?.version.value ?? -1);
const frames = computed(() => state.value?.frames ?? []);
const canUndo = computed(() => version.value >= 0 && !!doc.value?.history.canUndo);
const canRedo = computed(() => version.value >= 0 && !!doc.value?.history.canRedo);
const isRef = computed(() => target.value.kind === 'ref');
const targetLabel = computed(() => {
  const t = target.value;
  return t.kind === 'ref' ? 'REF' : String(frameIndex(state.value!, t.uid) + 1);
});
const alignLabel = computed(() => aligned.value ? (hasPrev.value ? 'Return to previous view' : 'Aligned to plane') : 'Align to plane');

const projectScratch = createProjectScratch();
/** The 18 keypoints PixelLab would receive for the shown pose (single frame: no hysteresis). */
const projected = computed<DisplayProjection | null>(() => {
  const s = state.value;
  if (!s)
    return null;
  if (liveCoco.value && target.value.kind === 'ref')
    return projectCocoForDisplay(s, liveCoco.value);
  const pose = livePose.value ?? targetPose(s, target.value);
  return pose ? projectPoseForDisplay(s, pose, projectScratch) : null;
});

const keypointRows = computed(() => {
  const p = projected.value;
  if (!p)
    return [];
  return p.keypoints.map((k, i) => ({ label: SKELETON_LABELS[i], x: k.x, y: k.y, px: p.points[i][0], py: p.points[i][1], z: k.z_index }));
});

// ---------- documents ----------

function loadFixture(i: number): void {
  if (!viewport)
    return;
  const old = tb.value;
  const next = buildFixtureDoc(FIXTURES[i]);
  tb.value = next;
  report.value = next.report;
  target.value = { kind: 'ref' };
  livePose.value = null;
  liveCoco.value = null;
  viewport.setDocument(next.src);
  viewport.setTarget(target.value);
  if (old)
    viewport.forgetDocument(old.doc.id);
  syncFromViewport();
  status.value = `Loaded ${next.fixture.label}`;
}

function apply(label: string, producer: (s: UndoableState) => UndoableState, opts?: { mergeKey?: string; mergeMs?: number }): void {
  const d = doc.value;
  if (!d)
    return;
  viewport?.cancelInteraction();
  d.apply(label, producer, opts);
}

function setCamera(cam: { direction?: Direction; view?: CameraView; pitchDeg?: number }, merge?: string): void {
  apply('Change Camera', (s) => {
    const r = withCamera(s, cam);
    if (r.report)
      report.value = r.report;
    return r.state;
  }, merge ? { mergeKey: merge, mergeMs: 800 } : undefined);
}

function onView(e: Event): void {
  const view = (e.target as HTMLSelectElement).value as CameraView;
  setCamera({ view, pitchDeg: VIEW_PITCH[view] });
}

function onPitch(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(v))
    setCamera({ pitchDeg: Math.max(0, Math.min(89, v)) }, 'pitch');
}

function relift(): void {
  const fx = tb.value?.fixture;
  if (!fx)
    return;
  apply('Re-lift', (s) => {
    const r = withEstimate(s, fx.estimate.keypoints);
    report.value = r.report;
    return r.state;
  });
}

function addFrame(): void {
  const s = state.value;
  if (!s)
    return;
  const pose = targetPose(s, target.value) ?? s.reference.pose;
  if (!pose)
    return;
  const f = newFrame(pose);
  const at = target.value.kind === 'frame' ? frameIndex(s, target.value.uid) + 1 : 0;
  apply('Add Frame', (st) => withFrames(st, [...st.frames.slice(0, at), f, ...st.frames.slice(at)]));
  setTarget({ kind: 'frame', uid: f.uid });
}

function deleteFrame(): void {
  const t = target.value;
  const s = state.value;
  if (t.kind !== 'frame' || !s)
    return;
  const i = frameIndex(s, t.uid);
  apply('Delete Frame', (st) => withFrames(st, st.frames.filter((f) => f.uid !== t.uid)));
  const rest = state.value?.frames ?? [];
  setTarget(rest.length ? { kind: 'frame', uid: rest[Math.min(i, rest.length - 1)].uid } : { kind: 'ref' });
}

/** Bend the left elbow by 30° about its rest bend axis on the shown pose (programmatic edit → refresh path). */
function rotateTest(): void {
  const s = state.value;
  const t = target.value;
  const pose = s ? targetPose(s, t) : null;
  if (!pose)
    return;
  const next = clonePose(pose);
  next.rot.LeftLowerArm = qMul(pose.rot.LeftLowerArm, qFromAxisAngle([0, -1, 0], 30 * DEG));
  apply('Rotate Left Forearm', (st) => withTargetPose(st, t, next));
}

function undo(): void {
  const d = doc.value;
  if (!d || viewport?.isInteracting())
    return;
  viewport?.cancelInteraction();
  const label = d.undo();
  status.value = label ? `Undo ${label}` : 'Nothing to undo';
}

function redo(): void {
  const d = doc.value;
  if (!d || viewport?.isInteracting())
    return;
  viewport?.cancelInteraction();
  const label = d.redo();
  status.value = label ? `Redo ${label}` : 'Nothing to redo';
}

// ---------- viewport plumbing ----------

function setTarget(t: FrameTarget): void {
  target.value = t;
  livePose.value = null;
  liveCoco.value = null;
  viewport?.setTarget(t);
  syncFromViewport();
}

function setDisplay(patch: Partial<DisplayOptions>): void {
  if (!viewport)
    return;
  if (patch.cocoEdit && target.value.kind !== 'ref')
    setTarget({ kind: 'ref' }); // entering COCO edit jumps to REF
  viewport.setDisplay(patch);
  display.value = viewport.getDisplay();
}

function toggleAlign(): void {
  viewport?.toggleAlign();
  syncFromViewport();
}

function syncFromViewport(): void {
  if (!viewport)
    return;
  aligned.value = viewport.isAligned();
  hasPrev.value = viewport.hasPreviousView();
  display.value = viewport.getDisplay();
  selected.value = viewport.selectedBone;
  gizmoMode.value = viewport.gizmoMode ?? 'none';
  renderCount.value = viewport.renderCount;
}

watch(version, () => {
  viewport?.refresh();
  const s = state.value;
  const t = target.value;
  if (s && t.kind === 'frame' && frameIndex(s, t.uid) < 0)
    setTarget({ kind: 'ref' }); // the frame vanished (undo of Add Frame)
});

// ---------- 2D preview ----------

const images = new Map<string, HTMLImageElement>();
const imageTick = ref(0);

function imageFor(url: string): HTMLImageElement | null {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.onload = () => imageTick.value++;
    img.src = url;
    images.set(url, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

function drawPreview(): void {
  const el = previewEl.value;
  const s = state.value;
  const cur = tb.value;
  if (!el || !s || !cur)
    return;
  const t = target.value;
  const frame = t.kind === 'frame' ? s.frames.find((f) => f.uid === t.uid) : undefined;
  const uid = frame?.image ?? s.reference.image;
  drawFramePreview(el, {
    size: PREVIEW_SIZE,
    image: uid ? imageFor(cur.src.imageUrl(uid)) : null,
    imageAlpha: t.kind === 'frame' && !frame?.image ? 0.35 : 1,
    keypoints: projected.value?.keypoints ?? null,
    canvasSize: { width: s.reference.width, height: s.reference.height },
    label: targetLabel.value,
    stale: !!frame?.imageStale
  });
}

watch([projected, imageTick, targetLabel], drawPreview, { flush: 'post' });

// ---------- keys ----------

function onWindowKey(e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'))
    return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  }
}

// ---------- lifecycle ----------

let poll = 0;

onMounted(() => {
  const vp = new EditorViewport();
  viewport = vp;
  vp.mount(viewportEl.value!);
  vp.setFlySpeed(1.5);
  offs.push(
    vp.on('select', (b) => {
      selected.value = b;
    }),
    vp.on('alignedChange', (a) => {
      aligned.value = a;
      hasPrev.value = vp.hasPreviousView();
    }),
    vp.on('interaction', (a) => {
      interacting.value = a;
      if (!a) {
        livePose.value = null;
        liveCoco.value = null;
      }
    }),
    vp.on('displayChange', (d) => {
      display.value = d;
    }),
    vp.on('livePose', (t, p) => {
      if (sameTarget(t, target.value))
        livePose.value = p;
    }),
    vp.on('liveCoco', (c) => {
      liveCoco.value = c;
    })
  );
  window.addEventListener('keydown', onWindowKey);
  poll = window.setInterval(syncFromViewport, 200);
  loadFixture(fixtureIndex.value);
  const w = window as unknown as Record<string, unknown>;
  w.__testbed = {
    viewport: vp,
    doc: () => doc.value,
    state: () => state.value,
    loadFixture: (i: number) => {
      fixtureIndex.value = i;
      loadFixture(i);
    },
    fixture: () => tb.value?.fixture ?? null,
    report: () => report.value,
    projected: () => projected.value,
    target: () => target.value,
    setCamera,
    relift,
    setTarget,
    setDisplay,
    toggleAlign,
    undo,
    redo,
    rotateTest,
    addFrame,
    deleteFrame
  };
});

function teardown(): void {
  window.clearInterval(poll);
  window.removeEventListener('keydown', onWindowKey);
  for (const off of offs.splice(0))
    off();
  viewport?.dispose();
  viewport = null;
}

onBeforeUnmount(teardown);

if (import.meta.hot)
  import.meta.hot.dispose(teardown);

const fmt = (n: number | undefined, d = 3): string => n === undefined || !Number.isFinite(n) ? '-' : n.toFixed(d);
const fmtE = (n: number | undefined): string => n === undefined || !Number.isFinite(n) ? '-' : n.toExponential(2);
</script>

<template>
  <div class="tb">
    <aside class="tb-side">
      <h1 class="tb-title">
        Skel Anim testbed
      </h1>

      <section class="tb-section">
        <label class="tb-row">
          <span class="tb-key">Fixture</span>
          <select
            v-model.number="fixtureIndex"
            class="tb-input"
            @change="loadFixture(fixtureIndex)"
          >
            <option
              v-for="(f, i) in FIXTURES"
              :key="f.name"
              :value="i"
            >{{ f.label }}</option>
          </select>
        </label>
      </section>

      <section
        v-if="state"
        class="tb-section"
      >
        <h2 class="tb-heading">
          Camera
        </h2>
        <div class="tb-compass">
          <template
            v-for="(d, i) in COMPASS"
            :key="i"
          >
            <button
              v-if="d"
              class="tb-btn"
              :class="{ active: state.direction === d }"
              :title="d"
              @mousedown.prevent
              @click="setCamera({ direction: d })"
            >
              {{ COMPASS_LABEL[d] }}
            </button>
            <span v-else />
          </template>
        </div>
        <label class="tb-row">
          <span class="tb-key">View</span>
          <select
            class="tb-input"
            :value="state.view"
            @change="onView"
          >
            <option
              v-for="v in CAMERA_VIEWS"
              :key="v"
              :value="v"
            >{{ v }}</option>
          </select>
        </label>
        <label class="tb-row">
          <span class="tb-key">Pitch</span>
          <input
            class="tb-range"
            type="range"
            min="0"
            max="60"
            step="1"
            :value="state.pitchDeg"
            @input="onPitch"
          >
          <span class="tb-num">{{ state.pitchDeg }}°</span>
        </label>
      </section>

      <section class="tb-section">
        <h2 class="tb-heading">
          Display
        </h2>
        <label
          v-for="t in TOGGLES"
          :key="t.key"
          class="tb-check"
        >
          <input
            type="checkbox"
            :checked="display[t.key]"
            @change="setDisplay({ [t.key]: ($event.target as HTMLInputElement).checked })"
          >
          {{ t.label }}
        </label>
        <div class="tb-row">
          <span class="tb-key">Gizmo</span>
          <div class="tb-seg">
            <button
              class="tb-btn"
              :class="{ active: display.gizmoMode === 'rotate' }"
              @mousedown.prevent
              @click="setDisplay({ gizmoMode: 'rotate' })"
            >
              Rotate
            </button>
            <button
              class="tb-btn"
              :class="{ active: display.gizmoMode === 'translate' }"
              title="Move applies to Hips only"
              @mousedown.prevent
              @click="setDisplay({ gizmoMode: 'translate' })"
            >
              Move
            </button>
          </div>
        </div>
        <div class="tb-row">
          <span class="tb-key">Space</span>
          <div class="tb-seg">
            <button
              class="tb-btn"
              :class="{ active: display.gizmoSpace === 'local' }"
              @mousedown.prevent
              @click="setDisplay({ gizmoSpace: 'local' })"
            >
              Local
            </button>
            <button
              class="tb-btn"
              :class="{ active: display.gizmoSpace === 'world' }"
              @mousedown.prevent
              @click="setDisplay({ gizmoSpace: 'world' })"
            >
              World
            </button>
          </div>
        </div>
      </section>

      <section
        v-if="state"
        class="tb-section"
      >
        <h2 class="tb-heading">
          Target
        </h2>
        <div class="tb-chips">
          <button
            class="tb-btn tb-chip tb-chip-ref"
            :class="{ active: isRef }"
            @mousedown.prevent
            @click="setTarget({ kind: 'ref' })"
          >
            REF
          </button>
          <button
            v-for="(f, i) in frames"
            :key="f.uid"
            class="tb-btn tb-chip"
            :class="{ active: target.kind === 'frame' && target.uid === f.uid }"
            @mousedown.prevent
            @click="setTarget({ kind: 'frame', uid: f.uid })"
          >
            {{ i + 1 }}
          </button>
        </div>
        <div class="tb-actions">
          <button
            class="tb-btn"
            @mousedown.prevent
            @click="relift"
          >
            Re-lift
          </button>
          <button
            class="tb-btn"
            @mousedown.prevent
            @click="addFrame"
          >
            Add frame (clone)
          </button>
          <button
            class="tb-btn"
            :disabled="isRef"
            @mousedown.prevent
            @click="deleteFrame"
          >
            Delete frame
          </button>
          <button
            class="tb-btn"
            @mousedown.prevent
            @click="rotateTest"
          >
            Rotate test
          </button>
          <button
            class="tb-btn"
            :disabled="!canUndo"
            title="Ctrl+Z"
            @mousedown.prevent
            @click="undo"
          >
            Undo
          </button>
          <button
            class="tb-btn"
            :disabled="!canRedo"
            title="Ctrl+Y / Ctrl+Shift+Z"
            @mousedown.prevent
            @click="redo"
          >
            Redo
          </button>
        </div>
        <p class="tb-status">
          {{ status }}
        </p>
      </section>

      <section class="tb-section">
        <h2 class="tb-heading">
          Readouts
        </h2>
        <dl class="tb-grid">
          <dt>Lift max residual</dt>
          <dd>{{ fmtE(report?.lift.maxResidualPx) }} px</dd>
          <dt>Neck residual</dt>
          <dd>{{ fmt(report?.lift.neckResidualPx) }} px</dd>
          <dt>Torso yaw</dt>
          <dd>{{ fmt(report?.lift.torsoYawDeg, 1) }}°</dd>
          <dt>Calibrate residual</dt>
          <dd>{{ fmtE(report?.calibrationResidual) }}</dd>
          <dt>Selected bone</dt>
          <dd>{{ selected ?? 'none' }}</dd>
          <dt>Gizmo mode</dt>
          <dd>{{ gizmoMode }}</dd>
          <dt>Aligned</dt>
          <dd>{{ aligned }}{{ hasPrev ? ' (prev view)' : '' }}</dd>
          <dt>Interacting</dt>
          <dd>{{ interacting }}</dd>
          <dt>Editor focused</dt>
          <dd>{{ focused }}</dd>
          <dt>Render count</dt>
          <dd>{{ renderCount }}</dd>
          <dt>Doc version</dt>
          <dd>{{ version }}</dd>
          <dt>Ppu / anchor</dt>
          <dd>{{ fmt(state?.projection.ppu, 2) }} / {{ state ? state.projection.anchorPx.map((v) => v.toFixed(1)).join(', ') : '-' }}</dd>
        </dl>
        <ul
          v-if="report?.warnings.length"
          class="tb-warnings"
        >
          <li
            v-for="(w, i) in report.warnings"
            :key="i"
          >
            {{ w }}
          </li>
        </ul>
        <p
          v-if="projected?.clamped"
          class="tb-warnings"
        >
          Some joints fall outside the canvas (clamped).
        </p>
      </section>

      <section class="tb-section">
        <h2 class="tb-heading">
          PixelLab projection ({{ targetLabel }})
        </h2>
        <canvas
          ref="previewEl"
          class="tb-preview"
          :style="{ width: PREVIEW_SIZE + 'px', height: PREVIEW_SIZE + 'px' }"
        />
        <table class="tb-table">
          <thead>
            <tr>
              <th>label</th>
              <th>x</th>
              <th>y</th>
              <th>z</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in keypointRows"
              :key="r.label"
            >
              <td>{{ r.label }}</td>
              <td :title="r.px.toFixed(2) + ' px'">
                {{ r.x.toFixed(4) }}
              </td>
              <td :title="r.py.toFixed(2) + ' px'">
                {{ r.y.toFixed(4) }}
              </td>
              <td>{{ r.z }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </aside>

    <main class="tb-main">
      <div
        ref="viewportEl"
        class="tb-viewport"
        data-zone="editor"
        @focus="focused = true"
        @blur="focused = false"
      />
      <div class="tb-overlay tb-overlay-tr">
        <button
          class="tb-btn tb-align"
          :disabled="aligned && !hasPrev"
          @mousedown.prevent
          @click="toggleAlign"
        >
          {{ alignLabel }}
        </button>
      </div>
      <div class="tb-overlay tb-overlay-bl">
        LMB orbit · MMB pan · wheel zoom · W/S zoom (ortho) · A/D strafe · Space/C up/down · Shift faster · click a joint to select · click Hips again: rotate/move · Esc cancels a drag
      </div>
    </main>
  </div>
</template>

<style scoped>
.tb {
  display: flex;
  height: 100%;
  background: var(--bg-1);
}

.tb-side {
  width: 344px;
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--bg-2);
  border-right: 1px solid var(--border);
  padding: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.tb-title {
  font-size: var(--font-size-lg);
}

.tb-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border);
}

.tb-heading {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.tb-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tb-key {
  width: 52px;
  flex-shrink: 0;
  color: var(--text-dim);
}

.tb-input {
  flex: 1;
  height: var(--control-height);
  background: var(--bg-0);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-1);
}

.tb-range {
  flex: 1;
}

.tb-num {
  width: 36px;
  text-align: right;
  font-family: var(--font-mono);
}

.tb-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tb-btn {
  height: var(--control-height-sm);
  padding: 0 var(--space-2);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

.tb-btn:hover:not(:disabled) {
  background: var(--bg-4);
}

.tb-btn.active {
  background: var(--accent-dim);
  border-color: var(--accent);
  color: var(--text);
}

.tb-btn:disabled {
  opacity: 0.45;
}

.tb-compass {
  display: grid;
  grid-template-columns: repeat(3, 44px);
  gap: var(--space-1);
  align-self: center;
}

.tb-seg {
  display: flex;
  gap: 2px;
}

.tb-chips,
.tb-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.tb-chip {
  min-width: 28px;
}

.tb-chip-ref {
  font-weight: var(--font-weight-bold);
  color: var(--warning);
}

.tb-status {
  min-height: 1.4em;
  color: var(--text-dim);
  font-size: var(--font-size-sm);
}

.tb-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px var(--space-3);
  margin: 0;
  font-size: var(--font-size-sm);
}

.tb-grid dt {
  color: var(--text-dim);
}

.tb-grid dd {
  margin: 0;
  font-family: var(--font-mono);
  text-align: right;
}

.tb-warnings {
  color: var(--warning);
  font-size: var(--font-size-xs);
  padding-left: var(--space-3);
  list-style: disc;
}

.tb-preview {
  align-self: center;
  border: 1px solid var(--border);
}

.tb-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

.tb-table th {
  text-align: left;
  color: var(--text-faint);
  font-weight: var(--font-weight-normal);
}

.tb-table td,
.tb-table th {
  padding: 1px var(--space-1);
}

.tb-table td:not(:first-child),
.tb-table th:not(:first-child) {
  text-align: right;
}

.tb-table tbody tr:nth-child(odd) {
  background: var(--bg-hover);
}

.tb-main {
  position: relative;
  flex: 1;
  min-width: 0;
}

.tb-viewport {
  position: absolute;
  inset: 0;
  background: var(--bg-0);
}

.tb-viewport:focus {
  box-shadow: inset 0 0 0 1px var(--accent-dim);
}

.tb-overlay {
  position: absolute;
  pointer-events: none;
}

.tb-overlay > * {
  pointer-events: auto;
}

.tb-overlay-tr {
  top: var(--space-2);
  right: var(--space-2);
}

.tb-overlay-bl {
  left: var(--space-2);
  bottom: var(--space-2);
  right: var(--space-2);
  color: var(--text-faint);
  font-size: var(--font-size-xs);
}

.tb-align {
  height: var(--control-height);
  background: rgba(19, 22, 28, 0.85);
  backdrop-filter: blur(4px);
}
</style>
