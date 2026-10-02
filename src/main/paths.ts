import { app } from 'electron';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings';

/**
 * Dir holding appSettings.config and (by default) data/. Dev: the project folder (app.getAppPath()). Packaged: the folder
 * of a portable exe (PORTABLE_EXECUTABLE_DIR, set by electron-builder's portable target), else userData
 * (%APPDATA%\PixelToolkit). Never the install dir: the NSIS installer deletes it on every update and uninstall.
 */
export function getAppRoot(): string {
  if (!app.isPackaged)
    return app.getAppPath();
  return process.env['PORTABLE_EXECUTABLE_DIR'] || app.getPath('userData');
}

/** appSettings.config (JSON): <project>/appSettings.config in dev. */
export const getSettingsPath = (): string => path.join(getAppRoot(), 'appSettings.config');

/** Dev screenshots: <project>/.screenshots in dev. */
export const getScreenshotDir = (): string => path.join(getAppRoot(), '.screenshots');

/** An app.dataRoot value as an absolute dir: relative values resolve against the app root, '' is the default ('./data'). */
export const dataRootDirOf = (dataRoot: string): string => path.resolve(getAppRoot(), dataRoot || DEFAULT_SETTINGS.app.dataRoot);

/** Data root: PT_DATA_ROOT if set, else settings.app.dataRoot. */
export const resolveDataRootDir = (settings: AppSettings): string => dataRootDirOf(process.env['PT_DATA_ROOT'] || settings.app.dataRoot);

export const defaultDataRootDir = (): string => dataRootDirOf(DEFAULT_SETTINGS.app.dataRoot);

/** `dir` is `other` or one of its ancestors (case-insensitive on Windows, like path.relative). */
export function isAtOrAbove(dir: string, other: string): boolean {
  const r = path.relative(dir, other);
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
}

export const samePath = (a: string, b: string): boolean => path.relative(a, b) === '';

/** Dir of the running exe: the install dir when packaged (replaced by every update). */
const getInstallDir = (): string => path.dirname(app.getPath('exe'));

/**
 * Why the absolute `dir` cannot be the data root, or null. The data root is the renderer's fs sandbox and is cleaned at
 * startup, so it may not be a drive root, the home folder, the app folder (appSettings.config holds the API keys) or a
 * folder above one of them; packaged, nor anything inside the install dir.
 */
export function dataRootProblem(dir: string): string | null {
  if (path.parse(dir).root === dir)
    return 'it is a drive root';
  if (isAtOrAbove(dir, os.homedir()))
    return 'it is your user folder or a folder above it';
  if (isAtOrAbove(dir, getAppRoot()))
    return 'it is the app folder (which holds appSettings.config) or a folder above it';
  if (app.isPackaged && isAtOrAbove(getInstallDir(), dir))
    return 'it is inside the install folder, which every update and uninstall deletes';
  return null;
}

const pathExists = (p: string): Promise<boolean> => fsp.access(p).then(() => true, () => false);

/**
 * Older packaged builds kept appSettings.config and data/ beside the exe, in the NSIS install dir that every update
 * and uninstall deletes. Copies `rel` (a file or dir relative to the app root) from there once, when only that old copy
 * exists. The copy goes to a temp name first, so an interrupted copy is redone at the next start.
 */
export async function copyFromInstallDir(rel: string): Promise<void> {
  if (!app.isPackaged)
    return;
  const installDir = getInstallDir();
  const from = path.resolve(installDir, rel);
  const to = path.resolve(getAppRoot(), rel);
  // Only what lives strictly inside the install dir is at risk (an absolute or escaping rel is left where it is)
  if (!isAtOrAbove(installDir, from) || isAtOrAbove(from, installDir) || isAtOrAbove(from, to) || isAtOrAbove(to, from))
    return;
  if (!(await pathExists(from)) || await pathExists(to))
    return;
  const tmp = `${to}.migrating`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.cp(from, tmp, { recursive: true });
  await fsp.rename(tmp, to);
  console.log(`[main] copied ${from} to ${to} (the install dir is deleted on updates)`);
}
