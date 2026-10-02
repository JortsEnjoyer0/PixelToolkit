// Keyboard shortcuts with one window keydown listener and the zone rules of PLAN §5:
// - handlers of the current focus zone run first, then 'global' ones (newest registration first in each group);
// - keys from text-editable targets are ignored unless the shortcut sets allowInInputs (Ctrl+S);
// - plain arrows are left to targets that own them (text fields, range inputs, selects);
// - everything is suppressed while a modal dialog or the context menu is open;
// - blockWhileInteracting shortcuts (Ctrl+Z / Ctrl+Y) are skipped while the editor drags (setInteracting);
// - WASD / Space / C are handled by the editor on its own container, never here.
// Combos: modifiers in any order + one key, case-insensitive: 'ctrl+z', 'ctrl+shift+z', 'delete', 'left', 'f2'.
import { contextMenu } from './contextMenu';
import { isModalOpen } from './dialogs';
import { focusZone, type Zone } from './focusZone';

export type ShortcutScope = Zone | 'global';

export interface ShortcutOptions {
  /** Also fire when focus is in a text field (e.g. Ctrl+S). */
  allowInInputs?: boolean;
  /** Skip while the editor is interacting (Ctrl+Z / Ctrl+Y). */
  blockWhileInteracting?: boolean;
  /** Ignore auto-repeat keydowns. */
  noRepeat?: boolean;
}

/** Return false to decline (the next handler, then the browser default, gets the key). */
export type ShortcutHandler = (e: KeyboardEvent) => void | boolean;

interface Entry { scope: ShortcutScope; handler: ShortcutHandler; opts: ShortcutOptions }

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
const KEY_ALIASES: Record<string, string> = {
  ' ': 'space', spacebar: 'space', arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  esc: 'escape', del: 'delete', return: 'enter', control: 'ctrl', cmd: 'meta', command: 'meta', option: 'alt'
};
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'password', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
const ARROWS = new Set(['left', 'right', 'up', 'down']);

const registry = new Map<string, Entry[]>();
let interacting = false;
let installed = false;

const keyName = (k: string): string => {
  const lower = k.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
};

/** Canonical form of a combo string: 'Shift+Ctrl+Z' → 'ctrl+shift+z'. */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+').map((p) => keyName(p.trim())).filter((p) => p !== '');
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  const key = parts.filter((p) => !(MODIFIERS as readonly string[]).includes(p)).pop() ?? '';
  return [...mods, key].join('+');
}

export function eventCombo(e: KeyboardEvent): string {
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta'].filter(Boolean);
  return [...mods, keyName(e.key)].join('+');
}

/** Text inputs, textareas and contenteditable (checkboxes, buttons, ranges and selects are not). */
export function isTextEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement))
    return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement)
    return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

/**
 * Commit the focused text field: fields apply on blur, so call this before reading `dirty` or saving (explicit save,
 * tab close, app close) and before the active doc changes, so the edit lands in the doc it was typed for.
 */
export function blurTextField(): void {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (isTextEditable(el))
    (el as HTMLElement).blur();
}

const ownsArrows = (target: EventTarget | null): boolean =>
  isTextEditable(target) || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === 'range');

function eligible(entry: Entry, e: KeyboardEvent, key: string): boolean {
  if (entry.opts.noRepeat && e.repeat)
    return false;
  if (entry.opts.blockWhileInteracting && interacting)
    return false;
  if (isTextEditable(e.target) && !entry.opts.allowInInputs)
    return false;
  return !(ARROWS.has(key) && !e.ctrlKey && !e.altKey && !e.metaKey && ownsArrows(e.target));
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || isModalOpen() || contextMenu.isOpen())
    return;
  const key = keyName(e.key);
  if ((MODIFIERS as readonly string[]).includes(key))
    return;
  const entries = registry.get(eventCombo(e));
  if (!entries)
    return;
  const zone = focusZone.get();
  const newestFirst = [...entries].reverse();
  const candidates = [...newestFirst.filter((x) => x.scope === zone), ...newestFirst.filter((x) => x.scope === 'global')];
  for (const entry of candidates) {
    if (!eligible(entry, e, key))
      continue;
    if (entry.handler(e) === false)
      continue;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
}

/** Idempotent; called automatically on the first register(). */
export function installShortcuts(): void {
  if (installed || typeof window === 'undefined')
    return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
}

export const shortcuts = {
  /** Bind `combo` in a zone (or globally). Returns the unregister function. */
  register(scope: ShortcutScope, combo: string, handler: ShortcutHandler, opts: ShortcutOptions = {}): () => void {
    installShortcuts();
    const key = normalizeCombo(combo);
    const entry: Entry = { scope, handler, opts };
    const list = registry.get(key) ?? [];
    list.push(entry);
    registry.set(key, list);
    return () => {
      const l = registry.get(key);
      const i = l?.indexOf(entry) ?? -1;
      if (l && i >= 0)
        l.splice(i, 1);
    };
  },
  /** EditorPane forwards the viewport's 'interaction' event here. */
  setInteracting(active: boolean): void {
    interacting = active;
  },
  isInteracting: (): boolean => interacting,
  isTextEditable,
  normalizeCombo
};
