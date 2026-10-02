// Global error reporting (installed by bootstrap.ts): Vue errors, unhandled rejections and uncaught errors are
// logged and shown as an error toast. Code awaits window.api and lets unexpected failures propagate here instead
// of wrapping every call in try/catch (CodeGuide).
import type { App } from 'vue';
import { IPC_ERROR_PREFIX } from '@shared/api';
import { toasts } from './toasts';

/** Browser noise that is not an app error. */
const IGNORED = [/ResizeObserver loop/];
const DEDUPE_MS = 2000;

let lastText = '';
let lastAt = 0;

/** User-facing message of anything thrown (strips Electron's "Error invoking remote method …" prefix). */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : (() => {
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  })();
  return (raw ?? '').replace(IPC_ERROR_PREFIX, '').trim() || 'Unknown error';
}

/** Log and toast an unexpected error (identical messages within 2 s are shown once). */
export function reportError(e: unknown, title = 'Something went wrong'): void {
  const message = errorMessage(e);
  if (IGNORED.some((re) => re.test(message)))
    return;
  console.error(`[${title}]`, e);
  const now = performance.now();
  if (message === lastText && now - lastAt < DEDUPE_MS)
    return;
  lastText = message;
  lastAt = now;
  toasts.push({ kind: 'error', title, message });
}

let installed = false;

/** Vue errorHandler plus window 'error' / 'unhandledrejection' listeners (window listeners installed once). */
export function installGlobalErrorHandling(app: App): void {
  app.config.errorHandler = (err) => reportError(err);
  if (installed)
    return;
  installed = true;
  window.addEventListener('unhandledrejection', (e) => {
    e.preventDefault();
    reportError(e.reason);
  });
  window.addEventListener('error', (e) => {
    if (e.error !== undefined || e.message)
      reportError(e.error ?? e.message);
  });
}
