// Quick text at the mouse ("Undo Rotate Left Forearm", "Saved") that rises slowly and fades fast.
// The pointer is tracked globally so keyboard-triggered notes also appear at the cursor.
// State only: MouseNotifyHost renders `mouseNotifyState.notes` (animate over NOTE_LIFETIME_MS from t).
import { shallowReactive } from 'vue';

export interface MouseNote {
  id: number;
  text: string;
  /** Client px of the pointer when the note was created. */
  x: number;
  y: number;
  /** performance.now() at creation. */
  t: number;
}

export const NOTE_LIFETIME_MS = 1100;
const MAX_NOTES = 4;

const notes = shallowReactive<MouseNote[]>([]);
const pointer = { x: 0, y: 0 };
let nextId = 1;
let installed = false;

/** Idempotent; called automatically when this module loads in a browser. */
export function installPointerTracking(): void {
  if (installed || typeof window === 'undefined')
    return;
  installed = true;
  pointer.x = window.innerWidth / 2;
  pointer.y = window.innerHeight / 2;
  window.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }, { capture: true, passive: true });
}

/** Show `text` at the current pointer position. */
export function mouseNotify(text: string): void {
  const note: MouseNote = { id: nextId++, text, x: pointer.x, y: pointer.y, t: performance.now() };
  notes.push(note);
  while (notes.length > MAX_NOTES)
    notes.shift();
  setTimeout(() => {
    const i = notes.findIndex((n) => n.id === note.id);
    if (i >= 0)
      notes.splice(i, 1);
  }, NOTE_LIFETIME_MS);
}

export const mouseNotifyState = {
  notes: notes as readonly MouseNote[],
  /** Last known pointer position (client px), non-reactive. */
  pointer: (): { x: number; y: number } => ({ x: pointer.x, y: pointer.y })
};

installPointerTracking();
