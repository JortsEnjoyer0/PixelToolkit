// App notifications (operation finished / failed). State only: ToastHost renders `toasts.list`.
import { shallowReactive } from 'vue';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction { label: string; run: () => void }

export interface ToastOptions {
  kind: ToastKind;
  title: string;
  message?: string;
  /** e.g. { label: 'Open', run } on a finished generation. Clicking it also dismisses the toast. */
  action?: ToastAction;
  /** Auto-dismiss delay; 0 = sticky. Default by kind (info/success 4 s, warning 6 s, error 8 s). */
  timeoutMs?: number;
}

export interface Toast extends ToastOptions { id: number; createdAt: number }

const DEFAULT_TIMEOUT: Record<ToastKind, number> = { info: 4000, success: 4000, warning: 6000, error: 8000 };
const MAX_TOASTS = 5;

/** Oldest first. */
const list = shallowReactive<Toast[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextId = 1;

function dismiss(id: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const i = list.findIndex((t) => t.id === id);
  if (i >= 0)
    list.splice(i, 1);
}

function arm(id: number, ms: number): void {
  clearTimeout(timers.get(id));
  if (ms > 0)
    timers.set(id, setTimeout(() => dismiss(id), ms));
}

export const toasts = {
  list: list as readonly Toast[],
  /** Show a toast; returns its id. */
  push(opts: ToastOptions): number {
    const toast: Toast = { ...opts, id: nextId++, createdAt: Date.now() };
    list.push(toast);
    while (list.length > MAX_TOASTS)
      dismiss(list[0].id);
    arm(toast.id, opts.timeoutMs ?? DEFAULT_TIMEOUT[opts.kind]);
    return toast.id;
  },
  dismiss,
  /** Stop the auto-dismiss timer (host: pointer over the toast). */
  hold(id: number): void {
    clearTimeout(timers.get(id));
    timers.delete(id);
  },
  /** Restart the auto-dismiss timer (host: pointer left the toast). */
  release(id: number): void {
    const t = list.find((x) => x.id === id);
    if (t)
      arm(id, t.timeoutMs ?? DEFAULT_TIMEOUT[t.kind]);
  },
  /** Run a toast's action, then dismiss it. */
  runAction(id: number): void {
    const t = list.find((x) => x.id === id);
    dismiss(id);
    t?.action?.run();
  },
  clear(): void {
    for (const t of [...list])
      dismiss(t.id);
  }
};
