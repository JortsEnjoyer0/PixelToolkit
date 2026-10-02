<script setup lang="ts">
// Control panel for one animation doc (data-zone="panel", fixed width, scrolling sections + pinned Generate footer):
// Name (rename on Enter / blur), Reference (base-image picker, import, estimate), Camera (direction, view, pitch) and
// the Generation fields. Every content edit is one undo entry through doc.apply() and the docState producers; text
// fields commit on blur / Enter, the pitch slider merges a drag into one entry. SkelAnimTool keys the panel by doc, so
// one instance always edits one doc.
import { computed, ref, useId, watch } from 'vue';
import { ChevronDown, Info, RefreshCw, RotateCcw, ScanLine, TriangleAlert } from '@lucide/vue';
import { assetUrl } from '@shared/api';
import { animImageRel } from '@shared/dataPaths';
import {
  ESTIMATE_COST, MAX_ACTION_LENGTH, MAX_DESCRIPTION_LENGTH, VIEW_PITCH, type CameraView, type Direction, type TemplateId
} from '@shared/pixellab';
import Checkbox from '../../../components/common/Checkbox.vue';
import IconButton from '../../../components/common/IconButton.vue';
import NumberSlider from '../../../components/common/NumberSlider.vue';
import Select from '../../../components/common/Select.vue';
import Spinner from '../../../components/common/Spinner.vue';
import { withCamera } from '../../../core/docState';
import type { BaseImage, UndoableState } from '../../../core/model';
import { clamp } from '../../../core/util/math';
import { MAX_NAME_LENGTH, validateName } from '../../../core/util/naming';
import { contextMenu } from '../../../services/contextMenu';
import { errorMessage } from '../../../services/errors';
import { useDocumentsStore } from '../../../stores/documents';
import { useJobsStore } from '../../../stores/jobs';
import type { ApplyOptions, DocHandle } from '../../../stores/types';
import { TEMPLATE_OPTIONS, VIEW_OPTIONS } from '../explorer/characterForm';
import CommitField from './CommitField.vue';
import DirectionPicker from './DirectionPicker.vue';
import GenerateFooter from './GenerateFooter.vue';
import ReferencePicker from './ReferencePicker.vue';
import { estimateReference, estimatingDocs, importReferenceImage, pickBaseImage, referenceIoDocs } from './panelActions';

const props = defineProps<{ doc: DocHandle }>();

const documents = useDocumentsStore();
const jobs = useJobsStore();
const id = useId();

const MAX_SEED = 2147483647;

const s = computed(() => props.doc.state.value);
const reference = computed(() => s.value.reference);
const busy = computed(() => jobs.busy(props.doc.id));

function apply(label: string, producer: (st: UndoableState) => UndoableState, opts?: ApplyOptions): void {
  props.doc.apply(label, producer, opts);
}

// ---------- character (base images, description placeholder) ----------

const charLoadFailed = ref(false);
const character = computed(() => documents.characters.get(props.doc.charRel.value) ?? null);

/** Also the picker's Retry. A late failure for a character this doc no longer belongs to is ignored. */
function loadCharacter(rel: string): void {
  charLoadFailed.value = false;
  documents.loadCharacter(rel).catch((e: unknown) => {
    if (props.doc.charRel.value === rel)
      charLoadFailed.value = true;
    console.error('[panel] loadCharacter failed', e);
  });
}

watch(() => props.doc.charRel.value, (rel) => {
  charLoadFailed.value = false;
  if (!documents.characters.has(rel))
    loadCharacter(rel);
}, { immediate: true });

// ---------- name ----------

const nameField = ref<InstanceType<typeof CommitField> | null>(null);
/** Syntax only; uniqueness among the siblings is checked by renameAnimation. */
const checkName = (v: string): string | null => validateName(v);
const nameError = ref<string | null>(null);
const renaming = ref(false);

async function rename(name: string): Promise<void> {
  nameError.value = null;
  renaming.value = true;
  try {
    await documents.renameAnimation(props.doc.rel.value, name);
  } catch (e) {
    nameError.value = errorMessage(e);
    nameField.value?.revert();
  } finally {
    renaming.value = false;
  }
}

// ---------- reference ----------

const referenceUrl = computed(() => reference.value.image
  ? assetUrl(animImageRel(props.doc.charRel.value, props.doc.name.value, reference.value.image))
  : null);
const sourceBase = computed<BaseImage | null>(() => {
  const uid = reference.value.sourceBaseUid;
  return uid ? character.value?.baseImages.find((b) => b.uid === uid) ?? null : null;
});
const sourceText = computed(() => {
  const r = reference.value;
  if (!r.image)
    return 'No reference image';
  if (!r.sourceBaseUid)
    return 'Imported PNG';
  const b = sourceBase.value;
  if (!b)
    return 'Base image (removed from the character)';
  return b.label ? `Base image "${b.label}"` : 'Base image';
});
const skeletonBadge = computed(() => {
  const r = reference.value;
  if (!r.pose)
    return { text: 'No skeleton', cls: 'badge' };
  if (r.needsEstimate)
    return { text: 'Needs estimate', cls: 'badge badge-warning' };
  return { text: 'Estimated', cls: 'badge badge-success' };
});
const mismatch = computed(() => {
  const d = sourceBase.value?.direction;
  return d && d !== s.value.direction ? d : null;
});
const referenceBusy = computed(() => referenceIoDocs.has(props.doc.id));
const estimating = computed(() => estimatingDocs.has(props.doc.id));
const canEstimate = computed(() => !!reference.value.image && !busy.value);
const estimateTip = computed(() => {
  if (!reference.value.image)
    return 'Pick or import a reference image first';
  if (busy.value)
    return 'An API call is pending for this animation';
  return 'Estimate the reference skeleton (uses the base image\'s cached estimate when there is one)';
});

function pick(base: BaseImage): void {
  void pickBaseImage(props.doc, base);
}

function importPng(): void {
  void importReferenceImage(props.doc);
}

function estimate(force: boolean): void {
  void estimateReference(props.doc, { force });
}

function openEstimateMenu(e: MouseEvent): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  contextMenu.open({ x: r.left, y: r.bottom + 2 }, [
    { label: 'Estimate (cached when available)', icon: ScanLine, action: () => estimate(false) },
    { label: `Re-estimate (≈${ESTIMATE_COST} gen)`, icon: RefreshCw, action: () => estimate(true) }
  ]);
}

// ---------- camera ----------

const pitchPreset = computed(() => VIEW_PITCH[s.value.view]);

function applyCamera(label: string, cam: { direction?: Direction; view?: CameraView; pitchDeg?: number }, opts?: ApplyOptions): void {
  apply(label, (st) => withCamera(st, cam).state, opts);
}

function setDirection(direction: Direction): void {
  applyCamera('Change Direction', { direction });
}

function setView(view: CameraView): void {
  applyCamera('Change View', { view, pitchDeg: VIEW_PITCH[view] });
}

function setPitch(pitchDeg: number): void {
  applyCamera('Change Pitch', { pitchDeg }, { mergeKey: `pitch:${props.doc.id}` });
}

function endPitchEdit(): void {
  props.doc.history.seal();
}

function resetPitch(): void {
  applyCamera('Reset Pitch', { pitchDeg: pitchPreset.value });
}

// ---------- generation fields ----------

const descriptionPlaceholder = computed(() => character.value?.description.trim()
  || 'Appearance, e.g. "old merchant in a green robe"');

function setAction(action: string): void {
  apply('Edit Action', (st) => st.action === action ? st : { ...st, action });
}

function setDescription(description: string): void {
  apply('Edit Description', (st) => st.description === description ? st : { ...st, description });
}

function setTemplate(templateId: TemplateId): void {
  apply('Change Template', (st) => st.templateId === templateId ? st : { ...st, templateId });
}

function setSeed(seed: number): void {
  const v = clamp(Math.round(seed), 0, MAX_SEED);
  apply('Change Seed', (st) => st.seed === v ? st : { ...st, seed: v });
}

function setNoBackground(noBackground: boolean): void {
  apply('Toggle No Background', (st) => st.noBackground === noBackground ? st : { ...st, noBackground });
}

function setSendDepth(sendDepth: boolean): void {
  apply('Toggle Send Depth', (st) => st.sendDepth === sendDepth ? st : { ...st, sendDepth });
}
</script>

<template>
  <aside
    class="panel control-panel"
    data-zone="panel"
    aria-label="Animation settings"
  >
    <div class="panel-body">
      <!-- Name -->
      <section class="section">
        <div class="section-body control-panel-first">
          <label
            class="field-label"
            :for="`${id}-name`"
          >Name</label>
          <CommitField
            :id="`${id}-name`"
            ref="nameField"
            :value="doc.name.value"
            :disabled="renaming"
            :validate="checkName"
            :error="nameError"
            :maxlength="MAX_NAME_LENGTH"
            @commit="rename"
            @invalid="nameError = $event"
            @edit="nameError = null"
          />
        </div>
      </section>

      <!-- Reference -->
      <section class="section">
        <div class="section-header">
          Reference
        </div>
        <div class="section-body">
          <div class="row gap-3 items-start">
            <div class="reference-preview checker">
              <img
                v-if="referenceUrl"
                class="pixelated"
                :src="referenceUrl"
                alt="Reference image"
                draggable="false"
              >
              <span
                v-else
                class="text-faint text-xs"
              >No image</span>
            </div>
            <div class="col gap-1 min-w-0">
              <span class="text-sm truncate">{{ sourceText }}</span>
              <span class="text-xs text-dim tabular">Canvas {{ reference.width }} × {{ reference.height }} px</span>
              <span>
                <span :class="skeletonBadge.cls">{{ skeletonBadge.text }}</span>
              </span>
            </div>
          </div>

          <ReferencePicker
            :char-rel="doc.charRel.value"
            :character="character"
            :selected-uid="reference.image ? reference.sourceBaseUid : null"
            :busy="referenceBusy"
            :disabled="estimating"
            :failed="charLoadFailed && !character"
            @pick="pick"
            @import="importPng"
            @retry="loadCharacter(doc.charRel.value)"
          />

          <div
            v-if="mismatch"
            class="notice notice-warning"
          >
            <TriangleAlert :size="14" />
            <span>The base image faces {{ mismatch }}, but the animation direction is {{ s.direction }}.</span>
          </div>
          <div
            v-if="reference.image && !reference.pose"
            class="notice notice-info"
          >
            <Info :size="14" />
            <span>Estimate the reference skeleton to start animating.</span>
          </div>
          <div
            v-else-if="reference.image && reference.needsEstimate"
            class="notice notice-info"
          >
            <Info :size="14" />
            <span>The reference image changed since the last estimate. Estimate the skeleton again.</span>
          </div>

          <div class="btn-group estimate-group">
            <button
              v-tooltip="estimateTip"
              type="button"
              class="btn estimate-main"
              :class="{ 'is-loading': estimating }"
              :disabled="!canEstimate"
              :aria-busy="estimating || undefined"
              @click="estimate(false)"
            >
              <ScanLine :size="14" />
              <span>Estimate reference skeleton</span>
              <Spinner
                v-if="estimating"
                class="btn-spinner"
                :size="14"
              />
            </button>
            <IconButton
              :icon="ChevronDown"
              variant="default"
              tooltip="More estimate options"
              :disabled="!canEstimate"
              @click="openEstimateMenu"
            />
          </div>
        </div>
      </section>

      <!-- Camera -->
      <section class="section">
        <div class="section-header">
          Camera
        </div>
        <div class="section-body">
          <div class="row gap-3 items-start">
            <div class="field">
              <span class="field-label">Direction</span>
              <DirectionPicker
                :model-value="s.direction"
                @update:model-value="setDirection"
              />
            </div>
            <div class="col gap-2 flex-1">
              <div class="field">
                <span class="field-label">View</span>
                <Select
                  :model-value="s.view"
                  :options="VIEW_OPTIONS"
                  label="View"
                  @update:model-value="setView"
                />
              </div>
              <div class="field">
                <span class="field-label">Pitch (°)</span>
                <div class="row gap-1">
                  <NumberSlider
                    class="flex-1"
                    :model-value="s.pitchDeg"
                    :min="0"
                    :max="60"
                    :step="0.5"
                    :precision="1"
                    :input-width="52"
                    size="sm"
                    label="Pitch in degrees"
                    @update:model-value="setPitch"
                    @commit="endPitchEdit"
                  />
                  <IconButton
                    :icon="RotateCcw"
                    size="sm"
                    :tooltip="`Reset to the ${s.view} preset (${pitchPreset}°)`"
                    :disabled="s.pitchDeg === pitchPreset"
                    @click="resetPitch"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Generation -->
      <section class="section">
        <div class="section-header">
          Generation
        </div>
        <div class="section-body">
          <div class="field">
            <label
              class="field-label"
              :for="`${id}-action`"
            >Action</label>
            <CommitField
              :id="`${id}-action`"
              :value="s.action"
              :maxlength="MAX_ACTION_LENGTH"
              placeholder="e.g. walk, run, attack"
              counter
              @commit="setAction"
            />
          </div>
          <div class="field">
            <label
              class="field-label"
              :for="`${id}-description`"
            >Description</label>
            <CommitField
              :id="`${id}-description`"
              :value="s.description"
              multiline
              :rows="3"
              :maxlength="MAX_DESCRIPTION_LENGTH"
              :placeholder="descriptionPlaceholder"
              counter
              @commit="setDescription"
            />
            <p class="form-hint">
              Leave empty to send the character's description.
            </p>
          </div>
          <div class="row gap-2 items-end">
            <div class="field flex-1">
              <span class="field-label">Template</span>
              <Select
                :model-value="s.templateId"
                :options="TEMPLATE_OPTIONS"
                label="Template"
                @update:model-value="setTemplate"
              />
            </div>
            <div class="field">
              <span class="field-label">Seed</span>
              <NumberSlider
                v-tooltip="'0 = random'"
                :model-value="s.seed"
                :min="0"
                :max="MAX_SEED"
                :slider="false"
                :input-width="104"
                label="Seed (0 = random)"
                @commit="setSeed"
              />
            </div>
          </div>
          <div class="col gap-1">
            <Checkbox
              :model-value="s.noBackground"
              label="No background"
              @update:model-value="setNoBackground"
            />
            <Checkbox
              v-tooltip="'Also send per-joint depth (0–255) with the keypoints'"
              :model-value="s.sendDepth"
              label="Send depth"
              @update:model-value="setSendDepth"
            />
          </div>
        </div>
      </section>
    </div>
    <GenerateFooter :doc="doc" />
  </aside>
</template>

<style scoped>
.control-panel {
  flex: 0 0 auto;
  width: var(--panel-width);
  border-right: 1px solid var(--border);
}

.control-panel-first {
  padding-top: var(--space-3);
  gap: var(--space-1);
}

.reference-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 72px;
  height: 72px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.reference-preview > img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.estimate-group {
  display: flex;
  width: 100%;
}

.estimate-main {
  flex: 1 1 auto;
}
</style>
