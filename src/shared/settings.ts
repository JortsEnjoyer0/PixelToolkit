// Shared between main, preload and renderer. Mirrors the keys of appSettings.config (JSON).

/** Playback rate of a new animation (Settings default) and the fallback for a missing or invalid fps. */
export const DEFAULT_FPS = 12;

export interface AppSettings {
  pixellab: { apiKey: string; baseUrl: string };
  ai: { anthropicApiKey: string; openaiApiKey: string };
  app: { dataRoot: string; autoSaveIntervalSec: number; undoLimit: number; defaultFps: number };
  editor: { flySpeed: number; showFloor: boolean; showFrameImage: boolean; showCoco: boolean };
}

/** Deep-partial settings, used by settings.write() to patch individual keys. */
export type SettingsPatch = { [S in keyof AppSettings]?: Partial<AppSettings[S]> };

export const DEFAULT_SETTINGS: AppSettings = {
  pixellab: { apiKey: '', baseUrl: 'https://api.pixellab.ai/v2' },
  ai: { anthropicApiKey: '', openaiApiKey: '' },
  app: { dataRoot: './data', autoSaveIntervalSec: 60, undoLimit: 100, defaultFps: DEFAULT_FPS },
  editor: { flySpeed: 1.5, showFloor: true, showFrameImage: true, showCoco: true }
};

/**
 * Secret keys never leave the main process. settings.read() returns SECRET_MASK in place of a
 * non-empty secret; passing SECRET_MASK back to settings.write() keeps the stored value.
 */
export const SECRET_KEYS: { [S in keyof AppSettings]?: (keyof AppSettings[S])[] } = {
  pixellab: ['apiKey'],
  ai: ['anthropicApiKey', 'openaiApiKey']
};

export const SECRET_MASK = '__secret_set__';
