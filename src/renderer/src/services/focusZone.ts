// Which UI zone the user last interacted with: pointerdown or focusin inside an element tagged data-zone="…".
// Pointerdown / focusin inside an element tagged data-zone-ignore (context menu, toasts) keeps the current zone.
// Drives zone-scoped shortcuts (services/shortcuts.ts). Installs its document listeners on first import.
import { readonly, ref } from 'vue';

export const ZONES = ['explorer', 'tabs', 'panel', 'editor', 'frametrack', 'img2pixel-panel', 'img2pixel-stage'] as const;
export type Zone = typeof ZONES[number];

const current = ref<Zone | null>(null);

/** Nearest data-zone ancestor of a node (null outside every zone). */
export function zoneOf(target: EventTarget | null): Zone | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const z = el?.closest('[data-zone]')?.getAttribute('data-zone') ?? null;
  return z !== null && (ZONES as readonly string[]).includes(z) ? z as Zone : null;
}

/** Overlays that must not change the zone when clicked (context menu, toasts) carry data-zone-ignore. */
const track = (e: Event): void => {
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest('[data-zone-ignore]'))
    return;
  current.value = zoneOf(e.target);
};

let installed = false;

/** Idempotent; called automatically when this module loads in a browser. */
export function installFocusZone(): void {
  if (installed || typeof document === 'undefined')
    return;
  installed = true;
  document.addEventListener('pointerdown', track, true);
  document.addEventListener('focusin', track, true);
}

export const focusZone = {
  /** Reactive current zone (null = outside every zone, e.g. the nav bar or a dialog). */
  current: readonly(current),
  get: (): Zone | null => current.value,
  /** Programmatic switch, e.g. after opening a tab moves focus to the editor. */
  set: (zone: Zone | null): void => {
    current.value = zone;
  },
  zoneOf,
  install: installFocusZone
};

installFocusZone();
