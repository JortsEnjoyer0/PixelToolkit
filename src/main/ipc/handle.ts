import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { Result } from '../../shared/api';

/** True when the IPC comes from our own renderer (dev server URL or packaged file://). */
export function isTrustedSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  const dev = process.env['ELECTRON_RENDERER_URL'];
  return url.startsWith('file://') || (!!dev && url.startsWith(dev));
}

export function validateSender(e: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isTrustedSender(e))
    throw new Error(`Blocked IPC from ${e.senderFrame?.url ?? '?'}`);
}

/** ipcMain.handle with sender validation. Rejections propagate to the renderer's invoke(). */
export function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (e, ...args) => {
    validateSender(e);
    return fn(...(args as A));
  });
}

/** Like handle(), but the handler also receives the invoke event (to find the sender's window). */
export function handleWithEvent<A extends unknown[], R>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (e, ...args) => {
    validateSender(e);
    return fn(e, ...(args as A));
  });
}

/** For Result-returning operations (PixelLab, jobs): never rejects across IPC; any throw becomes { ok: false }. */
export function handleResult<A extends unknown[], T>(channel: string, fn: (...args: A) => Promise<Result<T>>): void {
  ipcMain.handle(channel, async (e, ...args): Promise<Result<T>> => {
    try {
      validateSender(e);
      return await fn(...(args as A));
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  });
}
