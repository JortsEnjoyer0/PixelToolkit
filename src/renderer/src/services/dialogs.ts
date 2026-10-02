// Modal dialogs as promises. State only: DialogHost (mounted once in App.vue) renders `dialogs.stack`
// and resolves entries through dialogs.resolve() / dialogs.dismiss(). While any dialog is open, shortcuts are off.
import { computed, markRaw, shallowReactive, type Component } from 'vue';

export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  /** Red OK button. */
  danger?: boolean;
  okLabel?: string;
  cancelLabel?: string;
  /** Optional checkbox, e.g. "Delete all frames and start from the new reference". */
  checkbox?: { label: string; value: boolean };
}
export interface ConfirmResult { ok: boolean; checked: boolean }

export interface PromptOptions {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  /** Live validation: an error message disables OK. */
  validate?: (value: string) => string | null;
}

export interface ChoiceButton { id: string; label: string; kind?: 'primary' | 'danger' | 'default' }
export interface ChoiceOptions {
  title: string;
  message: string;
  detail?: string;
  /** Left to right, e.g. Save / Don't Save / Cancel. */
  buttons: ChoiceButton[];
  /** Returned on Escape or backdrop click. */
  cancelId: string;
}

interface EntryBase { id: number }
export type DialogEntry =
  | EntryBase & { kind: 'confirm'; options: ConfirmOptions }
  | EntryBase & { kind: 'prompt'; options: PromptOptions }
  | EntryBase & { kind: 'choice'; options: ChoiceOptions }
  /** The component gets `props` and emits `resolve(value?)` to close; DialogHost wires that to dialogs.resolve(). */
  | EntryBase & { kind: 'custom'; component: Component; props: Record<string, unknown> };

interface Pending { resolve: (value: unknown) => void; cancelValue: unknown; restoreFocus: Element | null }

/** Open dialogs, bottom to top (the host renders the top one modally). */
const stack = shallowReactive<DialogEntry[]>([]);
const pending = new Map<number, Pending>();
let nextId = 1;

function push<R>(entry: DialogEntry, cancelValue: R): Promise<R> {
  return new Promise<R>((resolve) => {
    pending.set(entry.id, { resolve: resolve as (v: unknown) => void, cancelValue, restoreFocus: document.activeElement });
    stack.push(entry);
  });
}

/** Close a dialog with a result (host: OK / button clicks). */
function resolve(id: number, value: unknown): void {
  const p = pending.get(id);
  const i = stack.findIndex((e) => e.id === id);
  if (!p || i < 0)
    return;
  pending.delete(id);
  stack.splice(i, 1);
  if (p.restoreFocus instanceof HTMLElement && p.restoreFocus.isConnected)
    p.restoreFocus.focus({ preventScroll: true });
  p.resolve(value);
}

/** Close with the kind's cancel value (host: Escape, backdrop, ×). */
function dismiss(id: number): void {
  resolve(id, pending.get(id)?.cancelValue);
}

export const isModalOpen = (): boolean => stack.length > 0;

export const dialogs = {
  stack: stack as readonly DialogEntry[],
  isOpen: computed(() => stack.length > 0),
  isModalOpen,
  confirm(options: ConfirmOptions): Promise<ConfirmResult> {
    const checked = options.checkbox?.value ?? false;
    return push<ConfirmResult>({ id: nextId++, kind: 'confirm', options }, { ok: false, checked });
  },
  /** Resolves the entered text, or null when cancelled. */
  prompt(options: PromptOptions): Promise<string | null> {
    return push<string | null>({ id: nextId++, kind: 'prompt', options }, null);
  },
  /** Resolves the clicked button id (cancelId on Escape). */
  choice(options: ChoiceOptions): Promise<string> {
    return push<string>({ id: nextId++, kind: 'choice', options }, options.cancelId);
  },
  /** Custom dialog component; resolves what it emits with `resolve`, or undefined when dismissed. */
  open<R = unknown>(component: Component, props: Record<string, unknown> = {}): Promise<R | undefined> {
    return push<R | undefined>({ id: nextId++, kind: 'custom', component: markRaw(component), props }, undefined);
  },
  resolve,
  dismiss
};
