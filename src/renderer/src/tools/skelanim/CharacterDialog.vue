<script setup lang="ts">
// Character dialog (PLAN §6): name (read-only; rename in the explorer), description, defaults for new animations and
// the base images (import, label, direction, remove). Import and Remove are saved at once (they create / recycle
// files); description, defaults, labels and directions are written on Save. Every write is a documents.updateCharacter
// producer that only touches these fields, so concurrent writers (the estimate cache) are never clobbered.
import { computed, onMounted, reactive, ref, shallowRef } from 'vue';
import { ImagePlus, PersonStanding, Trash2 } from '@lucide/vue';
import { assetUrl } from '@shared/api';
import { baseImageRel, charNameFromRel } from '@shared/dataPaths';
import type { CameraView, Direction, TemplateId } from '@shared/pixellab';
import DialogFrame from '../../components/common/DialogFrame.vue';
import IconButton from '../../components/common/IconButton.vue';
import Select from '../../components/common/Select.vue';
import Spinner from '../../components/common/Spinner.vue';
import type { BaseImage, CharacterMeta } from '../../core/model';
import { dialogs } from '../../services/dialogs';
import { errorMessage, reportError } from '../../services/errors';
import { useDocumentsStore } from '../../stores/documents';
import {
  BASE_DIRECTION_OPTIONS, DIRECTION_OPTIONS, TEMPLATE_OPTIONS, VIEW_OPTIONS, animationsUsingBase, directionLabel, guessDirection
} from './explorer/characterForm';

const props = defineProps<{ charRel: string }>();
const emit = defineEmits<{ resolve: [value: CharacterMeta]; cancel: [] }>();

const documents = useDocumentsStore();

const name = computed(() => charNameFromRel(props.charRel));
/** Last meta read from / written to disk. */
const meta = shallowRef<CharacterMeta | null>(null);
const loadError = ref<string | null>(null);

// Form state (small plain values; base image edits keyed by uid)
const description = ref('');
const direction = ref<Direction>('south');
const view = ref<CameraView>('low top-down');
const templateId = ref<TemplateId>('mannequin');
const edits = reactive<Record<string, { label: string; direction: Direction | '' }>>({});

const importing = ref(false);
const removing = ref<string | null>(null);
const saving = ref(false);

/** Take a meta from disk. `resetForm`: also reset description and defaults (first load). Base image edits are kept. */
function adopt(m: CharacterMeta, resetForm: boolean): void {
  meta.value = m;
  if (resetForm) {
    description.value = m.description;
    direction.value = m.defaults.direction;
    view.value = m.defaults.view;
    templateId.value = m.defaults.templateId;
  }
  const uids = new Set(m.baseImages.map((b) => b.uid));
  for (const uid of Object.keys(edits)) {
    if (!uids.has(uid))
      delete edits[uid];
  }
  for (const b of m.baseImages) {
    if (!edits[b.uid])
      edits[b.uid] = { label: b.label, direction: b.direction ?? '' };
  }
}

onMounted(async () => {
  try {
    adopt(await documents.loadCharacter(props.charRel), true);
  } catch (e) {
    loadError.value = errorMessage(e);
  }
});

const dirty = computed(() => {
  const m = meta.value;
  if (!m)
    return false;
  if (description.value !== m.description || direction.value !== m.defaults.direction || view.value !== m.defaults.view
    || templateId.value !== m.defaults.templateId)
    return true;
  return m.baseImages.some((b) => edits[b.uid] && (edits[b.uid].label !== b.label || edits[b.uid].direction !== (b.direction ?? '')));
});

const busy = computed(() => importing.value || saving.value || removing.value !== null);

/** The base image New Animation pre-picks: the first one whose (edited) direction is the (edited) default. */
const prePickedUid = computed(() => meta.value?.baseImages.find((b) => edits[b.uid]?.direction === direction.value)?.uid ?? null);

const thumbUrl = (b: BaseImage): string => assetUrl(baseImageRel(props.charRel, b.uid));

/** Integer (or 1/2ⁿ) scale that shows the canvas crisp inside the 128 px thumbnail box. */
function thumbStyle(b: BaseImage): Record<string, string> {
  const side = Math.max(b.width, b.height);
  const scale = side <= 128 ? Math.floor(128 / side) : 1 / Math.ceil(side / 128);
  return { width: `${b.width * scale}px`, height: `${b.height * scale}px` };
}

function sizeText(b: BaseImage): string {
  const canvas = `${b.width}×${b.height}`;
  return b.srcWidth === b.width && b.srcHeight === b.height ? canvas : `${canvas} (sprite ${b.srcWidth}×${b.srcHeight})`;
}

// ---------- immediate operations ----------

async function importPng(): Promise<void> {
  importing.value = true;
  try {
    const img = await window.api.images.importBase(props.charRel);
    if (!img)
      return;
    const base: BaseImage = {
      uid: img.uid, label: img.sourceName, direction: guessDirection(img.sourceName),
      width: img.width, height: img.height, srcWidth: img.srcWidth, srcHeight: img.srcHeight, offset: [img.offset[0], img.offset[1]],
      estimate: null
    };
    adopt(await documents.updateCharacter(props.charRel, (c) => ({ ...c, baseImages: [...c.baseImages, base] })), false);
  } catch (e) {
    reportError(e, 'Could not import the image');
  } finally {
    importing.value = false;
  }
}

async function remove(b: BaseImage): Promise<void> {
  removing.value = b.uid;
  try {
    const users = await animationsUsingBase(props.charRel, b.uid, documents.docs.values());
    const label = edits[b.uid]?.label || b.label || 'Untitled';
    const detail = users.length > 0
      ? `It is the reference source of: ${users.join(', ')}.\nThose animations keep their own copy of the image and are not affected, `
        + 'but it can no longer be picked again, and its cached skeleton estimate is removed with it.\n\nThe file goes to the Recycle Bin.'
      : 'The file goes to the Recycle Bin.';
    const res = await dialogs.confirm({
      title: 'Remove base image',
      message: users.length > 0 ? `"${label}" is used by ${users.length === 1 ? 'an animation' : `${users.length} animations`}. Remove it anyway?` : `Remove base image "${label}"?`,
      detail,
      danger: true,
      okLabel: 'Remove'
    });
    if (!res.ok)
      return;
    adopt(await documents.updateCharacter(props.charRel, (c) => ({ ...c, baseImages: c.baseImages.filter((x) => x.uid !== b.uid) })), false);
    await window.api.fs.trash(baseImageRel(props.charRel, b.uid)).catch((e: unknown) => reportError(e, 'Could not move the image to the Recycle Bin'));
  } catch (e) {
    reportError(e, 'Could not remove the image');
  } finally {
    removing.value = null;
  }
}

// ---------- save / close ----------

async function save(): Promise<void> {
  if (!meta.value || busy.value)
    return;
  saving.value = true;
  try {
    const defaults = { direction: direction.value, view: view.value, templateId: templateId.value };
    const next = await documents.updateCharacter(props.charRel, (c) => ({
      ...c,
      description: description.value,
      defaults,
      baseImages: c.baseImages.map((b) => {
        const e = edits[b.uid];
        return e ? { ...b, label: e.label.trim(), direction: e.direction === '' ? null : e.direction } : b;
      })
    }));
    emit('resolve', next);
  } catch (e) {
    reportError(e, 'Could not save the character');
  } finally {
    saving.value = false;
  }
}

/** Cancel / × / Escape: confirm before dropping unsaved form edits. */
async function requestClose(): Promise<void> {
  if (dirty.value) {
    const res = await dialogs.confirm({
      title: 'Discard changes?',
      message: `Your changes to "${name.value}" have not been saved.`,
      danger: true,
      okLabel: 'Discard',
      cancelLabel: 'Keep Editing'
    });
    if (!res.ok)
      return;
  }
  emit('cancel');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    e.stopPropagation();
    void requestClose();
  }
}
</script>

<template>
  <DialogFrame
    :title="`Character: ${name}`"
    :icon="PersonStanding"
    size="lg"
    @close="requestClose"
    @keydown="onKeydown"
  >
    <div
      v-if="loadError"
      class="notice notice-danger"
    >
      Could not read the character: {{ loadError }}
    </div>
    <div
      v-else-if="!meta"
      class="row gap-2 text-dim py-4"
    >
      <Spinner :size="14" />
      Loading…
    </div>
    <template v-else>
      <div class="form-grid">
        <label
          class="form-label"
          for="char-name"
        >Name</label>
        <input
          id="char-name"
          class="input"
          :value="name"
          readonly
        >
        <p class="form-hint">
          Rename the character in the explorer (F2).
        </p>
        <label
          class="form-label is-top"
          for="char-description"
        >Description</label>
        <textarea
          id="char-description"
          v-model="description"
          class="textarea"
          rows="3"
          maxlength="1000"
          spellcheck="true"
          placeholder="Appearance, e.g. 'old merchant with a green hood and a leather backpack'"
          data-autofocus
        />
        <p class="form-hint">
          Sent to PixelLab for every animation whose own description is empty.
        </p>
      </div>

      <div class="char-section">
        <h3 class="group-title">
          Defaults for new animations
        </h3>
        <div class="char-defaults">
          <label class="field">
            <span class="field-label">Direction</span>
            <Select
              v-model="direction"
              :options="DIRECTION_OPTIONS"
              label="Default direction"
            />
          </label>
          <label class="field">
            <span class="field-label">View</span>
            <Select
              v-model="view"
              :options="VIEW_OPTIONS"
              label="Default view"
            />
          </label>
          <label class="field">
            <span class="field-label">Template</span>
            <Select
              v-model="templateId"
              :options="TEMPLATE_OPTIONS"
              label="Default template"
            />
          </label>
        </div>
      </div>

      <div class="char-section">
        <div class="char-section-header">
          <h3 class="group-title">
            Base images
          </h3>
          <span class="text-xs text-faint">{{ meta.baseImages.length || '' }}</span>
          <button
            type="button"
            class="btn btn-sm ml-auto"
            :class="{ 'is-loading': importing }"
            :disabled="busy"
            @click="importPng"
          >
            <ImagePlus :size="14" />
            <span>Import PNG…</span>
            <Spinner
              v-if="importing"
              class="btn-spinner"
              :size="14"
            />
          </button>
        </div>
        <div
          v-if="meta.baseImages.length === 0"
          class="char-empty"
        >
          <ImagePlus
            :size="22"
            class="text-faint"
          />
          <div>No base images yet.</div>
          <div class="text-xs text-faint">
            Import a PNG sprite, up to 256 px per side. It is padded to a square canvas, never scaled.
          </div>
        </div>
        <div
          v-else
          class="char-bases"
        >
          <div
            v-for="b in meta.baseImages"
            :key="b.uid"
            class="char-base"
            :class="{ 'is-prepicked': b.uid === prePickedUid }"
          >
            <div class="char-base-thumb checker">
              <img
                class="pixelated"
                :src="thumbUrl(b)"
                :style="thumbStyle(b)"
                :alt="edits[b.uid]?.label || b.label"
                draggable="false"
              >
            </div>
            <div class="char-base-fields">
              <input
                v-if="edits[b.uid]"
                v-model="edits[b.uid].label"
                class="input input-sm"
                placeholder="Label"
                aria-label="Label"
                maxlength="64"
                spellcheck="false"
              >
              <Select
                v-if="edits[b.uid]"
                v-model="edits[b.uid].direction"
                :options="BASE_DIRECTION_OPTIONS"
                size="sm"
                label="Direction"
              />
              <div class="char-base-meta">
                <span class="tabular">{{ sizeText(b) }}</span>
              </div>
              <div class="char-base-badges">
                <span
                  v-if="b.uid === prePickedUid"
                  v-tooltip="`New animations start from this image: its direction is the default (${directionLabel(direction)}).`"
                  class="badge badge-accent"
                >New animations</span>
                <span
                  v-if="b.estimate"
                  v-tooltip="'A skeleton estimate is cached for this image (no PixelLab call when it is picked again).'"
                  class="badge badge-success"
                >Skeleton cached</span>
              </div>
            </div>
            <IconButton
              class="char-base-remove"
              :icon="Trash2"
              size="sm"
              danger-hover
              tooltip="Remove base image"
              :loading="removing === b.uid"
              :disabled="busy && removing !== b.uid"
              @click="remove(b)"
            />
          </div>
        </div>
        <p class="form-hint">
          Imports and removals are saved right away; labels and directions are saved with Save.
        </p>
      </div>
    </template>
    <template #footer>
      <button
        type="button"
        class="btn btn-primary"
        :class="{ 'is-loading': saving }"
        data-dialog-primary
        :disabled="!meta || busy"
        @click="save"
      >
        <span>Save</span>
        <Spinner
          v-if="saving"
          class="btn-spinner"
          :size="14"
        />
      </button>
      <button
        type="button"
        class="btn"
        @click="requestClose"
      >
        Cancel
      </button>
    </template>
  </DialogFrame>
</template>

<style scoped>
.char-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-1);
}

.char-section-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.char-defaults {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.char-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-4);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  color: var(--text-dim);
  text-align: center;
}

.char-bases {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-2);
}

.char-base {
  position: relative;
  display: flex;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-1);
}

.char-base.is-prepicked {
  border-color: var(--accent-muted);
}

.char-base-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 128px;
  height: 128px;
  overflow: hidden;
  border-radius: var(--radius-sm);
}

.char-base-thumb img {
  max-width: none;
  image-rendering: pixelated;
}

.char-base-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
  padding-right: 22px;
}

.char-base-meta {
  color: var(--text-faint);
  font-size: var(--font-size-xs);
}

.char-base-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: auto;
}

.char-base-remove {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
}
</style>
