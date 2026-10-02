import { promises as fsp } from 'node:fs';
import { IPC } from '../../shared/api';
import { formatJson, isObj, type Obj } from '../../shared/json';
import { DEFAULT_SETTINGS, SECRET_KEYS, SECRET_MASK, type AppSettings, type SettingsPatch } from '../../shared/settings';
import { dataRootDirOf, dataRootProblem, getSettingsPath } from '../paths';
import { atomicWrite, errCode, parseJsonText } from '../core/dataFs';
import { handle } from './handle';

const isSecret = (section: string, key: string): boolean =>
  ((SECRET_KEYS as Record<string, string[] | undefined>)[section] ?? []).includes(key);

const toJson = (v: unknown): string => formatJson(v) + '\n';

/** Parsed appSettings.config, or null when it does not exist. Invalid JSON throws (never clobber the file). */
async function readRaw(): Promise<Obj | null> {
  let text: string;
  try {
    text = await fsp.readFile(getSettingsPath(), 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT')
      return null;
    throw e;
  }
  const raw: unknown = parseJsonText(text); // tolerates a BOM (Notepad, PowerShell 5.1 -Encoding UTF8)
  if (!isObj(raw))
    throw new Error('appSettings.config must contain a JSON object');
  return raw;
}

/** Copy known keys from `src` into `target` when their type matches the default's type. */
function mergeKnown(target: AppSettings, src: unknown, skip?: (section: string, key: string, value: unknown) => boolean): AppSettings {
  if (!isObj(src))
    return target;
  for (const [section, values] of Object.entries(target) as [string, Obj][]) {
    const patch = src[section];
    if (!isObj(patch))
      continue;
    for (const key of Object.keys(values)) {
      const value = patch[key];
      if (typeof value === typeof values[key] && !skip?.(section, key, value))
        values[key] = value;
    }
  }
  return target;
}

function masked(settings: AppSettings): AppSettings {
  const out = structuredClone(settings);
  for (const [section, values] of Object.entries(out) as [string, Obj][]) {
    for (const key of Object.keys(values)) {
      if (isSecret(section, key) && values[key])
        values[key] = SECRET_MASK;
    }
  }
  return out;
}

/** Full settings including secrets (main process only). Creates appSettings.config with defaults if missing. */
export async function loadSettings(): Promise<AppSettings> {
  const raw = await readRaw();
  if (!raw) {
    await atomicWrite(getSettingsPath(), toJson(DEFAULT_SETTINGS), { createDirs: true });
    return structuredClone(DEFAULT_SETTINGS);
  }
  return mergeKnown(structuredClone(DEFAULT_SETTINGS), raw);
}

/** Apply a patch and write the file. Unknown keys already in the file are preserved. A changed app.dataRoot is checked. */
async function writeSettings(patch: SettingsPatch): Promise<AppSettings> {
  const raw = (await readRaw()) ?? {};
  const keepSecret = (section: string, key: string, value: unknown): boolean => value === SECRET_MASK && isSecret(section, key);
  const current = mergeKnown(structuredClone(DEFAULT_SETTINGS), raw);
  const next = mergeKnown(structuredClone(current), patch, keepSecret);
  if (next.app.dataRoot !== current.app.dataRoot) {
    const problem = dataRootProblem(dataRootDirOf(next.app.dataRoot));
    if (problem)
      throw new Error(`"${next.app.dataRoot}" cannot be the data folder: ${problem}`);
  }
  const out: Obj = { ...raw };
  for (const [section, values] of Object.entries(next))
    out[section] = { ...(isObj(raw[section]) ? raw[section] : {}), ...values };
  await atomicWrite(getSettingsPath(), toJson(out), { createDirs: true });
  return masked(next);
}

/** Store app.dataRoot (startup: the configured data folder could not be used and the user picked the default). */
export async function saveDataRootSetting(dataRoot: string): Promise<void> {
  await writeSettings({ app: { dataRoot } });
}

export function registerSettingsIpc(): void {
  handle(IPC.settingsRead, async () => masked(await loadSettings()));
  handle(IPC.settingsWrite, async (patch: SettingsPatch) => writeSettings(patch));
}
