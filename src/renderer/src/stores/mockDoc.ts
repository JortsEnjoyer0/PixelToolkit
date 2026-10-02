// In-memory DocHandle for the testbed and node tests (no disk IO): the real handle (stores/doc/handle.ts), so its
// undo, dirty and freeze rules are the app's, with a serial IO queue that only runs the ops it is given.
import { animJsonRel } from '@shared/dataPaths';
import { createAnimationMeta, type AnimationMeta } from '../core/model';
import type { DocHandle } from './types';
import { createDocHandle } from './doc/handle';

export interface MockDocOptions {
  name?: string;
  /** Character dir, default "Mock Character". */
  charRel?: string;
  undoLimit?: number;
}

export function createMockDoc(meta: Partial<AnimationMeta> = {}, opts: MockDocOptions = {}): DocHandle {
  const full: AnimationMeta = { ...createAnimationMeta(), ...meta };
  const rel = animJsonRel(opts.charRel ?? 'Mock Character', opts.name ?? 'Mock Animation');
  return createDocHandle(full, rel, { undoLimit: opts.undoLimit, onIoCount: () => undefined, onEvict: () => undefined });
}
