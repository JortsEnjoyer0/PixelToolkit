<script setup lang="ts">
// Settings dialog (PLAN §6 App shell). Opened with openSettings() → dialogs.open(SettingsDialog); emits
// resolve(true) after a successful save, cancel otherwise. Secrets: the store holds SECRET_MASK for stored keys;
// an untouched key is left out of the patch (kept), a removed one is sent as '' and a typed one replaces it.
import { computed, onMounted, reactive, ref, useId } from 'vue';
import { TriangleAlert, Wallet } from '@lucide/vue';
import type { Balance, Result } from '@shared/api';
import { checkedBase } from '@shared/pixellab';
import type { AppSettings, SettingsPatch } from '@shared/settings';
import { errorMessage } from '../../services/errors';
import { toasts } from '../../services/toasts';
import { useSettingsStore } from '../../stores/settings';
import Checkbox from '../common/Checkbox.vue';
import DialogFrame from '../common/DialogFrame.vue';
import NumberSlider from '../common/NumberSlider.vue';
import SecretInput from '../common/SecretInput.vue';
import Spinner from '../common/Spinner.vue';

const emit = defineEmits<{ resolve: [saved: boolean]; cancel: [] }>();

const store = useSettingsStore();
const uid = useId();
const fieldId = (name: string): string => `${uid}-${name}`;

interface SecretField { value: string; cleared: boolean; stored: boolean }
type SettingsForm = { pixellabKey: SecretField; anthropicKey: SecretField; openaiKey: SecretField; baseUrl: string }
  & AppSettings['app'] & AppSettings['editor'];

const secret = (masked: string): SecretField => ({ value: '', cleared: false, stored: masked !== '' });

function formFrom(s: AppSettings): SettingsForm {
  return {
    pixellabKey: secret(s.pixellab.apiKey),
    anthropicKey: secret(s.ai.anthropicApiKey),
    openaiKey: secret(s.ai.openaiApiKey),
    baseUrl: s.pixellab.baseUrl,
    dataRoot: s.app.dataRoot,
    autoSaveIntervalSec: s.app.autoSaveIntervalSec,
    undoLimit: s.app.undoLimit,
    defaultFps: s.app.defaultFps,
    flySpeed: s.editor.flySpeed,
    showFloor: s.editor.showFloor,
    showFrameImage: s.editor.showFrameImage,
    showCoco: s.editor.showCoco
  };
}

const initial = ref(store.settings);
const form = reactive(formFrom(store.settings));

// ---- validation ----

/** Main's rule (checkedBase), so the key never goes elsewhere and a saved URL is never refused later. */
function baseUrlError(text: string): string | null {
  const v = text.trim();
  if (!v)
    return 'Required';
  return checkedBase(v) ? null : 'Must be an https:// address on pixellab.ai (no credentials, query or #fragment)';
}

const errors = computed(() => ({
  baseUrl: baseUrlError(form.baseUrl),
  dataRoot: form.dataRoot.trim() ? null : 'Required'
}));
const valid = computed(() => !errors.value.baseUrl && !errors.value.dataRoot);
const dataRootChanged = computed(() => form.dataRoot.trim() !== initial.value.app.dataRoot);

// ---- save ----

const saving = ref(false);
const saveError = ref('');

/** Typed value → replace, removed → '', untouched → undefined (key left out: main keeps it). */
const secretPatch = (f: SecretField): string | undefined => f.value.trim() !== '' ? f.value.trim() : f.cleared ? '' : undefined;

function buildPatch(): SettingsPatch {
  const pixellab: NonNullable<SettingsPatch['pixellab']> = { baseUrl: form.baseUrl.trim() };
  const ai: NonNullable<SettingsPatch['ai']> = {};
  const plKey = secretPatch(form.pixellabKey);
  const anthropicKey = secretPatch(form.anthropicKey);
  const openaiKey = secretPatch(form.openaiKey);
  if (plKey !== undefined)
    pixellab.apiKey = plKey;
  if (anthropicKey !== undefined)
    ai.anthropicApiKey = anthropicKey;
  if (openaiKey !== undefined)
    ai.openaiApiKey = openaiKey;
  return {
    pixellab,
    ai,
    app: {
      dataRoot: form.dataRoot.trim(),
      autoSaveIntervalSec: form.autoSaveIntervalSec,
      undoLimit: form.undoLimit,
      defaultFps: form.defaultFps
    },
    editor: {
      flySpeed: form.flySpeed,
      showFloor: form.showFloor,
      showFrameImage: form.showFrameImage,
      showCoco: form.showCoco
    }
  };
}

async function save(): Promise<void> {
  if (!valid.value || saving.value)
    return;
  const restart = dataRootChanged.value;
  saving.value = true;
  saveError.value = '';
  try {
    await store.save(buildPatch());
  } catch (e) {
    // Keep the dialog (and the user's input) open on failure
    saveError.value = `Could not save: ${errorMessage(e)}`;
    return;
  } finally {
    saving.value = false;
  }
  if (restart)
    toasts.push({ kind: 'info', title: 'Restart required', message: 'The new data folder is used after PixelToolkit restarts.' });
  emit('resolve', true);
}

// ---- balance ----

interface BalanceView { status: 'idle' | 'loading' | 'ok' | 'error'; text: string }

const balance = ref<BalanceView>({ status: 'idle', text: '' });
const keyEdited = computed(() => form.pixellabKey.value.trim() !== '' || form.pixellabKey.cleared);
const num = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function formatBalance(b: Balance): string {
  const parts: string[] = [];
  if (b.generations !== null)
    parts.push(`${num(b.generations)}${b.total !== null ? ` of ${num(b.total)}` : ''} generations left`);
  if (b.usd !== null)
    parts.push(`$${b.usd.toFixed(2)} credit`);
  return parts.join(' · ') || 'No balance information returned';
}

async function checkBalance(): Promise<void> {
  balance.value = { status: 'loading', text: '' };
  let res: Result<Balance>;
  try {
    res = await window.api.pixellab.balance();
  } catch (e) {
    // balance() never rejects by contract; show anything unexpected inline as well
    res = { ok: false, error: errorMessage(e) };
  }
  balance.value = res.ok
    ? { status: 'ok', text: formatBalance(res.data) }
    : { status: 'error', text: `${res.error || 'Balance check failed'}${res.status ? ` (HTTP ${res.status})` : ''}` };
}

// ---- data root info ----

const dataRootAbs = ref('');

onMounted(async () => {
  if (!store.loaded) {
    await store.load();
    initial.value = store.settings;
    Object.assign(form, formFrom(store.settings));
  }
  dataRootAbs.value = (await window.api.app.getInfo()).dataRoot;
});
</script>

<template>
  <DialogFrame
    title="Settings"
    size="md"
    @close="emit('cancel')"
  >
    <section class="col gap-2">
      <h3 class="group-title">
        PixelLab
      </h3>
      <div class="form-grid">
        <label
          class="form-label"
          :for="fieldId('pl-key')"
        >API key</label>
        <SecretInput
          :id="fieldId('pl-key')"
          v-model="form.pixellabKey.value"
          v-model:cleared="form.pixellabKey.cleared"
          :stored="form.pixellabKey.stored"
        />

        <label
          class="form-label"
          :for="fieldId('pl-url')"
        >Base URL</label>
        <input
          :id="fieldId('pl-url')"
          v-model="form.baseUrl"
          class="input input-mono"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :class="{ 'is-invalid': errors.baseUrl }"
          :aria-invalid="!!errors.baseUrl"
        >
        <p
          v-if="errors.baseUrl"
          class="form-error"
        >
          {{ errors.baseUrl }}
        </p>

        <span class="form-label">Balance</span>
        <div class="form-control">
          <button
            type="button"
            class="btn btn-sm"
            :disabled="!form.pixellabKey.stored || balance.status === 'loading'"
            @click="checkBalance"
          >
            <Spinner
              v-if="balance.status === 'loading'"
              :size="14"
            />
            <Wallet
              v-else
              :size="14"
            />
            <span>Check balance</span>
          </button>
          <span
            class="flex-1 text-sm break-anywhere"
            :class="balance.status === 'error' ? 'text-danger' : 'text-dim'"
          >{{ balance.text }}</span>
        </div>
        <p
          v-if="!form.pixellabKey.stored"
          class="form-hint"
        >
          Save an API key first.
        </p>
        <p
          v-else-if="keyEdited"
          class="form-hint"
        >
          Checks the saved key. Save to use the new one.
        </p>
      </div>
    </section>

    <section class="col gap-2">
      <h3 class="group-title">
        AI providers
      </h3>
      <div class="form-grid">
        <label
          class="form-label"
          :for="fieldId('anthropic-key')"
        >Anthropic key</label>
        <SecretInput
          :id="fieldId('anthropic-key')"
          v-model="form.anthropicKey.value"
          v-model:cleared="form.anthropicKey.cleared"
          :stored="form.anthropicKey.stored"
        />

        <label
          class="form-label"
          :for="fieldId('openai-key')"
        >OpenAI key</label>
        <SecretInput
          :id="fieldId('openai-key')"
          v-model="form.openaiKey.value"
          v-model:cleared="form.openaiKey.cleared"
          :stored="form.openaiKey.stored"
        />
      </div>
    </section>

    <section class="col gap-2">
      <h3 class="group-title">
        Application
      </h3>
      <div class="form-grid">
        <label
          class="form-label"
          :for="fieldId('data-root')"
        >Data folder</label>
        <input
          :id="fieldId('data-root')"
          v-model="form.dataRoot"
          class="input input-mono"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :class="{ 'is-invalid': errors.dataRoot }"
          :aria-invalid="!!errors.dataRoot"
        >
        <p
          v-if="errors.dataRoot"
          class="form-error"
        >
          {{ errors.dataRoot }}
        </p>
        <p
          v-else
          class="form-hint break-anywhere"
        >
          Relative paths start at the folder of appSettings.config.
          <template v-if="dataRootAbs">
            Current: {{ dataRootAbs }}
          </template>
        </p>
        <div
          v-if="dataRootChanged"
          class="notice notice-warning form-span"
        >
          <TriangleAlert :size="14" />
          <span>Restart PixelToolkit to use the new data folder.</span>
        </div>

        <span class="form-label">Autosave</span>
        <div class="form-control">
          <NumberSlider
            v-model="form.autoSaveIntervalSec"
            :min="0"
            :max="3600"
            :slider="false"
            label="Autosave interval in seconds"
          />
          <span class="text-sm text-dim">seconds (0 = off)</span>
        </div>

        <span class="form-label">Undo limit</span>
        <div class="form-control">
          <NumberSlider
            v-model="form.undoLimit"
            :min="10"
            :max="1000"
            :slider="false"
            label="Undo limit"
          />
          <span class="text-sm text-dim">steps per animation</span>
        </div>

        <span class="form-label">Default fps</span>
        <NumberSlider
          v-model="form.defaultFps"
          :min="1"
          :max="60"
          label="Default frames per second"
        />
      </div>
    </section>

    <section class="col gap-2">
      <h3 class="group-title">
        Editor
      </h3>
      <div class="form-grid">
        <span class="form-label">Fly speed</span>
        <NumberSlider
          v-model="form.flySpeed"
          :min="0.1"
          :max="10"
          :step="0.1"
          label="Fly speed in units per second"
        />

        <span class="form-label is-top">Default view</span>
        <div class="col gap-0">
          <Checkbox
            v-model="form.showFloor"
            label="Show floor"
          />
          <Checkbox
            v-model="form.showFrameImage"
            label="Show the frame image on the plane"
          />
          <Checkbox
            v-model="form.showCoco"
            label="Show the COCO-18 overlay"
          />
        </div>
        <p class="form-hint">
          Changes here apply to the editor right away. The toolbar can still toggle them; its state is remembered with the workspace.
        </p>
      </div>
    </section>

    <template #footer>
      <div class="dialog-footer-start">
        <span
          v-if="saveError"
          class="text-sm text-danger break-anywhere"
        >{{ saveError }}</span>
      </div>
      <button
        type="button"
        class="btn btn-primary"
        :class="{ 'is-loading': saving }"
        data-dialog-primary
        :disabled="!valid"
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
        @click="emit('cancel')"
      >
        Cancel
      </button>
    </template>
  </DialogFrame>
</template>
