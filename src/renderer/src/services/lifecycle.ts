// App close handshake (PLAN §5 Saving, Phase 1 outcomes). Main sends 'app:before-close' on every close attempt;
// installCloseHandshake() (App.vue) runs the registered close handlers one after another in registration order.
// When every handler resolves true, api.app.closeReady() lets main destroy the window; the first false aborts the
// close (e.g. Cancel in the unsaved-changes prompt). Repeats are ignored while handlers run. A handler that throws
// aborts too, after offering "Quit anyway".
import { contextMenu } from './contextMenu';
import { dialogs } from './dialogs';
import { errorMessage } from './errors';

/** Resolve false to cancel the close. Handlers may prompt (dialogs), save and flush. */
export type CloseHandler = () => Promise<boolean>;

const handlers: CloseHandler[] = [];
let running = false;
/** closeReady() was sent: the window is going away. */
let closing = false;
let off: (() => void) | null = null;

/** Register a close handler (runs after the ones registered before it). Returns the unregister function. */
export function registerCloseHandler(fn: CloseHandler): () => void {
  handlers.push(fn);
  return () => {
    const i = handlers.indexOf(fn);
    if (i >= 0)
      handlers.splice(i, 1);
  };
}

/** Run every handler in order; false as soon as one declines. Throws when a handler throws. */
export async function runCloseHandlers(): Promise<boolean> {
  for (const fn of [...handlers]) {
    if (!await fn())
      return false;
  }
  return true;
}

async function quitAnyway(e: unknown): Promise<boolean> {
  console.error('[close] a close handler failed', e);
  const res = await dialogs.confirm({
    title: 'Could not prepare to close',
    message: 'Something failed while saving or cleaning up. Unsaved changes may be lost if you quit now.',
    detail: errorMessage(e),
    danger: true,
    okLabel: 'Quit Anyway',
    cancelLabel: 'Stay'
  });
  return res.ok;
}

async function onBeforeClose(): Promise<void> {
  if (running || closing)
    return;
  running = true;
  try {
    contextMenu.close();
    let ok: boolean;
    try {
      ok = await runCloseHandlers();
    } catch (e) {
      ok = await quitAnyway(e);
    }
    if (!ok)
      return;
    closing = true;
    try {
      await window.api.app.closeReady();
    } catch (e) {
      closing = false;
      throw e;
    }
  } finally {
    running = false;
  }
}

/** Subscribe to 'app:before-close' (idempotent). Returns the unsubscribe function. */
export function installCloseHandshake(): () => void {
  off ??= window.api.on('app:before-close', () => {
    void onBeforeClose();
  });
  return () => {
    off?.();
    off = null;
  };
}

export const lifecycle = {
  registerCloseHandler,
  runCloseHandlers,
  installCloseHandshake,
  /** Close handlers are running (a prompt may be open). */
  isRunning: (): boolean => running,
  /** The close handshake is running or finished: skip beforeunload guards and new long work. */
  isClosing: (): boolean => running || closing
};
