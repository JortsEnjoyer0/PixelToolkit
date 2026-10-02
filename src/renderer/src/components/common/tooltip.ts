// Global v-tooltip directive with ONE shared tooltip element (plain DOM, created on first use, nothing to mount).
//   v-tooltip="'Play'"   v-tooltip="{ text: 'Save', shortcut: 'Ctrl+S' }"   v-tooltip.right="'Settings'"
// Shows after ~500 ms of hover (instantly while "warm", i.e. right after another tooltip hid) or on keyboard focus.
// Hides on leave, pointerdown, wheel, scroll, keydown and window blur. Positioned next to the element, flipped to
// the opposite side when it does not fit, then clamped to the viewport. Installed by bootstrap.ts (app.use(tooltipPlugin)).
import type { App, Directive, DirectiveBinding } from 'vue';
import { clamp } from '../../core/util/math';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';
export interface TooltipOptions {
  text: string;
  /** Shortcut hint shown as a key cap, e.g. 'Ctrl+S'. */
  shortcut?: string;
  /** Default 'bottom' (or the directive modifier). */
  placement?: TooltipPlacement;
  /** Hover delay override, ms. */
  delay?: number;
}
/** Falsy or empty text disables the tooltip. */
export type TooltipValue = string | TooltipOptions | null | undefined | false;

const SHOW_DELAY_MS = 500;
/** After a tooltip hides, the next one shows without delay within this window (moving along a toolbar). */
const WARM_MS = 350;
const GAP_PX = 6;
const MARGIN_PX = 4;
const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const PLACEMENTS: readonly TooltipPlacement[] = ['top', 'bottom', 'left', 'right'];

interface Target {
  opts: TooltipOptions | null;
  enter: () => void;
  leave: () => void;
  focus: () => void;
}

interface TipParts { tip: HTMLDivElement; text: HTMLSpanElement; key: HTMLSpanElement }

const targets = new WeakMap<HTMLElement, Target>();
let parts: TipParts | null = null;
/** Element whose tooltip is visible. */
let current: HTMLElement | null = null;
/** Element waiting for its show timer. */
let pending: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastHideAt = -Infinity;

function normalize(binding: DirectiveBinding<TooltipValue, TooltipPlacement>): TooltipOptions | null {
  const v = binding.value;
  if (!v)
    return null;
  const opts: TooltipOptions = typeof v === 'string' ? { text: v } : { ...v };
  if (!opts.text)
    return null;
  if (!opts.placement)
    opts.placement = PLACEMENTS.find((p) => binding.modifiers[p]) ?? 'bottom';
  return opts;
}

/** The shared element (created once, on first use). */
export function ensureTooltipElement(): TipParts {
  if (parts)
    return parts;
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.id = 'ptk-tooltip';
  tip.setAttribute('role', 'tooltip');
  const text = document.createElement('span');
  text.className = 'tooltip-text';
  const key = document.createElement('span');
  key.className = 'kbd tooltip-shortcut';
  tip.append(text, key);
  document.body.appendChild(tip);
  parts = { tip, text, key };
  const hide = (): void => hideTooltip();
  window.addEventListener('pointerdown', hide, true);
  window.addEventListener('wheel', hide, { capture: true, passive: true });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  return parts;
}

function position(el: HTMLElement, placement: TooltipPlacement): void {
  const { tip } = ensureTooltipElement();
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fits = (p: TooltipPlacement): boolean => {
    switch (p) {
      case 'top':
        return r.top - GAP_PX - h >= MARGIN_PX;
      case 'bottom':
        return r.bottom + GAP_PX + h <= vh - MARGIN_PX;
      case 'left':
        return r.left - GAP_PX - w >= MARGIN_PX;
      default:
        return r.right + GAP_PX + w <= vw - MARGIN_PX;
    }
  };
  const side = !fits(placement) && fits(OPPOSITE[placement]) ? OPPOSITE[placement] : placement;
  let x: number;
  let y: number;
  if (side === 'top' || side === 'bottom') {
    x = r.left + r.width / 2 - w / 2;
    y = side === 'bottom' ? r.bottom + GAP_PX : r.top - GAP_PX - h;
  } else {
    x = side === 'right' ? r.right + GAP_PX : r.left - GAP_PX - w;
    y = r.top + r.height / 2 - h / 2;
  }
  x = clamp(x, MARGIN_PX, vw - MARGIN_PX - w);
  y = clamp(y, MARGIN_PX, vh - MARGIN_PX - h);
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function render(el: HTMLElement, opts: TooltipOptions): void {
  const { text, key } = ensureTooltipElement();
  text.textContent = opts.text;
  key.textContent = opts.shortcut ?? '';
  key.hidden = !opts.shortcut;
  position(el, opts.placement ?? 'bottom');
}

function show(el: HTMLElement): void {
  pending = null;
  const opts = targets.get(el)?.opts;
  if (!opts || !el.isConnected)
    return;
  if (current && current !== el)
    current.removeAttribute('aria-describedby');
  current = el;
  render(el, opts);
  el.setAttribute('aria-describedby', 'ptk-tooltip');
  ensureTooltipElement().tip.classList.add('is-visible');
}

function schedule(el: HTMLElement): void {
  const opts = targets.get(el)?.opts;
  clearTimeout(timer);
  if (!opts || current === el)
    return;
  const warm = current !== null || performance.now() - lastHideAt < WARM_MS;
  const delay = opts.delay ?? (warm ? 0 : SHOW_DELAY_MS);
  pending = el;
  if (delay <= 0) {
    show(el);
    return;
  }
  timer = setTimeout(() => show(el), delay);
}

/** Hide the visible tooltip and cancel a pending one (also used by dialogs and menus when they open). */
export function hideTooltip(): void {
  clearTimeout(timer);
  pending = null;
  if (!current)
    return;
  current.removeAttribute('aria-describedby');
  current = null;
  lastHideAt = performance.now();
  parts?.tip.classList.remove('is-visible');
}

function release(el: HTMLElement): void {
  if (current === el || pending === el)
    hideTooltip();
}

export const vTooltip: Directive<HTMLElement, TooltipValue, TooltipPlacement> = {
  mounted(el, binding) {
    const target: Target = {
      opts: normalize(binding),
      enter: () => schedule(el),
      leave: () => release(el),
      focus: () => {
        if (el.matches(':focus-visible'))
          schedule(el);
      }
    };
    targets.set(el, target);
    // pointer events also fire on disabled buttons (mouse events do not), so disabled controls keep their tooltip
    el.addEventListener('pointerenter', target.enter);
    el.addEventListener('pointerleave', target.leave);
    el.addEventListener('focus', target.focus);
    el.addEventListener('blur', target.leave);
  },
  updated(el, binding) {
    const target = targets.get(el);
    if (!target)
      return;
    target.opts = normalize(binding);
    if (current !== el)
      return;
    if (target.opts)
      render(el, target.opts);
    else
      hideTooltip();
  },
  beforeUnmount(el) {
    const target = targets.get(el);
    release(el);
    if (!target)
      return;
    el.removeEventListener('pointerenter', target.enter);
    el.removeEventListener('pointerleave', target.leave);
    el.removeEventListener('focus', target.focus);
    el.removeEventListener('blur', target.leave);
    targets.delete(el);
  }
};

/** app.use(tooltipPlugin): registers v-tooltip globally. */
export const tooltipPlugin = {
  install(app: App): void {
    app.directive('tooltip', vTooltip);
  }
};

declare module 'vue' {
  interface GlobalDirectives {
    vTooltip: typeof vTooltip;
  }
}
