import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { electronApp, is } from '@electron-toolkit/utils';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/settings';
import { handleAssetProtocol, registerAssetScheme } from './assetProtocol';
import { cleanupStaleTmp, removeMatchingFiles, setDataRoot } from './core/dataFs';
import { SUBMIT_TIMEOUT_MS } from './core/jobService';
import { sweepSessionCreated } from './core/sessionCreated';
import { startDevScreenshotServer } from './devScreenshot';
import {
  initJobs, jobReferencedUids, jobSubmitsSettled, pendingJobSubmits, registerJobsIpc, startJobPolling, stopJobPolling
} from './jobs';
import { installCloseProtocol, registerAppIpc } from './ipc/app';
import { registerFsIpc } from './ipc/fs';
import { registerImagesIpc } from './ipc/images';
import { registerPixelLabIpc } from './ipc/pixellab';
import { loadSettings, registerSettingsIpc, saveDataRootSetting } from './ipc/settings';
import {
  copyFromInstallDir, dataRootProblem, defaultDataRootDir, getAppRoot, getScreenshotDir, resolveDataRootDir, samePath
} from './paths';

registerAssetScheme();

/**
 * Screenshot automation (dev, or PT_DEV_SCREENSHOT=1): the loopback screenshot server runs and the window keeps painting
 * while minimized or covered, so capturePage/CDP screenshots are never stale or blank. Otherwise Chromium throttles a
 * hidden window as usual (a playing animation does not burn CPU/GPU in the background).
 */
const screenshotsEnabled = is.dev || process.env['PT_DEV_SCREENSHOT'] === '1';

// Windows occlusion tracking marks a covered window hidden. Must be set before 'ready'.
if (screenshotsEnabled)
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/** Dev only: PT_TESTBED=1 (or `--testbed`, see `npm run dev:testbed`) loads testbed.html instead of index.html. */
const isTestbed = is.dev && (process.env['PT_TESTBED'] === '1' || process.argv.includes('--testbed'));

/** Upper bound for the quit-time image sweep, so a stuck disk can never keep the process alive. */
const QUIT_SWEEP_TIMEOUT_MS = 10_000;
/** Upper bound for generation submits still running at quit: the POST timeout plus time to journal its answer. */
const QUIT_SUBMIT_WAIT_MS = SUBMIT_TIMEOUT_MS + 5_000;

let mainWindow: BrowserWindow | null = null;
/** A renderer called closeReady(): its docs are saved, so unreferenced session images can go on quit. */
let sweepOnQuit = false;
let quitWorkDone = false;

/** `p`, or nothing after `ms` (quit-time work must never keep the process alive). */
const bounded = (p: Promise<void>, ms: number): Promise<void> =>
  Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms))]);

function loadRenderer(win: BrowserWindow): void {
  const page = isTestbed ? 'testbed.html' : 'index.html';
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (is.dev && devUrl)
    win.loadURL(isTestbed ? `${devUrl}/${page}` : devUrl);
  else
    win.loadFile(path.join(__dirname, '../renderer', page));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0e1014',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // the preload is bundled to CJS and only requires 'electron'
      backgroundThrottling: !screenshotsEnabled // screenshots need rAF and painting while hidden
    }
  });
  mainWindow = win;
  win.on('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win)
      mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://'))
      shell.openExternal(url);
    return { action: 'deny' };
  });
  // Block in-app navigation away from our renderer
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (!(is.dev && devUrl && url.startsWith(devUrl)))
      e.preventDefault();
  });
  // No application menu (PLAN §1), so devtools get their own key in dev only
  if (is.dev) {
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12' && !input.control && !input.alt && !input.meta && !input.shift) {
        win.webContents.toggleDevTools();
        e.preventDefault();
      }
    });
  }
  installCloseProtocol(win);
  loadRenderer(win);
}

/** Session-created image sweep (PLAN Phase 1 outcomes). Never throws: a failed sweep is retried at the next start. */
async function sweepSessionImages(when: string): Promise<void> {
  try {
    const r = await sweepSessionCreated(jobReferencedUids());
    if (r.listed > 0)
      console.log(`[gc] ${when}: ${r.listed} session images listed, ${r.deleted.length} deleted, ${r.kept} kept for later`);
  } catch (e) {
    console.error(`[gc] ${when} sweep failed: ${(e as Error).message}`);
  }
}

type DataRootChoice = 'use' | 'default' | 'quit';

const DATA_ROOT_LABELS: Record<DataRootChoice, string> = { use: 'Create it', default: 'Use the default folder', quit: 'Quit' };

/** Startup question about a configured data folder that cannot be used as is. */
async function askDataRoot(message: string, detail: string, canCreate: boolean): Promise<DataRootChoice> {
  const choices: DataRootChoice[] = canCreate ? ['use', 'default', 'quit'] : ['default', 'quit'];
  const { response } = await dialog.showMessageBox({
    type: 'warning', title: 'PixelToolkit', message, detail, buttons: choices.map((c) => DATA_ROOT_LABELS[c]),
    defaultId: 0, cancelId: choices.length - 1, noLink: true
  });
  return choices[response] ?? 'quit';
}

/**
 * Open the data root (realpath), or null when the user chose to quit. The default folder and a PT_DATA_ROOT override
 * are created when missing. A configured folder that is unsafe (dataRootProblem), missing (moved, or a drive that is not
 * connected: never silently recreated empty) or cannot be opened asks first; "Use the default folder" also resets
 * app.dataRoot, so the next start agrees.
 */
async function openDataRoot(settings: AppSettings): Promise<string | null> {
  const dir = resolveDataRootDir(settings);
  const fallback = defaultDataRootDir();
  const problem = dataRootProblem(dir);
  if (process.env['PT_DATA_ROOT'] || samePath(dir, fallback)) {
    if (problem)
      throw new Error(`The data folder ${dir} cannot be used: ${problem}`);
    return setDataRoot(dir);
  }
  const useDefault = `Use the default folder: ${fallback} (the setting is changed to it).`;
  let choice: DataRootChoice = 'use';
  if (problem) {
    choice = await askDataRoot('The data folder cannot be used', `${dir}: ${problem}.\n\n${useDefault}`, false);
  } else if (!(await fsp.stat(dir).then((s) => s.isDirectory(), () => false))) {
    const detail = `${dir} does not exist. It may have been moved or renamed, or be on a drive that is not connected.\n\n`
      + `Create it: start with a new, empty data folder there.\n${useDefault}`;
    choice = await askDataRoot('The data folder was not found', detail, true);
  }
  if (choice === 'use') {
    try {
      return await setDataRoot(dir);
    } catch (e) {
      choice = await askDataRoot('The data folder could not be opened', `${dir}: ${(e as Error).message}\n\n${useDefault}`, false);
    }
  }
  if (choice !== 'default')
    return null;
  await saveDataRootSetting(DEFAULT_SETTINGS.app.dataRoot);
  return setDataRoot(fallback);
}

async function start(): Promise<void> {
  electronApp.setAppUserModelId('com.pixeltoolkit.app');
  // No menu: removes Ctrl+R reload, Ctrl+W close and the Edit-role Ctrl+Z (PLAN §1)
  Menu.setApplicationMenu(null);

  // Creates appSettings.config with defaults if missing. Data root: app.dataRoot relative to the app root
  // (dev: <project>, packaged: userData), PT_DATA_ROOT overrides it. Older packaged builds kept both beside the exe.
  await copyFromInstallDir('appSettings.config');
  const settings = await loadSettings();
  if (!process.env['PT_DATA_ROOT'])
    await copyFromInstallDir(settings.app.dataRoot || DEFAULT_SETTINGS.app.dataRoot);
  const dataRoot = await openDataRoot(settings);
  if (dataRoot === null) {
    app.quit();
    return;
  }
  const tmpCount = await cleanupStaleTmp() + await removeMatchingFiles(getAppRoot(), /^appSettings\.config\.[0-9a-f]{12}\.tmp$/i, 0);
  if (tmpCount > 0)
    console.log(`[fs] removed ${tmpCount} stale temp files`);
  console.log(`[main] data root: ${dataRoot}`);

  await initJobs();
  await sweepSessionImages('startup');

  handleAssetProtocol();
  registerFsIpc();
  registerSettingsIpc();
  registerImagesIpc();
  registerPixelLabIpc();
  registerJobsIpc();
  registerAppIpc({
    closeReady: () => {
      sweepOnQuit = true;
    }
  });
  createWindow();
  startJobPolling();

  if (screenshotsEnabled)
    startDevScreenshotServer(() => mainWindow, getScreenshotDir());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0)
      createWindow();
  });
}

// One packaged instance at a time: two would share the data root, the job journal and the session-created list (a
// second instance's startup sweep could delete images the first one has not saved yet). Not enforced in dev, where
// electron-vite restarts main by killing and respawning Electron (a lock could race); there, never run two instances.
if (!is.dev && !app.requestSingleInstanceLock()) {
  console.warn('[main] PixelToolkit is already running; focusing the existing window');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed())
      return;
    if (mainWindow.isMinimized())
      mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(start).catch((e: Error) => {
    dialog.showErrorBox('PixelToolkit failed to start', e?.stack ?? String(e));
    app.quit();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
      app.quit();
  });

  // Before quitting: let generation submits still in flight journal PixelLab's answer (an accepted, billed job keeps
  // its id instead of becoming "interrupted"), then, after a clean close (closeReady), sweep the images this session
  // created but no saved json references.
  app.on('will-quit', (e) => {
    stopJobPolling();
    const submits = pendingJobSubmits();
    if (quitWorkDone || (!sweepOnQuit && submits === 0))
      return;
    e.preventDefault();
    quitWorkDone = true;
    void (async () => {
      if (submits > 0) {
        console.log(`[main] waiting for ${submits} generation submit(s) before quitting`);
        await bounded(jobSubmitsSettled(), QUIT_SUBMIT_WAIT_MS);
      }
      if (sweepOnQuit)
        await bounded(sweepSessionImages('quit'), QUIT_SWEEP_TIMEOUT_MS);
    })().finally(() => app.quit());
  });
}
