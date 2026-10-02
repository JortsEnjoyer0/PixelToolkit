import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { is } from '@electron-toolkit/utils';
import { IPC, type AppInfo } from '../../shared/api';
import { getDataRoot, resolveChecked } from '../core/dataFs';
import { getAppRoot } from '../paths';
import { handle, isTrustedSender, validateSender } from './handle';

/** No acknowledgement of app:before-close within this time: dev closes anyway, production asks "Quit anyway?". */
const CLOSE_TIMEOUT_MS = is.dev ? 3000 : 10_000;

interface CloseState { done: boolean; prompting: boolean; fallback: NodeJS.Timeout | null }

const closeStates = new WeakMap<BrowserWindow, CloseState>();

let onCloseReady: () => void = () => {};

function clearFallback(state: CloseState): void {
  if (state.fallback) {
    clearTimeout(state.fallback);
    state.fallback = null;
  }
}

function finishClose(win: BrowserWindow): void {
  const state = closeStates.get(win);
  if (state) {
    state.done = true;
    clearFallback(state);
  }
  if (!win.isDestroyed())
    win.destroy();
}

const rendererGone = (win: BrowserWindow): boolean => win.webContents.isDestroyed() || win.webContents.isCrashed();

/** Production failsafe: the renderer is gone or did not answer. Dev keeps the old behaviour (close right away). */
async function quitAnyway(win: BrowserWindow, gone: boolean): Promise<void> {
  const state = closeStates.get(win);
  if (!state || state.done || state.prompting || win.isDestroyed())
    return;
  if (is.dev) {
    console.warn(`[close] renderer ${gone ? 'is gone' : `did not answer ${IPC.appBeforeClose} within ${CLOSE_TIMEOUT_MS} ms`}; closing anyway (dev only)`);
    finishClose(win);
    return;
  }
  state.prompting = true;
  const buttons = gone ? ['Quit anyway', 'Reload window', 'Cancel'] : ['Quit anyway', 'Keep waiting'];
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'PixelToolkit',
    message: 'Quit anyway?',
    detail: gone
      ? 'The editor stopped working, so unsaved changes cannot be saved.'
      : `The editor did not respond to the close request within ${CLOSE_TIMEOUT_MS / 1000} seconds. Unsaved changes may be lost.`,
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    noLink: true
  });
  state.prompting = false;
  if (response === 0)
    finishClose(win);
  else if (gone && response === 1 && !win.isDestroyed())
    win.webContents.reload();
}

/**
 * Close protocol: a close is cancelled and the renderer receives app:before-close. The renderer flushes / prompts and
 * calls api.app.closeReady(), then the window is destroyed. Every further close attempt re-sends app:before-close (the
 * renderer must ignore it while a prompt is open). The preload acknowledges receipt (app:close-ack) and answers by
 * itself when nothing listens. No acknowledgement within CLOSE_TIMEOUT_MS, or a dead renderer → quitAnyway().
 */
export function installCloseProtocol(win: BrowserWindow): void {
  const state: CloseState = { done: false, prompting: false, fallback: null };
  closeStates.set(win, state);
  win.on('close', (e) => {
    if (state.done)
      return;
    e.preventDefault();
    if (rendererGone(win)) {
      void quitAnyway(win, true);
      return;
    }
    win.webContents.send(IPC.appBeforeClose);
    if (!state.fallback) {
      state.fallback = setTimeout(() => {
        state.fallback = null;
        void quitAnyway(win, false);
      }, CLOSE_TIMEOUT_MS);
    }
  });
}

/** `closeReady` runs after a renderer finished its close work (main sweeps session-created images on quit). */
export function registerAppIpc(opts: { closeReady?: () => void } = {}): void {
  onCloseReady = opts.closeReady ?? onCloseReady;
  ipcMain.on(IPC.appCloseAck, (e) => {
    const win = isTrustedSender(e) ? BrowserWindow.fromWebContents(e.sender) : null;
    const state = win ? closeStates.get(win) : undefined;
    if (state)
      clearFallback(state);
  });
  ipcMain.handle(IPC.appCloseReady, async (e) => {
    validateSender(e);
    const win = BrowserWindow.fromWebContents(e.sender);
    onCloseReady();
    if (win)
      setImmediate(() => finishClose(win)); // let the invoke reply go out first
  });
  handle(IPC.appRevealInExplorer, async (rel: string) => {
    shell.showItemInFolder(await resolveChecked(rel, { allowRoot: true }));
  });
  ipcMain.handle(IPC.appFlashFrame, async (e) => {
    validateSender(e);
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed() && !win.isFocused())
      win.flashFrame(true); // Windows stops flashing when the window gains focus
  });
  handle(IPC.appGetInfo, async (): Promise<AppInfo> => ({ dataRoot: getDataRoot(), appRoot: getAppRoot(), isDev: is.dev }));
}
