// Global context menu. State only: ContextMenuHost renders `contextMenu.state` at (x, y),
// calls contextMenu.run(item) on click and contextMenu.close() on Escape / outside pointerdown / blur.
import { markRaw, shallowReactive, type Component } from 'vue';

export interface MenuItem {
  label: string;
  icon?: Component;
  /** Display only, e.g. 'F2', 'Del' (bind the key itself with services/shortcuts). */
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  action: () => void;
}
export interface MenuSeparator { separator: true }
export type MenuEntry = MenuItem | MenuSeparator;

export const SEPARATOR: MenuSeparator = { separator: true };
export const isSeparator = (e: MenuEntry): e is MenuSeparator => 'separator' in e;

interface MenuState { open: boolean; x: number; y: number; items: readonly MenuEntry[] }

const state = shallowReactive<MenuState>({ open: false, x: 0, y: 0, items: [] });
let restoreFocus: Element | null = null;

function close(): void {
  if (!state.open)
    return;
  state.open = false;
  state.items = [];
  if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected)
    restoreFocus.focus({ preventScroll: true });
  restoreFocus = null;
}

export const contextMenu = {
  state: state as Readonly<MenuState>,
  /** Open at the pointer (MouseEvent: default menu prevented) or at explicit client coordinates. */
  open(at: MouseEvent | { x: number; y: number }, items: MenuEntry[]): void {
    if (at instanceof MouseEvent) {
      at.preventDefault();
      at.stopPropagation();
    }
    if (!state.open)
      restoreFocus = document.activeElement;
    state.x = at instanceof MouseEvent ? at.clientX : at.x;
    state.y = at instanceof MouseEvent ? at.clientY : at.y;
    state.items = items.map((e) => isSeparator(e) || !e.icon ? e : { ...e, icon: markRaw(e.icon) });
    state.open = true;
  },
  close,
  /** Close (restoring focus first), then run the item's action. Disabled items are ignored. */
  run(item: MenuItem): void {
    if (item.disabled)
      return;
    close();
    item.action();
  },
  isOpen: (): boolean => state.open
};
