// Settings store (SettingsStoreApi in stores/types.ts). Holds the MASKED settings from main: a stored secret reads as
// SECRET_MASK and the real key never reaches the renderer. `settings` is a frozen snapshot replaced on every load /
// save, so watchers like `watch(() => store.settings.app.undoLimit, …)` fire on change. App.vue loads it at startup.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { plainCopy } from '@shared/json';
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '@shared/settings';
import { deepFreeze } from '../core/util/freeze';
import type { SettingsStoreApi } from './types';

const snapshot = (s: AppSettings): AppSettings => deepFreeze(structuredClone(s));

export const useSettingsStore = defineStore('settings', () => {
  const settings = shallowRef<AppSettings>(snapshot(DEFAULT_SETTINGS));
  const loaded = ref(false);
  const hasPixelLabKey = computed(() => settings.value.pixellab.apiKey !== '');
  let loading: Promise<AppSettings> | null = null;

  /** Read from main (concurrent calls share one request). */
  function load(): Promise<AppSettings> {
    loading ??= (async () => {
      try {
        settings.value = snapshot(await window.api.settings.read());
        loaded.value = true;
        return settings.value;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  /** Deep-merge `patch` into appSettings.config (SECRET_MASK keeps a stored secret, '' clears it). */
  async function save(patch: SettingsPatch): Promise<AppSettings> {
    settings.value = snapshot(await window.api.settings.write(plainCopy(patch))); // IPC cannot clone Vue proxies
    loaded.value = true;
    return settings.value;
  }

  return { settings, loaded, hasPixelLabKey, load, save };
});

/** The store typed as its public API (also a compile-time check that it satisfies SettingsStoreApi). */
export function useSettingsApi(): SettingsStoreApi {
  return useSettingsStore();
}
